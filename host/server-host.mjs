// LLP server/edge host (SPEC section 10): the same Live Host core, headless, for the work a client
// is the wrong place for: shared multi-user data, secrets and payments, heavy compute.
//
// - It subscribes to the publisher's signed manifest stream like any host, verifies the whole
//   manifest, and runs only the slots placed on "server" (or "any").
// - It relays the stream to clients, but only after it has committed a version itself
//   ("server commits first"), so a client never runs code whose server half doesn't exist yet.
// - It holds no signing key. A relay can't forge or alter code: clients verify the signature and
//   every blob's hash themselves.
// - Each app is a tenant with its own state, its own layer workers and its own limits.
// - Release channels (10.5): each channel of an app is a lane with its own release and its own server
//   workers, over the tenant's one store. Clients say their channel in hello and get only that lane's
//   releases. Older releases stay served while a partial rollout leaves clients on them.
// - Privacy (section 14): a person's data, found by the manifest's personal prefixes, can be exported
//   or erased, with an audit log. With a data key, everything it saves is encrypted at rest.
import { createHmac, createHash, timingSafeEqual } from "node:crypto";
import { WebSocketServer } from "ws";
import { LiveHost, Store, sha256, b64, canonical, verifyManifest, keyRules, privatePrefixes, personalPrefixes, ownerOf, placement } from "./llp-core.js";
import { DiskStore, verifyAudit } from "./server-store.mjs";
import { FleetAgent, TrustStore, generateDeviceKey } from "./fleet.js";

// Server layers work on bigger data than a phone's UI layer, so the defaults are looser. All are
// per layer worker, so one tenant can't take another's budget.
export const SERVER_LIMITS = { callMs: 1000, loadMs: 5000, memoryMb: 128, heapMb: 512 };
const MAX_HOPS = 8;          // capability round trips one remote call may take
const MAX_ARGS = 64 * 1024;  // bytes of args per call
const IDEM_KEEP = 10000;     // remembered call ids per tenant, for exactly-once retries
const MAX_CLIENT_MESSAGE = 1024 * 1024; // bytes per WebSocket message from a client
const MAX_LANES = 32;        // channels per tenant
const validChannel = (c) => c === null || (typeof c === "string" && c.length > 0 && c.length <= 64);

export class RemoteError extends Error {
  constructor(code, message, extra = {}) { super(message); this.code = code; Object.assign(this, extra); }
}

// ---------- auth: which user is calling ----------
// Reference scheme: an HMAC-signed token naming the user, the app and an expiry. Any function with
// the same shape (token, app) => user | null can replace it (OIDC, sessions...).
export function tokenAuth(secret) {
  const mac = (s) => createHmac("sha256", secret).update(s).digest("base64url");
  return {
    issue(user, app, ttlMs = 3600_000) {
      const body = Buffer.from(JSON.stringify({ u: user, a: app, e: Date.now() + ttlMs })).toString("base64url");
      return `${body}.${mac(body)}`;
    },
    authenticate(token, app) {
      if (typeof token !== "string") return null;
      const [body, sig] = token.split(".");
      if (!body || !sig) return null;
      const want = Buffer.from(mac(body)), got = Buffer.from(sig);
      if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
      try { const t = JSON.parse(Buffer.from(body, "base64url").toString()); return t.a === app && t.e > Date.now() && typeof t.u === "string" ? t.u : null; }
      catch { return null; }
    },
  };
}

// ---------- one channel's Live Host (a lane), with the overlap window ----------
export class ServerLiveHost extends LiveHost {
  // revertAfterUsers / revertWindowMs (CO-01): one user's failing call restarts the worker on the
  // same version; the slot is reverted for everyone only when that many different users' calls
  // fail on the current version within the window.
  // lock: one queue shared by every lane of a tenant, so calls on different channels can't interleave
  // their reads and writes of the one store.
  constructor({ windowMs = 30000, idleMs = 120000, revertAfterUsers = 3, revertWindowMs = 60000, lock = null, channel = null, ...opts } = {}) {
    super({ ...opts, role: "server", limits: { ...SERVER_LIMITS, ...opts.limits } });
    this.windowMs = windowMs;
    this.channel = channel;
    this.lock = lock ?? { queue: Promise.resolve(), pending: 0 };
    this.revertAfterUsers = revertAfterUsers; this.revertWindowMs = revertWindowMs;
    this.failures = new Map(); // `${slot}@${hash}` -> { since, users: Set }
    // A worker costs ~10 MB, so idle tenants' workers are stopped and restarted on their next call.
    this.idleMs = idleMs;
    if (idleMs > 0) { this.sweeper = setInterval(() => this.evictIdle(), Math.max(50, idleMs / 4)); this.sweeper.unref?.(); }
    // version -> { layers: {slot: hash} placed here, until: ms (Infinity = pinned), manifest, sig }
    this.served = new Map();
    this.retired = new Map();  // `${slot}@${hash}` -> box of an older release, reloaded on demand
  }
  exclusive(fn) {
    const L = this.lock;
    L.pending++;
    const r = L.queue.then(fn).finally(() => { L.pending--; });
    L.queue = r.catch(() => {});
    return r;
  }
  get pending() { return this.lock?.pending ?? 0; }
  set pending(_) {} // LiveHost's own counter is replaced by the shared lock's

