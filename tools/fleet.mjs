// LLP fleet controller: the publisher side of release channels, percentage rollouts, convergence
// tracking and key rotation. The host side is host/fleet.js.
//
// As a library:  const fleet = await FleetController.create({ app }); serve(fleet, { port });
// As a CLI:      node tools/fleet.mjs --port 7720 [--keys keys/fleet]
//   stdin:  publish <channel> <percent> slot=file.wasm ...  |  percent <channel> <p>  |  rollback <channel>
//           rollout <channel> <p1,p2,...> slot=file ...     |  rotate [root-dir]  |  status [channel]
// A new controller writes its root keys once to --root-out (default <keys>-root): move them offline.
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { sha256, signManifest, generatePublisherKey, b64 } from "../host/llp-core.js";
import { signDoc, verifyDoc, bucketOf, rolloutSeed } from "../host/fleet.js";
import { canonical } from "../host/llp-core.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ECDSA = { name: "ECDSA", namedCurve: "P-256" };
const exportKey = async (k) => ({ private: await crypto.subtle.exportKey("jwk", k.privateKey), public: k.publicJwk });
const importKey = async (k) => ({ privateKey: await crypto.subtle.importKey("jwk", k.private, ECDSA, true, ["sign"]), publicJwk: k.public });

export class FleetController {
  // rootKeys: [{privateKey, publicJwk}] (offline in production; pass them to rotate* instead of keeping them here)
  // enrollment: how a host id gets its device key (RT-03).
  //   "tofu" (default): the first key that proves itself for an id is bound to it for good;
  //                     a later connection with another key is refused.
  //   "closed":         only ids registered with enroll(id, publicJwk) may join.
  // freshnessTtlMs (SEC-01): how long a signed "latest is version N" note stays valid. Hosts that set
  // a freshness limit treat a host without a valid note as stale (TUF's timestamp role).
  constructor({ app, rootKeys = [], keyrings, releaseKey, version = Date.now(), onEvent = () => {}, enrollment = "tofu", devices = {}, freshnessTtlMs = 24 * 3600_000 }) {
    Object.assign(this, { app, rootKeys, keyrings, releaseKey, version, onEvent, enrollment, freshnessTtlMs });
    this.notes = new Map();     // channel -> { doc, sig } current freshness note
    this.blobs = new Map();     // hash -> bytes
    this.channels = new Map();  // name -> { current: {manifest, sig}, history: [{version, layers, order}] }
    this.hosts = new Map();     // id -> record from hello/status
    this.devices = new Map(Object.entries(devices)); // host id -> device public key (JWK)
    this.stats = new Map();     // channel -> running counts (RT-06): convergence() is O(1), not O(hosts)
    this.members = new Map();   // channel -> Set of host records
    this.waiters = new Set();
    this.onEnroll = () => {};
    this.lost = new Map();      // host id -> last record, for hosts retired by sweepOffline
    this.lostCount = new Map(); // channel -> number of lost hosts
  }

  static async create({ app, roots = 1, threshold = 1, version, ...opts } = {}) {
    const rootKeys = []; for (let i = 0; i < roots; i++) rootKeys.push(await generatePublisherKey());
    const releaseKey = await generatePublisherKey();
    const doc = { app, keyring: 1, root: { keys: rootKeys.map((k) => k.publicJwk), threshold }, release: { keys: [releaseKey.publicJwk] } };
    const fleet = new FleetController({ app, rootKeys, releaseKey, keyrings: [], version, ...opts });
    fleet.keyrings.push({ doc, sigs: await fleet.signKeyring(doc, rootKeys.slice(0, threshold)) });
    return fleet;
  }

  // What a new host is installed with (it pins the current keyring).
  get keyring() { return this.keyrings[this.keyrings.length - 1].doc; }
  async signKeyring(doc, signers) { const out = []; for (const k of signers) out.push(await signDoc(doc, k.privateKey, k.publicJwk)); return out; }

  async addBlob(bytes) { const h = await sha256(bytes); this.blobs.set(h, bytes); return h; }

