// Signs manifests and streams them to connected Live Hosts. Same wire protocol and key
// file (keys/publisher.json) as tools/publisher.mjs, so existing hosts trust it unchanged.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { WebSocketServer } from "ws";
import { sha256, signManifest, b64 } from "../host/llp-core.js";

const ECDSA = { name: "ECDSA", namedCurve: "P-256" };

export async function loadKey(dir = "keys") {
  mkdirSync(dir, { recursive: true });
  if (existsSync(`${dir}/publisher.json`)) {
    const k = JSON.parse(readFileSync(`${dir}/publisher.json`, "utf8"));
    return { privateKey: await crypto.subtle.importKey("jwk", k.private, ECDSA, false, ["sign"]), publicJwk: k.public };
  }
  const kp = await crypto.subtle.generateKey(ECDSA, true, ["sign", "verify"]);
  const publicJwk = await crypto.subtle.exportKey("jwk", kp.publicKey);
  writeFileSync(`${dir}/publisher.json`, JSON.stringify({ private: await crypto.subtle.exportKey("jwk", kp.privateKey), public: publicJwk }), { mode: 0o600 });
  writeFileSync(`${dir}/publisher.pub.json`, JSON.stringify(publicJwk));
  return { privateKey: kp.privateKey, publicJwk };
}

export class StreamServer {
  // host: listening interface. Default 127.0.0.1 (AI-01): hosts' replies reach the model's prompt,
  // so only this machine may connect unless the caller opts in with e.g. host: "0.0.0.0".
  constructor({ port, app = "demo.tasks", privateKey, host = "127.0.0.1" }) {
    this.app = app; this.privateKey = privateKey;
    this.blobs = new Map(); this.current = null; this.version = Date.now();
    this.waiters = new Map(); // version -> resolve
    this.wss = new WebSocketServer({ port, host, maxPayload: 1024 * 1024 });
    this.ready = new Promise((r) => this.wss.once("listening", r));
    this.wss.on("connection", (ws) => { ws.on("error", () => {}); ws.on("message", (raw) => { try { this.onMessage(ws, JSON.parse(raw)); } catch {} }); });
  }
  get hosts() { return [...this.wss.clients].filter((c) => c.readyState === 1).length; }
  send(ws, msg) { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }
  onMessage(ws, msg) {
    if (msg.t === "hello" && this.current) this.send(ws, { t: "manifest", ...this.current });
    if (msg.t === "want") for (const h of msg.hashes) if (this.blobs.has(h)) this.send(ws, { t: "blob", hash: h, data: b64.enc(this.blobs.get(h)) });
    if (msg.t === "ack" || msg.t === "nack") this.waiters.get(msg.version)?.(msg);
  }

  // Sign and stream { slot: bytes }. Resolves with the first host's ack/nack, or { t: "none" }
  // if no host is connected (the manifest is still kept and sent to hosts that connect later).
  async publish(layers, order, { timeoutMs = 5000 } = {}) {
    const hashes = {};
    for (const [slot, bytes] of Object.entries(layers)) { const h = await sha256(bytes); this.blobs.set(h, bytes); hashes[slot] = h; }
    const manifest = { app: this.app, version: ++this.version, layers: hashes, order };
    const prev = this.current;
    this.current = { manifest, sig: await signManifest(manifest, this.privateKey) };
    if (!this.hosts) return { t: "none", version: manifest.version };
    const reply = new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ t: "timeout", version: manifest.version }), timeoutMs);
      this.waiters.set(manifest.version, (m) => { clearTimeout(timer); resolve(m); });
    });
    for (const ws of this.wss.clients) this.send(ws, { t: "manifest", ...this.current });
    const r = await reply;
    this.waiters.delete(manifest.version);
    if (r.t !== "ack") this.current = prev; // hosts that connect later get the last version that worked
    return r;
  }
  close() { for (const c of this.wss.clients) c.terminate(); this.wss.close(); }
}