  // Keep the previous version's workers so clients that haven't swapped yet keep working (10.3 rule 2).
  retire(slot, cur) {
    if (this.windowMs <= 0) return cur.box.kill();
    const key = `${slot}@${cur.hash}`;
    const old = this.retired.get(key);
    if (old && old !== cur.box) old.kill();
    this.retired.set(key, cur.box);
  }
  committed(prev, next) {
    const now = Date.now();
    // A signed "overlap" (ms) shortens the window for this release; 0 retires older code at once (CO-02),
    // e.g. when the release fixes a security bug in the server half.
    const win = Number.isSafeInteger(next.overlap) && next.overlap >= 0 ? Math.min(next.overlap, this.windowMs) : this.windowMs;
    const layers = {};
    for (const [slot, h] of Object.entries(next.layers)) if (this.placedHere(next, slot)) layers[slot] = h;
    // A partial rollout leaves clients outside the share on older releases, so every release still
    // in use stays pinned until the channel's release reaches 100% (10.5).
    const partial = (next.rollout?.percent ?? 100) < 100;
    for (const [v, s] of this.served) {
      if (v === next.version || s.until < now) continue;
      if (win === 0) s.until = now - 1;
      else if (!partial && s.until === Infinity) s.until = now + win;
    }
    this.served.set(next.version, { layers, until: Infinity, manifest: next, sig: this.pendingSig ?? null });
    this.sweepServed();
  }
  // A share change: the same release, re-signed with another percent.
  reshared(manifest, sig) {
    this.manifest = manifest;
    const cur = this.served.get(manifest.version);
    if (cur) { cur.manifest = manifest; cur.sig = sig; }
    if ((manifest.rollout?.percent ?? 100) >= 100) {
      const now = Date.now(), win = this.windowMs;
      for (const [v, s] of this.served) if (v !== manifest.version && s.until === Infinity) s.until = now + win;
      this.sweepServed();
    }
  }
  // Drop releases whose window closed, stop their workers, and wake again when the next one closes.
  sweepServed(now = Date.now()) {
    for (const [v, s] of this.served) if (v !== this.version && s.until < now) this.served.delete(v);
    const live = new Set();
    for (const s of this.served.values()) for (const [slot, h] of Object.entries(s.layers)) live.add(`${slot}@${h}`);
    for (const [k, box] of this.retired) if (!live.has(k)) { box.kill(); this.retired.delete(k); }
    clearTimeout(this.sweepTimer);
    let next = Infinity;
    for (const [v, s] of this.served) if (v !== this.version) next = Math.min(next, s.until);
    if (next < Infinity) { this.sweepTimer = setTimeout(() => this.sweepServed(), Math.max(1, next - now + 1)); this.sweepTimer.unref?.(); }
  }
  // Releases older than the current one that are still pinned for clients outside a partial share.
  pinned() { return [...this.served].filter(([v, s]) => v !== this.version && s.until === Infinity && s.sig).map(([, s]) => ({ manifest: s.manifest, sig: s.sig })); }

  evictIdle(now = Date.now()) {
    if (this.pending) return 0;
    let n = 0;
    for (const [slot, s] of this.slots) if (!s.box.dead && now - (s.box.used ??= now) >= this.idleMs) { s.box.die("idle"); s.evicted = true; n++; }
    for (const box of this.retired.values()) if (!box.dead && now - (box.used ??= now) >= this.idleMs) { box.die("idle"); n++; }
    if (n) this.log("evict", `stopped ${n} idle layer worker(s)`);
    return n;
  }
  async wake(slot) {
    const s = this.slots.get(slot);
    if (s?.evicted && s.box.dead) { s.box = await this.load(slot, s.hash); s.evicted = false; this.log("wake", `${slot} restarted after idling`, { slot }); }
  }
  close() { clearInterval(this.sweeper); clearTimeout(this.sweepTimer); for (const b of this.retired.values()) b.kill(); super.close(); }

  async failed(slot, user, err) {
    const s = this.slots.get(slot);
    if (!s) return;
    const key = `${slot}@${s.hash}`, now = Date.now();
    let f = this.failures.get(key);
    if (!f || now - f.since > this.revertWindowMs) this.failures.set(key, f = { since: now, users: new Set() });
    f.users.add(user);
    if (f.users.size >= this.revertAfterUsers) {
      this.failures.delete(key);
      this.log("error", `${slot}: calls by ${f.users.size} different users failed on ${s.hash.slice(0, 8)} within ${this.revertWindowMs} ms; reverting`, { slot });
      return this.revert(slot, err);
    }
    s.box.kill();
    try { s.box = await this.load(slot, s.hash); } catch { return this.revert(slot, err); }
    this.log("error", `${slot}: a call by ${user} failed (${err.message}); worker restarted on the same version (${f.users.size} of ${this.revertAfterUsers} users before a revert)`, { slot });
  }

  // Which worker answers a call made by a client running `version` on this lane's channel.
  async resolve(slot, version) {
    if (version === this.version) {
      await this.wake(slot);
      const cur = this.slots.get(slot);
      if (!cur) throw new RemoteError("not_found", `no server slot "${slot}" in v${version}`);
      return cur.box;
    }
    const v = this.served.get(version);
    if (!v || v.until < Date.now()) throw new RemoteError("version_mismatch", `server runs v${this.version}; v${version} is outside the overlap window`, { serverVersion: this.version });
    const hash = v.layers[slot];
    if (!hash) throw new RemoteError("not_found", `no server slot "${slot}" in v${version}`);
    const cur = this.slots.get(slot);
    if (cur?.hash === hash) { await this.wake(slot); return cur.box; }
    const key = `${slot}@${hash}`;
    let box = this.retired.get(key);
    if (!box || box.dead) {
      // Stopped for idling (or after a failed call): start it again, with that release's key rules.
      if (!this.blobs.has(hash)) throw new RemoteError("version_mismatch", `v${version} of "${slot}" is no longer running`, { serverVersion: this.version });
      box = await this.load(slot, hash, keyRules(v.manifest)?.get(slot) ?? null);
      this.retired.set(key, box);
    }
    return box;
  }