  // ---------- releases ----------
  channel(name) { if (!this.channels.has(name)) this.channels.set(name, { current: null, history: [] }); return this.channels.get(name); }

  // fields: other signed manifest fields to carry (hosts, keys, caps, private, personal, overlap, llp,
  // x-*), e.g. { hosts: { sync: "server" } } for a release with a server half (SPEC 10.5).
  async publish(channel, layers, { order, percent = 100, seed, fields = {} } = {}) {
    for (const h of Object.values(layers)) if (!this.blobs.has(h)) throw new Error(`blob ${h.slice(0, 8)} was never added`);
    for (const k of ["app", "channel", "epoch", "version", "layers", "order", "rollout"]) if (k in fields) throw new Error(`fields can't set ${k}`);
    // epoch = the keyring that signs it: a key rotation starts a new epoch, so one bad version from a
    // leaked key can be outranked by rotating (RT-02).
    const manifest = { ...fields, app: this.app, channel, epoch: this.keyring.keyring, version: ++this.version, layers, order: order ?? Object.keys(layers) };
    if (percent < 100) manifest.rollout = { percent, seed: seed ?? `${this.app}/${channel}` };
    const ch = this.channel(channel);
    ch.history.push({ version: manifest.version, layers, order: manifest.order, fields });
    await this.sign(channel, manifest);
    this.onEvent({ kind: "publish", channel, version: manifest.version, percent });
    return manifest.version;
  }

  // Widen (or narrow, for hosts that haven't swapped yet) the share of a release: same version, re-signed.
  async setPercent(channel, percent) {
    const cur = this.channel(channel).current;
    if (!cur) throw new Error(`nothing published on ${channel}`);
    const manifest = { ...cur.manifest, rollout: { percent, seed: rolloutSeed(cur.manifest) } };
    await this.sign(channel, manifest);
    this.onEvent({ kind: "percent", channel, version: manifest.version, percent });
  }

  // Rollback is a new version that points at the previous release's hashes (SPEC 10.3.4).
  async rollback(channel) {
    const h = this.channel(channel).history;
    if (h.length < 2) throw new Error(`no earlier release on ${channel}`);
    const prev = h[h.length - 2];
    const v = await this.publish(channel, prev.layers, { order: prev.order, fields: prev.fields });
    this.onEvent({ kind: "rollback", channel, version: v, to: prev.version });
    return v;
  }

  async sign(channel, manifest) {
    const ch = this.channel(channel);
    ch.current = { manifest, sig: await signManifest(manifest, this.releaseKey.privateKey) };
    this.recount(channel); // the target changed, so every host's class on this channel may have changed
    const n = await this.note(channel); // the note first, so a host that requires one can install the release
    for (const host of this.members.get(channel) ?? []) if (host.online) { host.send({ t: "fresh", ...n }); host.send({ t: "manifest", ...ch.current }); }
  }

  // ---------- freshness (SEC-01) ----------
  // A short-lived note, signed by the release key: "on this channel, the latest release is (epoch, version),
  // valid until expires". A relay can withhold releases but can't forge or extend a note.
  async note(channel, { force = false } = {}) {
    const cur = this.channels.get(channel)?.current?.manifest;
    const have = this.notes.get(channel), now = Date.now();
    if (!force && have && have.doc.version === (cur?.version ?? 0) && have.doc.epoch === (cur?.epoch ?? 0) && have.doc.expires - now > this.freshnessTtlMs / 2) return have;
    const doc = { kind: "llp-freshness", app: this.app, channel, epoch: cur?.epoch ?? 0, version: cur?.version ?? 0, issued: now, expires: now + this.freshnessTtlMs };
    const n = { doc, sig: await signManifest(doc, this.releaseKey.privateKey) };
    this.notes.set(channel, n);
    return n;
  }
  async refreshNote(channel, opts) {
    const n = await this.note(channel, opts);
    for (const host of this.members.get(channel) ?? []) if (host.online) host.send({ t: "fresh", ...n });
  }
  // Re-issue every channel's note on a timer, so online hosts never hold an expired one.
  startFreshness(everyMs = this.freshnessTtlMs / 3) {
    this.stopFreshness();
    this.freshTimer = setInterval(() => { for (const ch of this.channels.keys()) this.refreshNote(ch, { force: true }).catch(() => {}); }, everyMs);
    this.freshTimer.unref?.();
  }
  stopFreshness() { clearInterval(this.freshTimer); this.freshTimer = null; }

