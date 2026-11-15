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
import { createHmac, timingSafeEqual } from "node:crypto";
import { WebSocketServer } from "ws";
import { LiveHost, sha256, b64 } from "./llp-core.js";
import { DiskStore } from "./server-store.mjs";

// Server layers work on bigger data than a phone's UI layer, so the defaults are looser. All are
// per layer worker, so one tenant can't take another's budget.
export const SERVER_LIMITS = { callMs: 1000, loadMs: 5000, memoryMb: 128, heapMb: 512 };
const MAX_HOPS = 8;          // capability round trips one remote call may take
const MAX_ARGS = 64 * 1024;  // bytes of args per call
const IDEM_KEEP = 10000;
const MAX_CLIENT_MESSAGE = 1024 * 1024; // bytes per WebSocket message from a client     // remembered call ids per tenant, for exactly-once retries

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

// ---------- one tenant's Live Host, with the overlap window ----------
export class ServerLiveHost extends LiveHost {
  // revertAfterUsers / revertWindowMs (CO-01): one user's failing call restarts the worker on the
  // same version; the slot is reverted for everyone only when that many different users' calls
  // fail on the current version within the window.
  constructor({ windowMs = 30000, idleMs = 120000, revertAfterUsers = 3, revertWindowMs = 60000, ...opts } = {}) {
    super({ ...opts, role: "server", limits: { ...SERVER_LIMITS, ...opts.limits } });
    this.windowMs = windowMs;
    this.revertAfterUsers = revertAfterUsers; this.revertWindowMs = revertWindowMs;
    this.failures = new Map(); // `${slot}@${hash}` -> { since, users: Set }
    // A worker costs ~10 MB, so idle tenants' workers are stopped and restarted on their next call.
    this.idleMs = idleMs;
    if (idleMs > 0) { this.sweeper = setInterval(() => this.evictIdle(), Math.max(50, idleMs / 4)); this.sweeper.unref?.(); }
    this.served = new Map();   // version -> { layers: {slot: hash} placed here, until: ms }
    this.retired = new Map();  // `${slot}@${hash}` -> box, kept alive for the window
  }
  // Keep the previous version's workers running for windowMs, so clients that haven't swapped yet
  // keep working (SPEC 10.3 rule 2).
  retire(slot, cur) {
    if (this.windowMs <= 0) return cur.box.kill();
    const key = `${slot}@${cur.hash}`;
    this.retired.get(key)?.kill();
    this.retired.set(key, cur.box);
    const t = setTimeout(() => { if (this.retired.get(key) === cur.box) { this.retired.delete(key); cur.box.kill(); } }, this.windowMs);
    t.unref?.();
  }
  committed(prev, next) {
    const now = Date.now();
    if (prev && this.served.has(prev.version)) this.served.get(prev.version).until = now + this.windowMs;
    const layers = {};
    for (const [slot, h] of Object.entries(next.layers)) if (this.placedHere(next, slot)) layers[slot] = h;
    this.served.set(next.version, { layers, until: Infinity });
    for (const [v, s] of this.served) if (s.until < now) this.served.delete(v);
  }

  evictIdle(now = Date.now()) {
    if (this.pending) return 0;
    let n = 0;
    for (const [slot, s] of this.slots) if (!s.box.dead && now - (s.box.used ??= now) >= this.idleMs) { s.box.die("idle"); s.evicted = true; n++; }
    if (n) this.log("evict", `stopped ${n} idle layer worker(s)`);
    return n;
  }
  async wake(slot) {
    const s = this.slots.get(slot);
    if (s?.evicted && s.box.dead) { s.box = await this.load(slot, s.hash); s.evicted = false; this.log("wake", `${slot} restarted after idling`, { slot }); }
  }
  close() { clearInterval(this.sweeper); super.close(); }

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