  // A remote call: run op on a server slot as `user`. Each hop (the call, then one per capability
  // result) is its own transaction. Capabilities run outside the tenant's queue, so a slow payment
  // API doesn't hold up other calls.
  // callKey: the call's idempotency key (user:idem), when the client sent one. Each outside effect of
  // the call then gets a stable id (callKey#hop.n): providers receive it as ctx.callId to deduplicate,
  // and with an effectLog the effect is recorded as pending before it runs and done after (ST-03), so a
  // retried call reuses a finished effect's result instead of running it again.
  async invoke(slot, op, user, args, version, callKey = null) {
    const events = [{ id: op, value: `${user}\n${args}` }];
    let reply = "";
    for (let hop = 0; events.length; hop++) {
      if (hop >= MAX_HOPS) throw new RemoteError("layer_failed", `more than ${MAX_HOPS} capability round trips`);
      const ev = events.shift();
      const r = await this.exclusive(async () => {
        const box = await this.resolve(slot, version);
        box.used = Date.now();
        const current = this.slots.get(slot)?.box === box;
        let res;
        try { res = await this.call(slot, box, "llp_event", this.kv, ev, [], { apply: false }); }
        catch (e) { if (current) await this.failed(slot, user, e); else box.kill(); throw new RemoteError("layer_failed", e.message); }
        let reply, error;
        for (const [k, v] of res.writes) {
          if (k === "__reply") reply = String(v);
          else if (k === "__error") error = String(v);
          else this.kv.set(k, v);
        }
        return { reply, error, effects: res.effects };
      });
      if (r.error !== undefined) throw new RemoteError("app_error", r.error);
      if (r.reply !== undefined) reply = r.reply;
      for (let i = 0; i < r.effects.length; i++) {
        const fx = r.effects[i];
        const impl = this.capabilities[fx.name];
        const callId = callKey ? `${callKey}#${hop}.${i}` : null;
        const seen = callId ? this.effectLog?.get(callId) : null;
        let result;
        if (!this.capAllowed(slot, fx.name)) { result = "error: not granted"; this.log("cap", `capability "${fx.name}" is not declared for ${slot} in this release; refused`, { slot }); }
        else if (!impl) result = "error: not granted";
        else if (seen?.state === "done" && seen.name === fx.name) { result = seen.result; this.log("cap", `${fx.name} for ${callId} already ran; reusing its recorded result`, { slot }); }
        else {
          if (seen?.state === "pending") this.log("cap", `${fx.name} for ${callId} was started before a crash; running it again with the same callId so the provider can deduplicate`, { slot });
          if (callId) this.effectLog?.pending(callId, fx.name);
          try { result = String(await impl(fx.arg, { slot, app: this.app, user, callId })); } catch (e) { result = "error: " + e.message; }
          if (callId) this.effectLog?.done(callId, fx.name, result);
        }
        events.push({ id: `cap:${fx.name}`, value: result });
      }
    }
    return reply;
  }
}

// ---------- the server host: tenants, upstream, clients ----------
export class ServerHost {
  // dataDir: keep every tenant's state, idempotency records and current releases on disk, so a
  // restart loses nothing (ST-02). Without it, state lives in memory only and a warning is logged.
  // fsync (default true): flush each commit to the disk before replying; false survives a process
  // crash but not a power loss.
  // dataKey / previousDataKeys (PR-03): encrypt everything saved in dataDir (see host/at-rest.mjs;
  // dataKeyFrom() reads a key from an env var, a file or a keystore command).
  // canRead(user, key, app) => boolean: optional extra read rule for shared/ keys (PR-01), applied
  // on top of the manifest's private prefixes.
  // fleet: { keyring, id } to follow a fleet controller (joinFleet). keyring is the pinned keyring;
  // a newer accepted one, and the device key, are kept in dataDir (encrypted with a data key).
  // selfService (PR-02): let a signed-in user export or erase their own data over the client link.
  constructor({ trustedKeys = [], capabilities = {}, authenticate, windowMs = 30000, idleMs = 120000, limits = {}, maxPending = 256, onLog = () => {}, dataDir = null, fsync = true, compactEvery = 1000, revertAfterUsers = 3, revertWindowMs = 60000, canRead = null, dataKey = null, previousDataKeys = [], fleet = null, selfService = false } = {}) {
    if (!authenticate) throw new Error("server host needs an authenticate(token, app) function");
    Object.assign(this, { trustedKeys, capabilities, authenticate, windowMs, idleMs, limits, maxPending, onLog, revertAfterUsers, revertWindowMs, canRead, selfService });
    this.tenants = new Map();
    this.upstreams = [];
    this.maxEpoch = 0;
    this.disk = dataDir ? new DiskStore(dataDir, { fsync, compactEvery, idemKeep: IDEM_KEEP, key: dataKey, previousKeys: previousDataKeys }) : null;
    if (!this.disk) onLog({ kind: "warn", msg: "no dataDir: shared state and idempotency records are kept in memory only and are lost on restart" });
    else if (this.disk.migrated) onLog({ kind: "security", msg: `data dir ${this.disk.migrated} at rest with the data key` });
    else if (!this.disk.encrypted) onLog({ kind: "warn", msg: "dataDir is not encrypted at rest; pass dataKey to encrypt it (PR-03)" });
    if (dataKey && !dataDir) onLog({ kind: "warn", msg: "dataKey without dataDir does nothing: nothing is saved" });
    if (fleet) {
      if (!fleet.keyring || !fleet.id) throw new Error("fleet needs { keyring, id }");
      const saved = this.disk?.readDoc("fleet/keyring.json", "llp/fleet/keyring.json");
      this.trust = new TrustStore(saved && saved.app === fleet.keyring.app && saved.keyring > fleet.keyring.keyring ? saved : fleet.keyring);
      this.fleetId = fleet.id;
      this.chain = this.disk?.readDoc("fleet/chain.json", "llp/fleet/chain.json") ?? []; // keyrings to relay to clients behind this host
      this.trustedKeys = this.trust.releaseKeys();
      this.maxEpoch = this.trust.version;
    }
    this.ready = this.disk ? this.restore() : Promise.resolve([]);
  }

