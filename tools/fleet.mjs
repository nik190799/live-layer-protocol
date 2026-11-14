// LLP fleet controller: the publisher side of release channels, percentage rollouts, convergence
// tracking and key rotation. The host side is host/fleet.js.
//
// As a library:  const fleet = await FleetController.create({ app }); serve(fleet, { port });
// As a CLI:      node tools/fleet.mjs --port 7720 [--keys keys/fleet]
//   stdin:  publish <channel> <percent> slot=file.wasm ...  |  percent <channel> <p>  |  rollback <channel>
//           rollout <channel> <p1,p2,...> slot=file ...     |  rotate  |  status [channel]
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { sha256, signManifest, generatePublisherKey, b64 } from "../host/llp-core.js";
import { signDoc, bucketOf, rolloutSeed } from "../host/fleet.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ECDSA = { name: "ECDSA", namedCurve: "P-256" };
const exportKey = async (k) => ({ private: await crypto.subtle.exportKey("jwk", k.privateKey), public: k.publicJwk });
const importKey = async (k) => ({ privateKey: await crypto.subtle.importKey("jwk", k.private, ECDSA, true, ["sign"]), publicJwk: k.public });

export class FleetController {
  // rootKeys: [{privateKey, publicJwk}] (offline in production; pass them to rotate* instead of keeping them here)
  constructor({ app, rootKeys = [], keyrings, releaseKey, version = Date.now(), onEvent = () => {} }) {
    Object.assign(this, { app, rootKeys, keyrings, releaseKey, version, onEvent });
    this.blobs = new Map();     // hash -> bytes
    this.channels = new Map();  // name -> { current: {manifest, sig}, history: [{version, layers, order}] }
    this.hosts = new Map();     // id -> record from hello/status
    this.waiters = new Set();
  }

  static async create({ app, roots = 1, threshold = 1, version } = {}) {
    const rootKeys = []; for (let i = 0; i < roots; i++) rootKeys.push(await generatePublisherKey());
    const releaseKey = await generatePublisherKey();
    const doc = { app, keyring: 1, root: { keys: rootKeys.map((k) => k.publicJwk), threshold }, release: { keys: [releaseKey.publicJwk] } };
    const fleet = new FleetController({ app, rootKeys, releaseKey, keyrings: [], version });
    fleet.keyrings.push({ doc, sigs: await fleet.signKeyring(doc, rootKeys.slice(0, threshold)) });
    return fleet;
  }

  // What a new host is installed with (it pins the current keyring).
  get keyring() { return this.keyrings[this.keyrings.length - 1].doc; }
  async signKeyring(doc, signers) { const out = []; for (const k of signers) out.push(await signDoc(doc, k.privateKey, k.publicJwk)); return out; }

  async addBlob(bytes) { const h = await sha256(bytes); this.blobs.set(h, bytes); return h; }

  // ---------- releases ----------
  channel(name) { if (!this.channels.has(name)) this.channels.set(name, { current: null, history: [] }); return this.channels.get(name); }

  async publish(channel, layers, { order, percent = 100, seed } = {}) {
    for (const h of Object.values(layers)) if (!this.blobs.has(h)) throw new Error(`blob ${h.slice(0, 8)} was never added`);
    const manifest = { app: this.app, channel, version: ++this.version, layers, order: order ?? Object.keys(layers) };
    if (percent < 100) manifest.rollout = { percent, seed: seed ?? `${this.app}/${channel}` };
    const ch = this.channel(channel);
    ch.history.push({ version: manifest.version, layers, order: manifest.order });
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
    const v = await this.publish(channel, prev.layers, { order: prev.order });
    this.onEvent({ kind: "rollback", channel, version: v, to: prev.version });
    return v;
  }

  async sign(channel, manifest) {
    const ch = this.channel(channel);
    ch.current = { manifest, sig: await signManifest(manifest, this.releaseKey.privateKey) };
    for (const host of this.hosts.values()) if (host.online && host.channel === channel) host.send({ t: "manifest", ...ch.current });
  }

  // ---------- key rotation ----------
  // New release key: keyring n+1 lists only the new key, signed by the root. Every host gets the
  // keyring first, then every channel's current manifest re-signed with the new key. The old key
  // is revoked the moment a host accepts the keyring.
  async rotateReleaseKey({ rootSigners = this.rootKeys } = {}) {
    const releaseKey = await generatePublisherKey();
    const doc = { ...this.keyring, keyring: this.keyring.keyring + 1, release: { keys: [releaseKey.publicJwk] } };
    await this.pushKeyring(doc, await this.signKeyring(doc, rootSigners.slice(0, this.keyring.root.threshold ?? 1)));
    this.releaseKey = releaseKey;
    for (const [name, ch] of this.channels) if (ch.current) await this.sign(name, ch.current.manifest);
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
    for (const host of this.hosts.values()) if (host.online) host.send({ t: "keyring", doc, sigs });
    this.onEvent({ kind: "keyring", keyring: doc.keyring });
  }