  // Which worker answers a call made by a client running `version`.
  resolve(slot, version) {
    if (version === this.version) {
      const cur = this.slots.get(slot);
      if (!cur) throw new RemoteError("not_found", `no server slot "${slot}" in v${version}`);
      return cur.box;
    }
    const v = this.served.get(version);
    if (!v || v.until < Date.now()) throw new RemoteError("version_mismatch", `server runs v${this.version}; v${version} is outside the overlap window`, { serverVersion: this.version });
    const hash = v.layers[slot];
    if (!hash) throw new RemoteError("not_found", `no server slot "${slot}" in v${version}`);
    const cur = this.slots.get(slot);
    if (cur?.hash === hash) return cur.box;
    const box = this.retired.get(`${slot}@${hash}`);
    if (!box || box.dead) throw new RemoteError("version_mismatch", `v${version} of "${slot}" is no longer running`, { serverVersion: this.version });
    return box;
  }

  // A remote call: run op on a server slot as `user`. Each hop (the call, then one per capability
  // result) is its own transaction. Capabilities run outside the tenant's queue, so a slow payment
  // API doesn't hold up other calls.
  async invoke(slot, op, user, args, version) {
    const events = [{ id: op, value: `${user}\n${args}` }];
    let reply = "";
    for (let hop = 0; events.length; hop++) {
      if (hop >= MAX_HOPS) throw new RemoteError("layer_failed", `more than ${MAX_HOPS} capability round trips`);
      const ev = events.shift();
      const r = await this.exclusive(async () => {
        if (version === this.version) await this.wake(slot);
        const box = this.resolve(slot, version);
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
      for (const fx of r.effects) {
        const impl = this.capabilities[fx.name];
        let result;
        if (!impl) result = "error: not granted";
        else try { result = String(await impl(fx.arg, { slot, app: this.app, user })); } catch (e) { result = "error: " + e.message; }
        events.push({ id: `cap:${fx.name}`, value: result });
      }
    }
    return reply;
  }
}

// ---------- the server host: tenants, upstream, clients ----------
export class ServerHost {
  // dataDir: keep every tenant's state, idempotency records and current release on disk, so a
  // restart loses nothing (ST-02). Without it, state lives in memory only and a warning is logged.
  // fsync (default true): flush each commit to the disk before replying; false survives a process
  // crash but not a power loss.
  constructor({ trustedKeys, capabilities = {}, authenticate, windowMs = 30000, idleMs = 120000, limits = {}, maxPending = 256, onLog = () => {}, dataDir = null, fsync = true, compactEvery = 1000, revertAfterUsers = 3, revertWindowMs = 60000 } = {}) {
    if (!authenticate) throw new Error("server host needs an authenticate(token, app) function");
    Object.assign(this, { trustedKeys, capabilities, authenticate, windowMs, idleMs, limits, maxPending, onLog, revertAfterUsers, revertWindowMs });
    this.tenants = new Map();
    this.upstreams = [];
    this.disk = dataDir ? new DiskStore(dataDir, { fsync, compactEvery, idemKeep: IDEM_KEEP }) : null;
    if (!this.disk) onLog({ kind: "warn", msg: "no dataDir: shared state and idempotency records are kept in memory only and are lost on restart" });
    this.ready = this.disk ? this.restore() : Promise.resolve([]);
  }

  // Bring back every tenant that was on disk: saved state first, then its last release, re-verified.
  async restore() {
    const out = [];
    for (const app of this.disk.apps()) {
      const t = this.tenant(app);
      const cur = t.log.current();
      if (!cur) continue;
      const r = await t.host.apply(cur.manifest, cur.sig, async (h) => { if (!this.disk.hasBlob(h)) throw new Error(`missing blob ${h.slice(0, 8)}`); return this.disk.getBlob(h); });
      if (r.ok) { t.current = cur; for (const h of Object.values(cur.manifest.layers)) if (this.disk.hasBlob(h)) t.host.blobs.set(h, this.disk.getBlob(h)); }
      this.onLog({ app, kind: r.ok ? "restore" : "error", msg: r.ok ? `restored v${cur.manifest.version} with ${t.host.kv.size} keys` : `could not restore: ${r.reason}` });
      out.push({ app, ...r });
    }
    return out;
  }

  // Write everything changed since the last commit, with the given idempotency records, in one line.
  persist(t, idem = []) {
    if (!t.log) return;
    const set = [], del = [];
    for (const k of t.unsaved) t.host.kv.has(k) ? set.push([k, t.host.kv.get(k)]) : del.push(k);
    t.unsaved.clear();
    for (const [k, r] of idem) { t.idemSaved.set(k, r); if (t.idemSaved.size > IDEM_KEEP) t.idemSaved.delete(t.idemSaved.keys().next().value); }
    t.log.append({ set, del, idem });
    if (t.log.needsCompaction()) t.log.compact(t.host.kv, t.idemSaved);
  }

  tenant(app) {
    let t = this.tenants.get(app);
    if (t) return t;
    const host = new ServerLiveHost({
      app,
      trustedKeys: this.trustedKeys, windowMs: this.windowMs, idleMs: this.idleMs, limits: this.limits, revertAfterUsers: this.revertAfterUsers, revertWindowMs: this.revertWindowMs,
      // Providers get the tenant name so secrets can be scoped per app; layers only see results.
      capabilities: Object.fromEntries(Object.entries(this.capabilities).map(([n, f]) => [n, (arg, ctx) => f(arg, { ...ctx, app })])),
      onLog: (e) => this.onLog({ app, ...e }),
    });
    t = { app, host, clients: new Set(), current: null, idem: new Map(), pending: 0, dirty: new Set(), unsaved: new Set(), idemSaved: new Map(), log: null };
    if (this.disk) {
      t.log = this.disk.tenant(app);
      const saved = t.log.load();
      host.kv = saved.kv;
      t.idemSaved = saved.idem;
      for (const [k, r] of saved.idem) t.idem.set(k, Promise.resolve(r));
    }
    host.kv.onChange = (k) => { if (k.startsWith("shared/")) t.dirty.add(k); if (t.log) t.unsaved.add(k); };
    this.tenants.set(app, t);
    return t;
  }

  // A manifest from the publisher. Server commits first; only then do clients hear about it.
  async offer(manifest, sig, fetchBlob) {
    const t = this.tenant(manifest.app);
    const { host } = t;
    // Hold every blob (client slots too) so clients can fetch them here. Content addressing means
    // the relay can't change them: clients check each hash.
    if (host.compareVersion(manifest) > 0) {
      for (const h of new Set(Object.values(manifest.layers))) {
        if (host.blobs.has(h)) continue;
        const bytes = await fetchBlob(h);
        if (!bytes || bytes.byteLength > host.limits.blobMb * 2 ** 20) return host.reject(manifest, `blob ${h.slice(0, 8)} is missing or over the ${host.limits.blobMb} MB limit`);
        if ((await sha256(bytes)) !== h) return host.reject(manifest, `blob ${h.slice(0, 8)} failed integrity check`);
        host.blobs.set(h, bytes);
        this.disk?.putBlob(h, bytes);
      }
    }
    const r = await host.apply(manifest, sig, fetchBlob);
    if (!r.ok) return r; // clients stay on the version the server still serves
    t.current = { manifest, sig };
    this.persist(t);                   // a migration's writes are on disk before the release is
    t.log?.setCurrent(manifest, sig);
    this.flush(t);       // shared/ keys written by a migration reach clients before the new code
    for (const c of t.clients) send(c.ws, { t: "manifest", manifest, sig });
    return r;
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

  // Accept client hosts.
  async listen(port = 0) {
    await this.ready; // clients never see a tenant before its saved state is back
    this.wss = new WebSocketServer({ port, maxPayload: MAX_CLIENT_MESSAGE }); // SEC-06: a call's args are capped at 64 KB anyway
    this.wss.on("connection", (ws) => {
      // Messages after a hello wait for it (auth may be async), so a reconnecting client can send
      // hello and its queued calls back to back. Calls don't wait for each other.
      const c = { ws, user: null, app: null, version: 0, ready: Promise.resolve() };
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
      const t = this.tenant(m.app);
      this.tenants.get(c.app)?.clients.delete(c);
      // watch: the shared/ prefixes this client mirrors (default: all of shared/). A big store
      // can't be mirrored on every phone, so clients can narrow it.
      const watch = Array.isArray(m.watch) && m.watch.length ? m.watch.filter((p) => typeof p === "string" && p.startsWith("shared/")).slice(0, 64) : ["shared/"];
      Object.assign(c, { user, app: m.app, version: +m.version || 0, watch });
      t.clients.add(c);
      const set = [...t.host.kv].filter(([k]) => watched(c, k));
      send(c.ws, { t: "shared", full: true, set });
      if (t.current && t.current.manifest.version > c.version) send(c.ws, { t: "manifest", ...t.current });
      return;
    }
    if (!c.user) return send(c.ws, m.t === "call" ? reply(m.id, new RemoteError("unauthorized", "say hello with a token first")) : { t: "error", code: "unauthorized", message: "say hello with a token first" });
    const t = this.tenants.get(c.app);
    if (m.t === "want") { for (const h of m.hashes ?? []) if (t.host.blobs.has(h)) send(c.ws, { t: "blob", hash: h, data: b64.enc(t.host.blobs.get(h)) }); return; }
    if (m.t === "ack") { c.version = m.version; c.ackMs = m.ms; return; }
    if (m.t === "nack") { this.onLog({ app: c.app, kind: "client-nack", msg: `${c.user} can't run v${m.version}: ${m.reason}` }); return; }
    if (m.t === "call") {
      const r = await this.call(t, c.user, m);
      return send(c.ws, r);
    }
  }

  // One remote call, with validation, back-pressure and exactly-once retries.
  async call(t, user, m) {
    const { id, slot, op, args = "", version, idem } = m;
    if (typeof slot !== "string" || typeof op !== "string" || typeof args !== "string" || !Number.isFinite(version) || slot.length > 64 || op.length > 64 || args.length > MAX_ARGS)
      return reply(id, new RemoteError("bad_request", "call needs string slot, op, args (≤ 64 KB) and a numeric version"));
    const key = typeof idem === "string" && idem ? `${user}:${idem}` : null;
    if (key && t.idem.has(key)) return reply(id, await t.idem.get(key));
    if (t.pending >= this.maxPending) return reply(id, new RemoteError("overloaded", `${t.pending} calls already queued for this app`));
    t.pending++;
    const run = t.host.invoke(slot, op, user, args, version).then((value) => ({ value }), (e) => e instanceof RemoteError ? e : new RemoteError("layer_failed", e.message));
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
    for (const k of t.dirty) t.host.kv.has(k) ? set.push([k, t.host.kv.get(k)]) : del.push(k);
    t.dirty.clear();
    for (const c of t.clients) {
      const s = set.filter(([k]) => watched(c, k)), d = del.filter((k) => watched(c, k));
      if (s.length || d.length) send(c.ws, { t: "shared", set: s, del: d });
    }
  }

  close() {
    for (const u of this.upstreams) u.close();
    for (const t of this.tenants.values()) { t.host.close(); for (const b of t.host.retired.values()) b.kill(); }
    this.wss?.close();
    for (const c of this.wss?.clients ?? []) c.terminate();
  }
}

const watched = (c, k) => c.watch.some((p) => k.startsWith(p));
function send(ws, m) { if (ws.readyState === 1) ws.send(JSON.stringify(m)); }
function reply(id, r) {
  if (r && r.code) return { t: "reply", id, ok: false, error: { code: r.code, message: r.message, ...(r.serverVersion ? { serverVersion: r.serverVersion } : {}) } };
  return { t: "reply", id, ok: true, value: r.value };
}