  // Bring back every tenant that was on disk: saved state first, then each channel's release, re-verified.
  // Channels are restored newest first, so a channel whose server data another channel migrated finds
  // that channel already running (10.5).
  async restore() {
    const out = [];
    const fetchSaved = async (h) => { if (!this.disk.hasBlob(h)) throw new Error(`missing blob ${h.slice(0, 8)}`); return this.disk.getBlob(h); };
    for (const app of this.disk.apps()) {
      const t = this.tenant(app);
      const lanes = [...t.log.releases()].sort((a, b) => (b[1].manifest.epoch ?? 0) - (a[1].manifest.epoch ?? 0) || b[1].manifest.version - a[1].manifest.version);
      for (const [channel, cur] of lanes) {
        const lane = this.lane(t, channel);
        if (!lane) continue;
        lane.pendingSig = cur.sig;
        const r = await lane.apply(cur.manifest, cur.sig, fetchSaved);
        lane.pendingSig = null;
        if (r.ok) {
          t.releases.set(channel, { manifest: cur.manifest, sig: cur.sig });
          for (const h of Object.values(cur.manifest.layers)) if (this.disk.hasBlob(h)) t.blobs.set(h, this.disk.getBlob(h));
          // Older releases still pinned by a partial rollout: re-verified, served again, started on first use.
          for (const p of cur.pinned ?? []) {
            if (!(p.manifest?.version < cur.manifest.version) || p.manifest.app !== app || (p.manifest.channel ?? null) !== channel) continue;
            if (!(await this.verifies(p.manifest, p.sig))) { this.onLog({ app, channel, kind: "error", msg: `pinned v${p.manifest.version} failed its signature check; not served` }); continue; }
            const layers = {};
            for (const [slot, h] of Object.entries(p.manifest.layers)) if (lane.placedHere(p.manifest, slot) && this.disk.hasBlob(h)) { layers[slot] = h; t.blobs.set(h, this.disk.getBlob(h)); }
            lane.served.set(p.manifest.version, { layers, until: Infinity, manifest: p.manifest, sig: p.sig });
          }
        }
        // A release that didn't restore is kept on disk as it was (for the operator to look at) until
        // that channel commits a new one; it is never relayed.
        if (!r.ok) t.unrestored.set(channel, cur);
        this.onLog({ app, channel, kind: r.ok ? "restore" : "error", msg: r.ok ? `restored v${cur.manifest.version}${channel ? ` on ${channel}` : ""} with ${t.kv.size} keys` : `could not restore: ${r.reason}` });
        out.push({ app, channel, ...r });
      }
    }
    return out;
  }
  async verifies(manifest, sig) {
    for (const k of this.trustedKeys ?? []) if (await verifyManifest(manifest, sig, k).catch(() => false)) return true;
    return false;
  }

  recordEffect(t, id, rec) {
    t.effects.set(id, rec);
    if (t.effects.size > IDEM_KEEP) t.effects.delete(t.effects.keys().next().value);
    t.log?.append({ fx: [[id, rec]] }); // on disk before the effect runs (pending) and before the reply (done)
  }

  // Write everything changed since the last commit, with the given idempotency records, in one line.
  persist(t, idem = []) {
    // Settled call results are kept in memory too (exportUser reads them), on disk with dataDir.
    for (const [k, r] of idem) { t.idemSaved.set(k, r); if (t.idemSaved.size > IDEM_KEEP) t.idemSaved.delete(t.idemSaved.keys().next().value); }
    if (!t.log) return;
    const set = [], del = [];
    for (const k of t.unsaved) t.kv.has(k) ? set.push([k, t.kv.get(k)]) : del.push(k);
    t.unsaved.clear();
    t.log.append({ set, del, idem });
    if (t.log.needsCompaction()) t.log.compact(t.kv, t.idemSaved, t.effects, t.tombs);
  }
  saveReleases(t) {
    if (!t.log) return;
    const map = new Map(t.unrestored);
    for (const [ch, cur] of t.releases) map.set(ch, { ...cur, pinned: t.lanes.get(ch)?.pinned() ?? [] });
    t.log.writeReleases(map);
  }

  tenant(app) {
    let t = this.tenants.get(app);
    if (t) return t;
    t = {
      app, kv: new Store(), blobs: new Map(), lock: { queue: Promise.resolve(), pending: 0 }, lanes: new Map(), releases: new Map(), unrestored: new Map(),
      clients: new Set(), idem: new Map(), tombs: new Set(), pending: 0, dirty: new Set(), unsaved: new Set(), idemSaved: new Map(), effects: new Map(), log: null,
      // The no-channel lane, or the first one: what single-channel code (and older callers) mean by "the host".
      get host() { return this.lanes.get(null) ?? this.lanes.values().next().value ?? this.server.lane(this, null); },
    };
    Object.defineProperty(t, "server", { value: this, enumerable: false });
    if (this.disk) {
      t.log = this.disk.tenant(app);
      const saved = t.log.load();
      t.kv = new Store(saved.kv);
      t.idemSaved = saved.idem;
      t.effects = saved.fx;
      t.tombs = saved.tombs;
      for (const [k, r] of saved.idem) t.idem.set(k, Promise.resolve(r));
    }
    // Outside effects of calls, recorded before they run and after (ST-03). Durable with dataDir.
    t.effectLog = {
      get: (id) => t.effects.get(id),
      pending: (id, name) => this.recordEffect(t, id, { state: "pending", name }),
      done: (id, name, result) => this.recordEffect(t, id, { state: "done", name, result }),
    };
    t.kv.onChange = (k) => { if (k.startsWith("shared/")) t.dirty.add(k); if (t.log) t.unsaved.add(k); };
    this.tenants.set(app, t);
    return t;
  }

  // One channel's lane of a tenant: its own release and server workers over the tenant's one store.
  lane(t, channel = null) {
    let lane = t.lanes.get(channel);
    if (lane) return lane;
    if (!validChannel(channel) || t.lanes.size >= MAX_LANES) return null;
    lane = new ServerLiveHost({
      app: t.app, channel, lock: t.lock,
      trustedKeys: this.trustedKeys, windowMs: this.windowMs, idleMs: this.idleMs, limits: this.limits, revertAfterUsers: this.revertAfterUsers, revertWindowMs: this.revertWindowMs,
      // Providers get the tenant name so secrets can be scoped per app; layers only see results.
      capabilities: Object.fromEntries(Object.entries(this.capabilities).map(([n, f]) => [n, (arg, ctx) => f(arg, { ...ctx, app: t.app, channel })])),
      onLog: (e) => { this.onLog({ app: t.app, ...(channel !== null ? { channel } : {}), ...e }); this.agents?.get(channel)?.adapter.onLog?.(e); },
    });
    lane.maxEpoch = this.maxEpoch;
    lane.kv = t.kv;
    lane.blobs = t.blobs;
    lane.effectLog = t.effectLog;
    // Data another channel migrated: this lane's older code joins it rather than migrating back.
    lane.siblingSchema = (slot, schema) => [...t.lanes.values()].some((l) => l !== lane && l.slots.get(slot)?.box?.schema === schema);
    t.lanes.set(channel, lane);
    return lane;
  }