  // ---------- hosts ----------
  // One call per connection. `send` delivers a message to that host. Returns the connection's handlers.
  attach(send) {
    let rec = null;
    return {
      message: (msg) => {
        if (msg.t === "hello") {
          rec = this.hosts.get(msg.host) ?? { id: msg.host };
          Object.assign(rec, { channel: msg.channel, version: msg.version, keyring: msg.keyring, online: true, send, seen: Date.now() });
          this.hosts.set(rec.id, rec);
          for (const k of this.keyrings) if (k.doc.keyring > msg.keyring) send({ t: "keyring", ...k });
          const cur = this.channels.get(msg.channel)?.current;
          if (cur) send({ t: "manifest", ...cur });
          this.tick();
        } else if (msg.t === "want") {
          for (const h of msg.hashes || []) if (this.blobs.has(h)) send({ t: "blob", hash: h, data: b64.enc(this.blobs.get(h)) });
        } else if (msg.t === "status" && rec && msg.host === rec.id) {
          // Reports are the host's own word: useful for tracking, never a security decision.
          Object.assign(rec, { version: msg.version, keyring: msg.keyring, target: msg.target, percent: msg.percent, state: msg.state, reason: msg.reason, seen: Date.now() });
          if (msg.state === "reverted") rec.reverted = msg.version;
          this.onEvent({ kind: "status", ...msg });
          this.tick();
        }
      },
      close: () => { if (rec && rec.send === send) { rec.online = false; this.tick(); } },
    };
  }

  // ---------- convergence ----------
  convergence(channel) {
    const cur = this.channels.get(channel)?.current?.manifest;
    const T = cur?.version, percent = cur?.rollout?.percent ?? 100;
    const r = { channel, version: T, percent, hosts: 0, online: 0, live: 0, skipped: 0, rejected: 0, reverted: 0, pending: 0, offline: 0, oldKeyring: 0, reasons: {}, laggards: [] };
    for (const h of this.hosts.values()) {
      if (h.channel !== channel) continue;
      r.hosts++;
      if (!h.online) { r.offline++; continue; }
      r.online++;
      if (h.keyring < this.keyring.keyring) r.oldKeyring++;
      if (h.version === T && h.reverted === T) r.reverted++;
      else if (h.version === T && (h.state === "live" || h.state === "keyring")) r.live++;
      else if (h.target === T && h.state === "skipped" && h.percent === percent && percent < 100) r.skipped++;
      else if (h.target === T && h.state === "rejected") { r.rejected++; r.reasons[h.reason] = (r.reasons[h.reason] ?? 0) + 1; }
      else { r.pending++; if (r.laggards.length < 10) r.laggards.push(h.id); }
    }
    r.converged = !!T && r.online > 0 && r.pending === 0 && r.rejected === 0 && r.reverted === 0 && r.oldKeyring === 0 && (percent >= 100 ? r.skipped === 0 : true);
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
  async save(dir) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "root.json"), JSON.stringify(await Promise.all(this.rootKeys.map(exportKey))));
    writeFileSync(join(dir, "release.json"), JSON.stringify(await exportKey(this.releaseKey)));
    writeFileSync(join(dir, "keyrings.json"), JSON.stringify(this.keyrings));
    writeFileSync(join(dir, "keyring.pinned.json"), JSON.stringify(this.keyring)); // ship this with hosts
  }
  static async load(dir, opts = {}) {
    const keyrings = JSON.parse(readFileSync(join(dir, "keyrings.json"), "utf8"));
    const rootKeys = await Promise.all(JSON.parse(readFileSync(join(dir, "root.json"), "utf8")).map(importKey));
    const releaseKey = await importKey(JSON.parse(readFileSync(join(dir, "release.json"), "utf8")));
    return new FleetController({ app: keyrings[0].doc.app, rootKeys, releaseKey, keyrings, ...opts });
  }
}

// WebSocket transport. Returns the server.
export async function serve(fleet, { port = 7720 } = {}) {
  const { WebSocketServer } = await import("ws");
  const wss = new WebSocketServer({ port });
  wss.on("connection", (ws) => {
    const conn = fleet.attach((m) => ws.readyState === 1 && ws.send(JSON.stringify(m)));
    ws.on("message", (raw) => { try { conn.message(JSON.parse(raw)); } catch {} });
    ws.on("close", () => conn.close());
  });
  await new Promise((r) => wss.once("listening", r));
  return wss;
}

// ---------- CLI ----------
if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
  const port = +arg("--port", 7720), dir = arg("--keys", "keys/fleet"), app = arg("--app", "demo.tasks");
  const fleet = existsSync(join(dir, "keyrings.json")) ? await FleetController.load(dir) : await FleetController.create({ app });
  await fleet.save(dir);
  fleet.onEvent = (e) => { if (e.kind !== "status") console.log("·", JSON.stringify(e)); };
  await serve(fleet, { port });
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
      else if (cmd === "rotate") { console.log("keyring " + await fleet.rotateReleaseKey()); await fleet.save(dir); }
      else if (cmd === "status") for (const c of ch ? [ch] : fleet.channels.keys()) console.log(JSON.stringify(fleet.convergence(c)));
    } catch (e) { console.log("error:", e.message); }
  });
}
