// Headless Live Host that joins a fleet: a channel, a stable host id, and a pinned keyring.
// Usage: node host/fleet-host.mjs <ws-url> <keyring.pinned.json> --id <host-id> --channel <name> [--count N] [--trust-dir <dir> | --no-trust-dir] [--freshness warn|refuse]
// The trust dir keeps each host's latest accepted keyring and its device key on disk, so a restart
// can't fall back to a revoked key (FL-02). It defaults to "trust" beside the pinned keyring.
// --no-trust-dir turns that off (tests and throwaway hosts only): a restarted host then trusts the
// pinned keyring again until it reconnects. A saved file that exists but can't be read stops the host.
// With LLP_DATA_KEY, LLP_DATA_KEY_FILE or LLP_DATA_KEY_CMD set (host/at-rest.mjs), the trust dir's
// files are sealed (PR-03): the device key can't be read, and the saved keyring can't be swapped for an
// older one, without the data key.
// --count N runs N independent hosts in this process (ids <id>-0 .. <id>-N-1), for simulations.
// Prints one JSON line per status report. Commands on stdin: "click <slot> <id>" (all hosts), "state".
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { createInterface } from "node:readline";
import { LiveHost } from "./llp-core.js";
import { FleetAgent, TrustStore, generateDeviceKey } from "./fleet.js";
import { dataKeyFromEnv, fileVault } from "./at-rest.mjs";

const [url, keyringFile] = process.argv.slice(2);
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const baseId = arg("--id", "host"), channel = arg("--channel", "stable"), count = +arg("--count", 1);
const pinned = JSON.parse(readFileSync(keyringFile, "utf8"));
const trustDir = process.argv.includes("--no-trust-dir") ? null : arg("--trust-dir", join(dirname(keyringFile), "trust"));
const freshMode = arg("--freshness", null); // warn | refuse (SEC-01): report, or also refuse installs, without a valid freshness note
if (trustDir) mkdirSync(trustDir, { recursive: true });
let vault = null;
if (trustDir) { try { vault = fileVault(trustDir, dataKeyFromEnv(), "fleet-host"); } catch (e) { console.error(`error: ${e.message}`); process.exit(2); } }
const rel = (file) => file.slice(trustDir.length + 1);
const trustFile = (id) => join(trustDir, `${id.replace(/[^\w.-]/g, "_")}.keyring.json`);
const agents = [];
// Read a saved file, or stop: falling back to the pinned keyring would undo a revocation (FL-02).
const readSaved = (file) => {
  if (!existsSync(file)) return null;
  try { return JSON.parse(vault.read(rel(file))); }
  catch (e) { console.error(`error: can't read ${file} (${e.message}). Fix or remove it; this host won't start without it.`); process.exit(2); }
};
const ECDSA = { name: "ECDSA", namedCurve: "P-256" };
// The device key proves this host's id to the controller. With --trust-dir it is kept on disk, so
// a restarted host is still recognised; without it every start makes a new key, and a controller
// that already knows this id refuses the host.
async function deviceKeyFor(id) {
  const file = trustDir && join(trustDir, `${id.replace(/[^\w.-]/g, "_")}.device.json`);
  const saved = file && readSaved(file);
  if (saved) return { privateKey: await crypto.subtle.importKey("jwk", saved.private, ECDSA, true, ["sign"]), publicJwk: saved.public };
  const k = await generateDeviceKey();
  if (file) vault.write(rel(file), JSON.stringify({ private: await crypto.subtle.exportKey("jwk", k.privateKey), public: k.publicJwk }));
  else if (!agents.length) console.error("warning: --no-trust-dir, so this host's device key and keyring are not kept across restarts");
  return k;
}

async function start(id) {
  const host = new LiveHost({});
  let ws;
  const saved = trustDir ? readSaved(trustFile(id)) : null;
  const trust = new TrustStore(saved && saved.app === pinned.app && saved.keyring > pinned.keyring ? saved : pinned);
  const agent = new FleetAgent({ host, id, channel, trust, deviceKey: await deviceKeyFor(id), freshness: freshMode ? { mode: freshMode } : null, send: (m) => ws?.readyState === 1 && ws.send(JSON.stringify(m)) });
  const prevSend = agent.send;
  agent.send = (m) => {
    if (m.t === "status") console.log(JSON.stringify({ ...m, at: Date.now() }));
    if (m.t === "status" && m.state === "keyring" && trustDir) vault.write(rel(trustFile(id)), JSON.stringify(trust.doc));
    prevSend(m);
  };
  const connect = () => {
    ws = new WebSocket(url);
    ws.onopen = () => agent.connected(); // the controller's challenge triggers the signed hello
    ws.onmessage = (ev) => agent.receive(JSON.parse(ev.data));
    ws.onclose = () => setTimeout(connect, 500); // keep trying: an offline host catches up on reconnect
    ws.onerror = () => {};
  };
  connect();
  if (freshMode) setInterval(() => agent.checkFreshness(), 30_000).unref();
  agents.push(agent);
}
for (let i = 0; i < count; i++) await start(count === 1 ? baseId : `${baseId}-${i}`);

createInterface({ input: process.stdin }).on("line", async (line) => {
  const [cmd, a, b] = line.trim().split(" ");
  if (cmd === "click") for (const ag of agents) await ag.host.dispatch(a, b);
  if (cmd === "state") for (const ag of agents) console.log(JSON.stringify({ t: "state", host: ag.id, version: ag.host.version, keyring: ag.trust.version, kv: Object.fromEntries(ag.host.kv) }));
});