  // A manifest from the publisher. Server commits first; only then do clients hear about it.
  async offer(manifest, sig, fetchBlob) {
    const fail = (reason) => ({ ok: false, reason, version: manifest?.version });
    if (!manifest || typeof manifest !== "object" || typeof manifest.app !== "string") return fail("malformed manifest");
    const channel = manifest.channel ?? null;
    if (!validChannel(channel)) return fail("channel must be a string of 1 to 64 characters");
    const t = this.tenant(manifest.app);
    const host = this.lane(t, channel);
    if (!host) return fail(`more than ${MAX_LANES} channels for one app`);
    // Hold every blob (client slots too) so clients can fetch them here. Content addressing means
    // the relay can't change them: clients check each hash.
    if (host.compareVersion(manifest) > 0) {
      for (const h of new Set(Object.values(manifest.layers ?? {}))) {
        if (host.blobs.has(h)) continue;
        const bytes = await fetchBlob(h);
        if (!bytes || bytes.byteLength > host.limits.blobMb * 2 ** 20) return host.reject(manifest, `blob ${h.slice(0, 8)} is missing or over the ${host.limits.blobMb} MB limit`);
        if ((await sha256(bytes)) !== h) return host.reject(manifest, `blob ${h.slice(0, 8)} failed integrity check`);
        host.blobs.set(h, bytes);
        this.disk?.putBlob(h, bytes);
      }
    }
    host.pendingSig = sig;
    const r = await host.apply(manifest, sig, fetchBlob);
    host.pendingSig = null;
    if (!r.ok) return r; // clients stay on the version the server still serves
    t.releases.set(channel, { manifest, sig });
    this.persist(t);                   // a migration's writes are on disk before the release is
    this.saveReleases(t);
    this.flush(t);       // shared/ keys written by a migration reach clients before the new code
    this.relay(t, channel, manifest, sig);
    return r;
  }

  // A re-signed release of the version a lane already runs (a share change): checked, then relayed.
  async reshare(manifest, sig) {
    const t = this.tenants.get(manifest?.app), channel = manifest?.channel ?? null;
    const lane = t?.lanes.get(channel);
    if (!lane?.manifest) return { ok: false, reason: "no release on this channel to re-share" };
    if (!(await this.verifies(manifest, sig))) return { ok: false, reason: "signature not trusted" };
    const strip = ({ rollout, ...m }) => canonical(m);
    if (strip(manifest) !== strip(lane.manifest)) return { ok: false, reason: "a re-signed release may change only its rollout share" };
    lane.reshared(manifest, sig);
    t.releases.set(channel, { manifest, sig });
    this.saveReleases(t);
    this.relay(t, channel, manifest, sig);
    return { ok: true, version: manifest.version };
  }

  relay(t, channel, manifest, sig) {
    // New read rules: every client's mirror on this channel is rebuilt, so keys it may no longer read are dropped.
    const sent = t.privateSent ??= new Map();
    if (JSON.stringify(manifest.private ?? []) !== JSON.stringify(sent.get(channel) ?? [])) {
      sent.set(channel, manifest.private ?? []);
      for (const c of t.clients) if (c.channel === channel) send(c.ws, { t: "shared", full: true, set: [...t.kv].filter(([k]) => watched(c, k)) });
    }
    for (const c of t.clients) if (c.channel === channel) send(c.ws, { t: "manifest", manifest, sig });
  }

  // Follow a publisher's stream (same wire protocol as any host).
  subscribe(url, app) {
    const pending = new Map();
    let ws, closed = false;
    const open = async () => {
      await this.ready;
      ws = new WebSocket(url);
      const host = this.tenant(app).host;
      ws.onopen = () => send(ws, { t: "hello", app, version: host.version, have: [...host.blobs.keys()] });
      ws.onmessage = async (ev) => {
        const m = JSON.parse(ev.data);
        if (m.t === "blob") pending.get(m.hash)?.(b64.dec(m.data));
        if (m.t === "manifest") {
          const r = await this.offer(m.manifest, m.sig, (h) => new Promise((res) => { pending.set(h, res); send(ws, { t: "want", hashes: [h] }); }));
          send(ws, r.ok ? { t: "ack", version: r.version, ms: r.ms, host: "server" } : { t: "nack", version: r.version, reason: r.reason, host: "server" });
        }
      };
      ws.onclose = () => { if (!closed) setTimeout(open, 500); };
      ws.onerror = () => {};
    };
    open();
    const sub = { close: () => { closed = true; ws?.close(); } };
    this.upstreams.push(sub);
    return sub;
  }

