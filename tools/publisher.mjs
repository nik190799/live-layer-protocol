// LLP publisher: watches compiled layers, signs a new manifest on every change,
// and streams it to every connected Live Host over WebSocket.
// Usage: node tools/publisher.mjs --port 7700 main=build/tasks.wasm footer=build/stats.wasm
import { readFileSync, writeFileSync, existsSync, watch, mkdirSync } from "node:fs";
import { WebSocketServer } from "ws";
import { sha256, signManifest, b64 } from "../host/llp-core.js";

const args = process.argv.slice(2);
const port = +(args[args.indexOf("--port") + 1] || 7700);
const slots = Object.fromEntries(args.filter((a) => a.includes("=")).map((a) => a.split("=")));
const order = Object.keys(slots);

// Persistent publisher identity.
mkdirSync("keys", { recursive: true });
const ECDSA = { name: "ECDSA", namedCurve: "P-256" };
let privateKey, publicJwk;
if (existsSync("keys/publisher.json")) {
  const k = JSON.parse(readFileSync("keys/publisher.json", "utf8"));
  privateKey = await crypto.subtle.importKey("jwk", k.private, ECDSA, false, ["sign"]);
  publicJwk = k.public;
} else {
  const kp = await crypto.subtle.generateKey(ECDSA, true, ["sign", "verify"]);
  privateKey = kp.privateKey;
  publicJwk = await crypto.subtle.exportKey("jwk", kp.publicKey);
  writeFileSync("keys/publisher.json", JSON.stringify({ private: await crypto.subtle.exportKey("jwk", kp.privateKey), public: publicJwk }));
  writeFileSync("keys/publisher.pub.json", JSON.stringify(publicJwk));
}

const blobs = new Map();
let current = null;
let version = Date.now(); // monotonic across publisher restarts

async function build() {
  const layers = {};
  for (const [slot, file] of Object.entries(slots)) {
    const bytes = new Uint8Array(readFileSync(file));
    const h = await sha256(bytes);
    blobs.set(h, bytes);
    layers[slot] = h;
  }
  if (current && JSON.stringify(current.manifest.layers) === JSON.stringify(layers)) return false;
  const manifest = { app: "demo.tasks", version: ++version, layers, order };
  current = { manifest, sig: await signManifest(manifest, privateKey) };
  console.log(`published v${manifest.version}: ${order.map((s) => `${s}=${layers[s].slice(0, 8)}`).join(" ")}`);
  return true;
}

// Local only by default (AI-01); pass --host 0.0.0.0 to let hosts on other machines connect.
const listenHost = (() => { const i = process.argv.indexOf("--host"); return i > 0 ? process.argv[i + 1] : "127.0.0.1"; })();
const wss = new WebSocketServer({ port, host: listenHost, maxPayload: 1024 * 1024 });
const send = (ws, msg) => ws.readyState === 1 && ws.send(JSON.stringify(msg));
wss.on("connection", (ws) => {
  ws.on("error", () => {});
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw);
    if (msg.t === "hello" && current) send(ws, { t: "manifest", ...current });
    if (msg.t === "want") for (const h of msg.hashes) if (blobs.has(h)) send(ws, { t: "blob", hash: h, data: b64.enc(blobs.get(h)) });
    if (msg.t === "ack") console.log(`  host is live on v${msg.version} (${msg.ms} ms)`);
    if (msg.t === "nack") console.log(`  host rejected v${msg.version}: ${msg.reason}`);
  });
});

await build();
let timer;
for (const file of Object.values(slots)) watch(file, () => { clearTimeout(timer); timer = setTimeout(async () => {
  if (await build()) for (const ws of wss.clients) send(ws, { t: "manifest", ...current });
}, 80); });
console.log(`publisher on ws://localhost:${port} — public key in keys/publisher.pub.json`);