  // ---------- key rotation ----------
  // New release key: keyring n+1 lists only the new key, signed by the root. Every host gets the
  // keyring first, then every channel's current manifest re-signed with the new key. The old key
  // is revoked the moment a host accepts the keyring.
  async rotateReleaseKey({ rootSigners = this.rootKeys } = {}) {
    const need = this.keyring.root.threshold ?? 1;
    if (rootSigners.length < need) throw new Error(`rotation needs ${need} root key(s) and has ${rootSigners.length}; load them from offline storage (SEC-02)`);
    const releaseKey = await generatePublisherKey();
    const doc = { ...this.keyring, keyring: this.keyring.keyring + 1, release: { keys: [releaseKey.publicJwk] } };
    await this.pushKeyring(doc, await this.signKeyring(doc, rootSigners.slice(0, this.keyring.root.threshold ?? 1)));
    this.releaseKey = releaseKey;
    // Re-sign each channel's release in the new epoch, so hosts that took a (now revoked) key's
    // release with a higher version still move back to the real one.
    for (const [name, ch] of this.channels) if (ch.current) await this.sign(name, { ...ch.current.manifest, epoch: doc.keyring });
    return doc.keyring;
  }

  // New root: signed by a threshold of the old root and a threshold of the new one.
  async rotateRoot(newRootKeys, threshold = 1, { oldSigners = this.rootKeys } = {}) {
    const doc = { ...this.keyring, keyring: this.keyring.keyring + 1, root: { keys: newRootKeys.map((k) => k.publicJwk), threshold } };
    const sigs = [...await this.signKeyring(doc, oldSigners.slice(0, this.keyring.root.threshold ?? 1)), ...await this.signKeyring(doc, newRootKeys.slice(0, threshold))];
    await this.pushKeyring(doc, sigs);
    this.rootKeys = newRootKeys;
    return doc.keyring;
  }

  async pushKeyring(doc, sigs) {
    this.keyrings.push({ doc, sigs });
    for (const ch of this.members.keys()) this.recount(ch); // oldKeyring counts depend on the latest keyring
    for (const host of this.hosts.values()) if (host.online) host.send({ t: "keyring", doc, sigs });
    this.onEvent({ kind: "keyring", keyring: doc.keyring });
  }

  // ---------- hosts ----------
  // Register a host's device key ahead of time (required with enrollment "closed").
  enroll(id, publicJwk) { this.devices.set(id, publicJwk); this.onEnroll(id, publicJwk); }

  // One call per connection. `send` delivers a message to that host. Returns the connection's handlers.
  // A connection starts with a challenge; the host answers with a hello signed by its device key over
  // the challenge (so it can't be replayed on another connection). Until then the connection can't
  // change any host record or fetch blobs (RT-03).
  attach(send) {
    const conn = { send, rec: null, nonce: b64.enc(crypto.getRandomValues(new Uint8Array(18))), queue: Promise.resolve(), closed: false };
    send({ t: "challenge", nonce: conn.nonce });
    const handle = async (msg) => {
      if (conn.closed || !msg || typeof msg !== "object") return;
      if (msg.t === "hello") return this.hello(conn, msg);
      const rec = conn.rec;
      if (!rec) return send({ t: "error", code: "unauthorized", message: "answer the challenge with a signed hello first" });
      if (msg.t === "want") {
        for (const h of msg.hashes || []) if (this.blobs.has(h)) send({ t: "blob", hash: h, data: b64.enc(this.blobs.get(h)) });
      } else if (msg.t === "status" && msg.host === rec.id) {
        // Reports come only over a connection that proved it holds this host's device key.
        Object.assign(rec, { version: msg.version, keyring: msg.keyring, target: msg.target, percent: msg.percent, state: msg.state, reason: msg.reason, seen: Date.now() });
        if (msg.running && typeof msg.running === "object") rec.running = msg.running; // the hashes really running (OB-01)
        if (msg.state === "reverted") rec.reverted = msg.version;
        this.update(rec);
        this.onEvent({ kind: "status", ...msg });
        this.tick();
      }
    };
    return {
      // Messages on one connection are handled in order (a hello's signature check is async).
      message: (msg) => { const r = conn.queue.then(() => handle(msg)); conn.queue = r.catch(() => {}); return r; },
      close: () => {
        conn.closed = true;
        const rec = conn.rec;
        if (!rec) return;
        rec.conns.delete(conn);
        if (!rec.conns.size) { rec.online = false; rec.offlineSince = Date.now(); this.update(rec); this.tick(); }
      },
    };
  }