  // ---------- following a fleet controller (SPEC 10.5, 12) ----------
  // One fleet connection per channel, each a FleetAgent in relay mode with the id `<id>/<channel>`,
  // all sharing this host's keyring and device key. The controller sees the server host as one host
  // per channel; it applies every share, and its clients decide whether they are in it.
  async joinFleet(url, channels, { freshness = null, WebSocketImpl = globalThis.WebSocket, retryMs = 500 } = {}) {
    if (!this.trust) throw new Error("create the ServerHost with fleet: { keyring, id } first");
    await this.ready;
    this.deviceKey ??= await this.loadDeviceKey();
    this.agents ??= new Map();
    const out = [];
    for (const channel of channels) {
      if (this.agents.has(channel)) continue;
      const t = this.tenant(this.trust.app);
      const server = this, laneOf = () => server.lane(t, channel);
      const adapter = {
        get version() { return laneOf().version; },
        get epoch() { return laneOf().epoch; },
        get blobs() { return t.blobs; },
        get app() { return server.trust.app; }, set app(_) {},
        get trustedKeys() { return server.trustedKeys; },
        set trustedKeys(keys) { server.trustedKeys = keys; for (const x of server.tenants.values()) for (const l of x.lanes.values()) l.trustedKeys = keys; },
        get maxEpoch() { return server.maxEpoch; },
        set maxEpoch(e) { server.maxEpoch = e; for (const x of server.tenants.values()) for (const l of x.lanes.values()) l.maxEpoch = e; },
        compareVersion: (m) => laneOf().compareVersion(m),
        running: () => laneOf().running(),
        apply: (m, sig, fetchBlob) => server.offer(m, sig, fetchBlob),
        resigned: (m, sig) => server.reshare(m, sig),
        onLog: null,
      };
      let ws, closed = false;
      // All channels share one keyring. Each agent gets a view of it where the keyring another channel's
      // agent already accepted counts as accepted (the store itself refuses a replayed keyring, 12.4).
      const trust = Object.create(this.trust);
      trust.update = (doc, sigs) => doc?.keyring === this.trust.version && canonical(doc) === canonical(this.trust.doc) ? Promise.resolve({ ok: true, keyring: doc.keyring, same: true }) : this.trust.update(doc, sigs);
      const agent = new FleetAgent({ host: adapter, id: `${this.fleetId}/${channel}`, channel, trust, deviceKey: this.deviceKey, freshness, relay: true, send: (m) => ws?.readyState === 1 && ws.send(JSON.stringify(m)) });
      const entry = { agent, adapter, close: () => { closed = true; ws?.close(); } };
      this.agents.set(channel, entry);
      const connect = () => {
        ws = new WebSocketImpl(url);
        ws.onopen = () => agent.connected();
        ws.onmessage = async (ev) => {
          const m = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
          const r = await agent.receive(m);
          if (m.t === "keyring" && r?.ok && !r.same) this.keyringAccepted(m);
        };
        ws.onclose = () => { if (!closed) setTimeout(connect, retryMs); };
        ws.onerror = () => {};
      };
      connect();
      this.upstreams.push(entry);
      out.push(agent);
    }
    return out;
  }
  async loadDeviceKey() {
    const ECDSA = { name: "ECDSA", namedCurve: "P-256" };
    const saved = this.disk?.readDoc("fleet/device.json", "llp/fleet/device.json");
    if (saved) return { privateKey: await crypto.subtle.importKey("jwk", saved.private, ECDSA, true, ["sign"]), publicJwk: saved.public };
    const k = await generateDeviceKey();
    this.disk?.writeDoc("fleet/device.json", "llp/fleet/device.json", { private: await crypto.subtle.exportKey("jwk", k.privateKey), public: k.publicJwk });
    if (!this.disk) this.onLog({ kind: "warn", msg: "no dataDir: the fleet device key and keyring are not kept across restarts" });
    return k;
  }
  // A keyring this host accepted: kept (so a restart can't fall back to a revoked key, FL-02) and
  // relayed to every client behind this host, which checks it against its own trusted root.
  keyringAccepted({ doc, sigs }) {
    this.chain = [...this.chain.filter((k) => k.doc.keyring < doc.keyring), { doc, sigs }];
    this.disk?.writeDoc("fleet/keyring.json", "llp/fleet/keyring.json", this.trust.doc);
    this.disk?.writeDoc("fleet/chain.json", "llp/fleet/chain.json", this.chain);
    for (const t of this.tenants.values()) for (const c of t.clients) send(c.ws, { t: "keyring", doc, sigs });
  }

  // Accept client hosts.
  async listen(port = 0) {
    await this.ready; // clients never see a tenant before its saved state is back
    this.wss = new WebSocketServer({ port, maxPayload: MAX_CLIENT_MESSAGE }); // SEC-06: a call's args are capped at 64 KB anyway
    this.wss.on("connection", (ws) => {
      // Messages after a hello wait for it (auth may be async), so a reconnecting client can send
      // hello and its queued calls back to back. Calls don't wait for each other.
      const c = { ws, user: null, app: null, channel: null, version: 0, ready: Promise.resolve() };
      ws.on("error", () => {}); // e.g. a message over maxPayload: ws closes the socket (1009); don't crash the host
      ws.on("message", (raw) => {
        let m;
        try { m = JSON.parse(raw); } catch { return send(ws, { t: "error", code: "bad_request", message: "not JSON" }); }
        const run = () => this.onClient(c, m).catch((e) => this.onLog({ kind: "error", msg: e.message }));
        if (m?.t === "hello") c.ready = c.ready.then(run); else c.ready.then(run);
      });
      ws.on("close", () => this.tenants.get(c.app)?.clients.delete(c));
    });
    return new Promise((res) => this.wss.on("listening", () => res(this.wss.address().port)));
  }

  async onClient(c, m) {
    if (!m || typeof m !== "object") return send(c.ws, { t: "error", code: "bad_request", message: "expected an object" });
    if (m.t === "hello") {
      const user = typeof m.app === "string" ? await this.authenticate(m.token, m.app) : null;
      if (!user) { send(c.ws, { t: "error", code: "unauthorized", message: "bad or expired token" }); return c.ws.close(); }
      const channel = m.channel ?? null;
      if (!validChannel(channel)) { send(c.ws, { t: "error", code: "bad_request", message: "channel must be a string of 1 to 64 characters" }); return c.ws.close(); }
      const t = this.tenant(m.app);
      this.tenants.get(c.app)?.clients.delete(c);
      // watch: the shared/ prefixes this client mirrors (default: all of shared/). A big store
      // can't be mirrored on every phone, so clients can narrow it.
      const watch = Array.isArray(m.watch) && m.watch.length ? m.watch.filter((p) => typeof p === "string" && p.startsWith("shared/")).slice(0, 64) : ["shared/"];
      Object.assign(c, { user, app: m.app, channel, version: +m.version || 0, watch, canRead: readerFor(t, channel, user, this.canRead) });
      t.clients.add(c);
      // Keyrings this client is missing come first, so it can verify releases signed by a newer key.
      if (this.chain && m.app === this.trust.app) for (const k of this.chain) if (k.doc.keyring > (+m.keyring || 0)) send(c.ws, { t: "keyring", ...k });
      const set = [...t.kv].filter(([k]) => watched(c, k));
      send(c.ws, { t: "shared", full: true, set });
      const cur = t.releases.get(channel);
      const lane = t.lanes.get(channel), ce = +m.epoch || 0;
      if (cur && lane && (lane.epoch > ce || (lane.epoch === ce && lane.version > c.version))) send(c.ws, { t: "manifest", ...cur });
      return;
    }
    if (!c.user) return send(c.ws, m.t === "call" ? reply(m.id, new RemoteError("unauthorized", "say hello with a token first")) : { t: "error", code: "unauthorized", message: "say hello with a token first" });
    const t = this.tenants.get(c.app);
    if (m.t === "want") { for (const h of m.hashes ?? []) if (t.blobs.has(h)) send(c.ws, { t: "blob", hash: h, data: b64.enc(t.blobs.get(h)) }); return; }
    if (m.t === "ack") { c.version = m.version; c.ackMs = m.ms; c.skipped = null; if (m.running && typeof m.running === "object") c.running = m.running; return; }
    if (m.t === "skip") { c.skipped = m.version; return; } // outside a partial share: stays on its version
    if (m.t === "nack") { this.onLog({ app: c.app, kind: "client-nack", msg: `${c.user} can't run v${m.version}: ${m.reason}` }); return; }
    if (m.t === "call") {
      const r = await this.call(t, c.user, m, c.channel);
      return send(c.ws, r);
    }
    if (m.t === "privacy") {
      if (!this.selfService) return send(c.ws, { t: "privacy", id: m.id, ok: false, error: { code: "unavailable", message: "this server doesn't offer self-service export or erase" } });
      try {
        if (m.op === "export") return send(c.ws, { t: "privacy", id: m.id, ok: true, value: await this.exportUser(c.app, c.user, { by: `self:${c.user}` }) });
        if (m.op === "erase") return send(c.ws, { t: "privacy", id: m.id, ok: true, value: await this.eraseUser(c.app, c.user, { by: `self:${c.user}` }) });
        return send(c.ws, { t: "privacy", id: m.id, ok: false, error: { code: "bad_request", message: 'op is "export" or "erase"' } });
      } catch (e) { return send(c.ws, { t: "privacy", id: m.id, ok: false, error: { code: "unavailable", message: e.message } }); }
    }
  }

  // One remote call, with validation, back-pressure and exactly-once retries.
  async call(t, user, m, channel = null) {
    const { id, slot, op, args = "", version, idem } = m;
    if (typeof slot !== "string" || typeof op !== "string" || typeof args !== "string" || !Number.isFinite(version) || slot.length > 64 || op.length > 64 || args.length > MAX_ARGS)
      return reply(id, new RemoteError("bad_request", "call needs string slot, op, args (≤ 64 KB) and a numeric version"));
    const lane = t.lanes.get(channel);
    if (!lane) return reply(id, new RemoteError("not_found", `no release on channel ${channel ?? "(none)"}`));
    const key = typeof idem === "string" && idem ? `${user}:${idem}` : null;
    if (key && t.idem.has(key)) return reply(id, await t.idem.get(key));
    // The record of this call was erased with the user's data (section 14): never run it a second time.
    if (key && t.tombs.size && t.tombs.has(tomb(key))) return reply(id, new RemoteError("erased", "this call's record was erased with the user's data; it is not run again"));
    if (t.pending >= this.maxPending) return reply(id, new RemoteError("overloaded", `${t.pending} calls already queued for this app`));
    t.pending++;
    const run = lane.invoke(slot, op, user, args, version, key).then((value) => ({ value }), (e) => e instanceof RemoteError ? e : new RemoteError("layer_failed", e.message));
    // Only calls that ran are remembered; a version_mismatch never ran, so the retry must run.
    if (key) { t.idem.set(key, run.then((r) => { if (r.code === "version_mismatch" || r.code === "overloaded") t.idem.delete(key); return r; })); if (t.idem.size > IDEM_KEEP) t.idem.delete(t.idem.keys().next().value); }
    const r = await run;
    t.pending--;
    // Durable before the reply: the call's writes and its idempotency record land in one log line.
    const plain = r.code ? { code: r.code, message: r.message, ...(r.serverVersion ? { serverVersion: r.serverVersion } : {}) } : { value: r.value };
    try { this.persist(t, key && r.code !== "version_mismatch" && r.code !== "overloaded" ? [[key, plain]] : []); }
    catch (e) { this.onLog({ app: t.app, kind: "error", msg: `could not save state: ${e.message}` }); return reply(id, new RemoteError("unavailable", "the server could not save this call's result; retry with the same id")); }
    this.flush(t);
    return reply(id, r);
  }

  // Push changed shared/ keys to every client of the tenant (their read cache).
  flush(t) {
    if (!t.dirty.size) return;
    const set = [], del = [];
    for (const k of t.dirty) t.kv.has(k) ? set.push([k, t.kv.get(k)]) : del.push(k);
    t.dirty.clear();
    for (const c of t.clients) {
      const s = set.filter(([k]) => watched(c, k)), d = del.filter((k) => watched(c, k));
      if (s.length || d.length) send(c.ws, { t: "shared", set: s, del: d });
    }
  }

  // Which clients run what, per channel: { channel: { version: count, skipped: count } }.
  clientStatus(app) {
    const out = {};
    for (const c of this.tenants.get(app)?.clients ?? []) {
      const ch = (out[c.channel ?? ""] ??= { versions: {}, skipped: 0 });
      ch.versions[c.version] = (ch.versions[c.version] ?? 0) + 1;
      if (c.skipped) ch.skipped++;
    }
    return out;
  }