  async hello(conn, msg) {
    const refuse = (why) => { this.onEvent({ kind: "refused", host: msg.host, reason: why }); conn.send({ t: "error", code: "unauthorized", message: why }); };
    const id = msg.host, auth = msg.auth;
    if (typeof id !== "string" || !id || id.length > 256) return refuse("hello needs a host id");
    if (!auth?.key || typeof auth.sig !== "string") return refuse("hello must be signed with the host's device key");
    const known = this.devices.get(id);
    if (known && canonical(pubOf(known)) !== canonical(pubOf(auth.key))) return refuse(`host ${id} is enrolled with a different device key`);
    if (!known && this.enrollment !== "tofu") return refuse(`host ${id} is not enrolled`);
    const { auth: _, ...body } = msg;
    if (!(await verifyDoc({ ...body, nonce: conn.nonce }, auth.sig, auth.key))) return refuse("hello signature doesn't match the challenge");
    if (conn.closed) return;
    if (conn.rec && conn.rec.id !== id) return refuse("one connection speaks for one host");
    if (!known) this.enroll(id, pubOf(auth.key));
    const back = this.lost.get(id);
    if (back) { this.lost.delete(id); this.lostCount.set(back.channel, this.lostCount.get(back.channel) - 1); }
    const rec = this.hosts.get(id) ?? { id, conns: new Set(), send: (m) => { for (const c of rec.conns) c.send(m); } };
    rec.conns.add(conn);
    conn.rec = rec;
    Object.assign(rec, { channel: msg.channel, version: msg.version, keyring: msg.keyring, online: true, seen: Date.now() });
    this.hosts.set(id, rec);
    this.update(rec);
    for (const k of this.keyrings) if (k.doc.keyring > msg.keyring) conn.send({ t: "keyring", ...k });
    const cur = this.channels.get(msg.channel)?.current;
    if (cur) { const n = await this.note(msg.channel); if (!conn.closed) { conn.send({ t: "fresh", ...n }); conn.send({ t: "manifest", ...cur }); } }
    this.tick();
  }

  // Retire hosts that have been offline longer than maxOfflineMs (FL-03): they stop counting toward
  // "complete" and are listed in this.lost instead. A lost host that says hello again comes back.
  sweepOffline(maxOfflineMs, now = Date.now()) {
    let n = 0;
    for (const [id, rec] of this.hosts) {
      if (rec.online || !(now - (rec.offlineSince ?? rec.seen ?? now) > maxOfflineMs)) continue;
      if (rec.contrib) { this.contribute(rec, rec.contrib, -1); this.members.get(rec.contrib.channel)?.delete(rec); rec.contrib = null; }
      this.hosts.delete(id);
      this.lost.set(id, { channel: rec.channel, version: rec.version, since: rec.offlineSince });
      this.lostCount.set(rec.channel, (this.lostCount.get(rec.channel) ?? 0) + 1);
      n++;
    }
    if (n) { this.onEvent({ kind: "lost", hosts: n }); this.tick(); }
    return n;
  }

  // ---------- convergence ----------
  // Each host record contributes to its channel's running counts. A record is re-counted when it
  // changes (O(1) per report), and a whole channel only when its target release or the keyring
  // changes (RT-06: per-report cost no longer grows with the fleet).
  classify(h) {
    const cur = this.channels.get(h.channel)?.current?.manifest;
    const T = cur?.version, percent = cur?.rollout?.percent ?? 100;
    if (!h.online) return { cls: "offline" };
    const old = h.keyring < this.keyring.keyring;
    if (h.version === T && h.reverted === T) return { cls: "reverted", old };
    if (h.version === T && (h.state === "live" || h.state === "keyring")) return { cls: "live", old };
    if (h.target === T && h.state === "skipped" && h.percent === percent && percent < 100) return { cls: "skipped", old };
    if (h.target === T && h.state === "rejected") return { cls: "rejected", old, reason: h.reason };
    return { cls: "pending", old };
  }
  statsOf(channel) {
    let s = this.stats.get(channel);
    if (!s) this.stats.set(channel, s = { hosts: 0, online: 0, offline: 0, live: 0, skipped: 0, rejected: 0, reverted: 0, pending: 0, oldKeyring: 0, reasons: new Map(), pendingIds: new Set() });
    return s;
  }
  contribute(h, c, sign) {
    const s = this.statsOf(c.channel);
    s.hosts += sign;
    if (c.cls === "offline") { s.offline += sign; return; }
    s.online += sign;
    s[c.cls] += sign;
    if (c.old) s.oldKeyring += sign;
    if (c.cls === "rejected") { const n = (s.reasons.get(c.reason) ?? 0) + sign; n ? s.reasons.set(c.reason, n) : s.reasons.delete(c.reason); }
    if (c.cls === "pending") sign > 0 ? s.pendingIds.add(h.id) : s.pendingIds.delete(h.id);
  }
  update(h) {
    if (h.contrib) {
      this.contribute(h, h.contrib, -1);
      if (h.contrib.channel !== h.channel) this.members.get(h.contrib.channel)?.delete(h);
    }
    if (!this.members.has(h.channel)) this.members.set(h.channel, new Set());
    this.members.get(h.channel).add(h);
    h.contrib = { channel: h.channel, ...this.classify(h) };
    this.contribute(h, h.contrib, +1);
  }
  recount(channel) { for (const h of this.members.get(channel) ?? []) this.update(h); }

  convergence(channel) {
    const cur = this.channels.get(channel)?.current?.manifest;
    const T = cur?.version, percent = cur?.rollout?.percent ?? 100;
    const s = this.statsOf(channel);
    const laggards = [];
    for (const id of s.pendingIds) { if (laggards.length >= 10) break; laggards.push(id); }
    const r = { channel, version: T, percent, lost: this.lostCount.get(channel) ?? 0, hosts: s.hosts, online: s.online, live: s.live, skipped: s.skipped, rejected: s.rejected, reverted: s.reverted, pending: s.pending, offline: s.offline, oldKeyring: s.oldKeyring, reasons: Object.fromEntries(s.reasons), laggards };
    r.converged = !!T && r.online > 0 && r.pending === 0 && r.rejected === 0 && r.reverted === 0 && r.oldKeyring === 0 && (percent >= 100 ? r.skipped === 0 : true);
    // converged ignores offline hosts (a phone that's switched off shouldn't block a release). complete
    // doesn't: every host the controller has ever seen on this channel is on the target. Gate anything
    // that breaks on mixed versions (a flag flip, a schema change) on complete, not converged.
    r.complete = r.converged && r.offline === 0;
    return r;
  }
  // The exact hosts a share should reach, from the same bucket function the hosts use.
  async expectedShare(channel) {
    const m = this.channels.get(channel).current.manifest, p = m.rollout?.percent ?? 100, out = [];
    for (const h of this.hosts.values()) if (h.channel === channel && (p >= 100 || (await bucketOf(h.id, rolloutSeed(m))) < Math.round(p * 100))) out.push(h.id);
    return out;
  }