  // ---------- privacy: a person's data (PR-02, SPEC section 14) ----------
  // The personal prefixes in force: from every release this tenant serves (all channels, pinned ones
  // too), plus private prefixes, which name their reader the same way.
  personalPrefixes(t) {
    const all = new Set();
    for (const lane of t.lanes.values()) for (const s of [lane.manifest, ...[...lane.served.values()].map((x) => x.manifest)]) {
      if (!s) continue;
      for (const p of personalPrefixes(s)) all.add(p);
      for (const p of privatePrefixes(s)) all.add(p);
    }
    return [...all];
  }
  // Everything the server holds about `user` in `app`: keys under personal prefixes whose owner segment
  // is the user, the results of their calls (idempotency records) and the outside effects of those
  // calls. Runs in the tenant's queue, so it's a consistent snapshot. Recorded in the audit log.
  async exportUser(app, user, { by = "operator" } = {}) {
    if (typeof user !== "string" || !user || user.includes("/")) throw new Error("user must be a non-empty id without /");
    const t = this.tenants.get(app);
    if (!t) throw new Error(`no app ${app}`);
    return t.host.exclusive(() => {
      const prefixes = this.personalPrefixes(t);
      const keys = {};
      for (const [k, v] of t.kv) if (ownerOf(k, prefixes) === user) keys[k] = v;
      const mine = (id) => id.startsWith(`${user}:`);
      const calls = [...t.idemSaved].filter(([k]) => mine(k)).map(([k, r]) => ({ id: k.slice(user.length + 1), result: r }));
      const effects = [...t.effects].filter(([k]) => mine(k)).map(([k, r]) => ({ callId: k, ...r }));
      const at = new Date().toISOString();
      this.audit(t, { at, op: "export", user, by, keys: Object.keys(keys).length, calls: calls.length, effects: effects.length });
      return { kind: "llp-export", app, user, at, prefixes, keys, calls, effects,
        notice: "Data a layer wrote outside these personal prefixes (for example the person's name inside a shared list) is not included." };
    });
  }
  // Delete everything exportUser would return. The tenant's log is replaced by a fresh snapshot, so no
  // deleted value stays in the log on disk. Clients mirroring those keys get them deleted, and the
  // person's own connected clients are told, so they can clear what they keep on the device.
  async eraseUser(app, user, { by = "operator" } = {}) {
    if (typeof user !== "string" || !user || user.includes("/")) throw new Error("user must be a non-empty id without /");
    const t = this.tenants.get(app);
    if (!t) throw new Error(`no app ${app}`);
    const r = await t.host.exclusive(() => {
      const prefixes = this.personalPrefixes(t);
      let keys = 0, calls = 0, effects = 0;
      for (const k of [...t.kv.keys()]) if (ownerOf(k, prefixes) === user) { t.kv.delete(k); keys++; }
      const mine = (id) => id.startsWith(`${user}:`);
      // A retried call must not run again once its record is gone, so each erased call id leaves a
      // tombstone: a hash of user:idem. It names no one outright; with connectServer the idem part is a
      // random UUID, so the user id can't be guessed back from it.
      for (const k of [...t.idemSaved.keys()]) if (mine(k)) { t.idemSaved.delete(k); t.tombs.add(tomb(k)); calls++; }
      for (const k of [...t.idem.keys()]) if (mine(k)) { t.idem.delete(k); t.tombs.add(tomb(k)); }
      while (t.tombs.size > IDEM_KEEP) t.tombs.delete(t.tombs.values().next().value);
      for (const k of [...t.effects.keys()]) if (mine(k)) { t.effects.delete(k); effects++; }
      if (t.log) { t.unsaved.clear(); t.log.compact(t.kv, t.idemSaved, t.effects, t.tombs); }
      const at = new Date().toISOString();
      this.audit(t, { at, op: "erase", user, by, keys, calls, effects });
      return { kind: "llp-erase", app, user, at, keys, calls, effects };
    });
    this.flush(t);
    for (const c of t.clients) if (c.user === user) send(c.ws, { t: "erased", app, at: r.at });
    return r;
  }
  audit(t, entry) {
    (t.auditMem ??= []).push(entry);
    t.log?.audit(entry);
    this.onLog({ app: t.app, kind: "audit", msg: `${entry.op} for a user by ${entry.by}: ${entry.keys} keys, ${entry.calls} call records, ${entry.effects} effects` });
  }
  // The audit log, oldest first, with a check that no line was removed or changed.
  auditLog(app) {
    const t = this.tenants.get(app);
    const entries = t?.log ? t.log.auditEntries() : t?.auditMem ?? [];
    return { entries, ...(t?.log ? verifyAudit(entries) : { ok: true }) };
  }

  close() {
    for (const u of this.upstreams) u.close();
    for (const t of this.tenants.values()) for (const l of t.lanes.values()) l.close();
    this.wss?.close();
    for (const c of this.wss?.clients ?? []) c.terminate();
  }
}

const tomb = (key) => createHash("sha256").update("llp-erased\n" + key).digest("base64url").slice(0, 22);
const watched = (c, k) => c.watch.some((p) => k.startsWith(p)) && c.canRead(k);
// Who may read a shared/ key (PR-01): keys under a private prefix of the client's channel's release
// belong to the user named by the next path segment; the operator's canRead hook can narrow access further.
function readerFor(t, channel, user, hook) {
  return (k) => {
    for (const p of t.lanes.get(channel)?.manifest?.private ?? []) if (k.startsWith(p) && k.slice(p.length).split("/")[0] !== user) return false;
    return hook ? hook(user, k, t.app) === true : true;
  };
}
function send(ws, m) { if (ws.readyState === 1) ws.send(JSON.stringify(m)); }
function reply(id, r) {
  if (r && r.code) return { t: "reply", id, ok: false, error: { code: r.code, message: r.message, ...(r.serverVersion ? { serverVersion: r.serverVersion } : {}) } };
  return { t: "reply", id, ok: true, value: r.value };
}
export { placement };