  tick() { for (const w of [...this.waiters]) if (w.test()) { this.waiters.delete(w); w.done(true); } }
  waitFor(test, timeoutMs = 10000) {
    if (test()) return Promise.resolve(true);
    return new Promise((res) => {
      const w = { test, done: (v) => { clearTimeout(t); res(v); } };
      const t = setTimeout(() => { this.waiters.delete(w); res(false); }, timeoutMs);
      this.waiters.add(w);
    });
  }
  waitForConvergence(channel, timeoutMs) { return this.waitFor(() => this.convergence(channel).converged, timeoutMs); }

  // ---------- staged rollout with health gates ----------
  // Publishes at steps[0]%, waits until every online host on the channel has reported, gives runtime
  // failures soakMs to surface (onStep can drive traffic), then checks the failure rate among hosts that
  // tried the release. Over maxFailRate: stop widening and roll the channel back. Otherwise widen.
  async rollout(channel, layers, { steps = [5, 25, 50, 100], maxFailRate = 0, soakMs = 0, timeoutMs = 10000, order, onStep } = {}) {
    const version = await this.publish(channel, layers, { order, percent: steps[0] });
    const log = [];
    for (let i = 0; i < steps.length; i++) {
      if (i > 0) await this.setPercent(channel, steps[i]);
      const reported = await this.waitFor(() => this.convergence(channel).pending === 0, timeoutMs);
      await onStep?.(steps[i], this.convergence(channel));
      if (soakMs) await sleep(soakMs);
      const c = this.convergence(channel);
      const failed = c.rejected + c.reverted, tried = c.live + failed;
      log.push({ percent: steps[i], live: c.live, skipped: c.skipped, failed, pending: c.pending, offline: c.offline });
      if (!reported || (tried && failed / tried > maxFailRate)) {
        const back = await this.rollback(channel);
        const ok = await this.waitForConvergence(channel, timeoutMs);
        return { ok: false, version, haltedAt: steps[i], reason: reported ? `${failed} of ${tried} hosts failed` : `hosts didn't report within ${timeoutMs} ms`, reasons: c.reasons, rolledBackTo: back, recovered: ok, steps: log };
      }
    }
    return { ok: true, version, steps: log, converged: await this.waitForConvergence(channel, timeoutMs) };
  }

  // ---------- persistence (CLI) ----------
  // Root keys are never written next to the release key (SEC-02). Pass rootDir to export them once,
  // to a location you then take offline; later rotations load them from there (or from several
  // people's files) only for the moment they sign.
  async save(dir, { rootDir = null } = {}) {
    mkdirSync(dir, { recursive: true });
    if (rootDir) { mkdirSync(rootDir, { recursive: true, mode: 0o700 }); writeSecret(join(rootDir, "root.json"), JSON.stringify(await Promise.all(this.rootKeys.map(exportKey)))); }
    writeSecret(join(dir, "release.json"), JSON.stringify(await exportKey(this.releaseKey)));
    writeFileSync(join(dir, "keyrings.json"), JSON.stringify(this.keyrings));
    writeFileSync(join(dir, "keyring.pinned.json"), JSON.stringify(this.keyring)); // ship this with hosts
    writeFileSync(join(dir, "devices.json"), JSON.stringify(Object.fromEntries(this.devices)));
  }
  static async loadRootKeys(rootDir) { return Promise.all(JSON.parse(readFileSync(join(rootDir, "root.json"), "utf8")).map(importKey)); }
  static async load(dir, opts = {}) {
    const keyrings = JSON.parse(readFileSync(join(dir, "keyrings.json"), "utf8"));
    // Old layout kept root keys here; load them so nothing breaks, but say so.
    const legacy = existsSync(join(dir, "root.json"));
    if (legacy) console.error(`warning: ${join(dir, "root.json")} holds root keys next to the release key; move it offline (SEC-02)`);
    const rootKeys = legacy ? await FleetController.loadRootKeys(dir) : [];
    const releaseKey = await importKey(JSON.parse(readFileSync(join(dir, "release.json"), "utf8")));
    const devices = existsSync(join(dir, "devices.json")) ? JSON.parse(readFileSync(join(dir, "devices.json"), "utf8")) : {};
    return new FleetController({ app: keyrings[0].doc.app, rootKeys, releaseKey, keyrings, devices, ...opts });
  }
}

function writeSecret(file, text) { writeFileSync(file + ".tmp", text, { mode: 0o600 }); renameSync(file + ".tmp", file); }
const pubOf = (jwk) => ({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });

// WebSocket transport. Returns the server.
// host: interface to listen on (default all, since fleet hosts are remote; hosts authenticate, RT-03).
export async function serve(fleet, { port = 7720, host, maxPayload = 1024 * 1024 } = {}) {
  const { WebSocketServer } = await import("ws");
  const wss = new WebSocketServer({ port, host, maxPayload }); // SEC-06: hosts only send small messages
  wss.on("connection", (ws) => {
    const conn = fleet.attach((m) => ws.readyState === 1 && ws.send(JSON.stringify(m)));
    ws.on("message", (raw) => { try { conn.message(JSON.parse(raw)); } catch {} });
    ws.on("close", () => conn.close());
    ws.on("error", () => {}); // oversized or malformed frames close the socket; never crash the controller
  });
  await new Promise((r) => wss.once("listening", r));
  return wss;
}

// ---------- CLI ----------
if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
  const port = +arg("--port", 7720), dir = arg("--keys", "keys/fleet"), app = arg("--app", "demo.tasks");
  const rootOut = arg("--root-out", dir.replace(/\/+$/, "") + "-root");
  const fresh = !existsSync(join(dir, "keyrings.json"));
  const fleet = fresh ? await FleetController.create({ app }) : await FleetController.load(dir);
  await fleet.save(dir, fresh ? { rootDir: rootOut } : {});
  if (fresh) { fleet.rootKeys = []; console.log(`root keys written to ${join(rootOut, "root.json")}: move them offline; "rotate <root-dir>" loads them only to sign`); }
  fleet.onEvent = (e) => { if (e.kind !== "status") console.log("·", JSON.stringify(e)); };
  fleet.onEnroll = () => { writeFileSync(join(dir, "devices.json"), JSON.stringify(Object.fromEntries(fleet.devices))); };
  await serve(fleet, { port });
  fleet.startFreshness(); // re-sign each channel's freshness note every ttl/3 (SEC-01)
  console.log(`fleet controller on ws://localhost:${port}; hosts pin ${join(dir, "keyring.pinned.json")}`);
  const layersOf = async (specs) => { const l = {}; for (const s of specs) { const [slot, f] = s.split("="); l[slot] = await fleet.addBlob(new Uint8Array(readFileSync(f))); } return l; };
  const { createInterface } = await import("node:readline");
  createInterface({ input: process.stdin }).on("line", async (line) => {
    const [cmd, ch, x, ...rest] = line.trim().split(/\s+/);
    try {
      if (cmd === "publish") console.log("published v" + await fleet.publish(ch, await layersOf(rest), { percent: +x }));
      else if (cmd === "percent") await fleet.setPercent(ch, +x);
      else if (cmd === "rollback") console.log("rolled back as v" + await fleet.rollback(ch));
      else if (cmd === "rollout") console.log(JSON.stringify(await fleet.rollout(ch, await layersOf(rest), { steps: x.split(",").map(Number), soakMs: 2000 }), null, 1));
      else if (cmd === "rotate") {
        const signers = fleet.rootKeys.length ? fleet.rootKeys : await FleetController.loadRootKeys(ch ?? rootOut);
        console.log("keyring " + await fleet.rotateReleaseKey({ rootSigners: signers }));
        await fleet.save(dir);
      }
      else if (cmd === "status") for (const c of ch ? [ch] : fleet.channels.keys()) console.log(JSON.stringify(fleet.convergence(c)));
    } catch (e) { console.log("error:", e.message); }
  });
}
