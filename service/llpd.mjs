// llpd — the Live Layer daemon. One per device. Hosts any number of live apps,
// keeps their state on disk, accepts signed layer streams, and serves thin UI clients.
//
//   node service/llpd.mjs [--port 7710] [--data <dir>]
//
// Encryption at rest (PR-03): with LLP_DATA_KEY, LLP_DATA_KEY_FILE or LLP_DATA_KEY_CMD set (see
// host/at-rest.mjs), each app's saved state and release, and this device's publisher key, are sealed
// with AES-256-GCM. Blobs (public code), trusted.json (public keys) and ui-token stay plain. Without
// a key, llpd warns once and saves plain JSON as before.
//
// Endpoints (bound to 127.0.0.1 only):
//   GET  /?token=<t>             app launcher + UI client (`llp open` prints the URL)
//   WS   /ui?token=<t>&app=<name> UI client: receives renders, sends events
//   WS   /publish                publishers push manifests + blobs (SPEC §5); signatures decide
//   GET  /status?token=<t>       JSON status
//   GET  /export?token=<t>&app=<name>   this device's state for the app (JSON); POST /erase?... clears it
// <t> is the UI token in <data>/keys/ui-token, readable only by this user (SEC-04).
import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir, hostname } from "node:os";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { LiveHost, sha256, b64 } from "../host/llp-core.js";
import { dataKeyFromEnv, fileVault } from "../host/at-rest.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const arg = (name, def) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : def; };
const PORT = +arg("--port", process.env.LLP_PORT || 7710);
const DATA = arg("--data", process.env.LLP_DATA ||
  (process.platform === "win32" ? join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "LiveLayer")
   : process.platform === "darwin" ? join(homedir(), "Library", "Application Support", "LiveLayer")
   : join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "livelayer")));

for (const d of ["blobs", "apps", "keys"]) mkdirSync(join(DATA, d), { recursive: true });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
let vault;
try { vault = fileVault(DATA, dataKeyFromEnv(), "llpd"); } catch (e) { console.error(`error: ${e.message}`); process.exit(2); }
if (!vault.encrypted) log("warning: app state is saved unencrypted; set LLP_DATA_KEY_CMD (an OS keystore command), LLP_DATA_KEY_FILE or LLP_DATA_KEY to encrypt it");
const readSealed = (rel, def) => { try { const s = vault.read(rel); return s === null ? def : JSON.parse(s); } catch (e) { if (/decrypt/.test(e.message)) { console.error(`error: ${rel}: ${e.message}`); process.exit(2); } return def; } };
const writeAtomic = (file, text, mode) => { writeFileSync(file + ".tmp", text, mode ? { mode } : undefined); renameSync(file + ".tmp", file); };
const readJson = (file, def) => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return def; } };

// ---------- trust ----------
// The local publisher key lives in the user's data dir: anyone who can read it is this user.
const ECDSA = { name: "ECDSA", namedCurve: "P-256" };
const localKeyFile = join(DATA, "keys", "local.json");
if (!existsSync(localKeyFile)) {
  const kp = await crypto.subtle.generateKey(ECDSA, true, ["sign", "verify"]);
  vault.write("keys/local.json", JSON.stringify({ private: await crypto.subtle.exportKey("jwk", kp.privateKey), public: await crypto.subtle.exportKey("jwk", kp.publicKey) })); // owner-only (SEC-02), sealed with a data key (PR-03)
  log("created local publisher key");
}
vault.reseal("keys/local.json"); // a key that was saved before encryption was turned on
const LOCAL_PUBLIC = readSealed("keys/local.json", {}).public;
// trusted.json is {app: [public keys]}: a key trusted for one app can't update another (SEC-03).
// Keys under "*" (or an older file that is a plain array) are trusted for every app; that still
// works, with a warning, so existing setups keep running.
const trustFile = join(DATA, "keys", "trusted.json");
let warnedAll = false;
const trusted = (name) => {
  let doc = readJson(trustFile, {});
  if (Array.isArray(doc)) doc = { "*": doc };
  if (!doc || typeof doc !== "object") doc = {};
  const all = Array.isArray(doc["*"]) ? doc["*"] : [], own = Array.isArray(doc[name]) ? doc[name] : [];
  if (all.length && !warnedAll) { warnedAll = true; log(`warning: ${trustFile} trusts ${all.length} key(s) for every app; trust them per app with "llp trust <key> <app>"`); }
  return [LOCAL_PUBLIC, ...own, ...all];
};

// The UI token: only someone who can read this user's data dir can open the UI or read status.
const tokenFile = join(DATA, "keys", "ui-token");
if (!existsSync(tokenFile)) writeAtomic(tokenFile, randomBytes(24).toString("hex"), 0o600);
const TOKEN = readFileSync(tokenFile, "utf8").trim();
const okToken = (t) => typeof t === "string" && t.length === TOKEN.length && timingSafeEqual(Buffer.from(t), Buffer.from(TOKEN));

// ---------- blob store (content addressed, shared by all apps) ----------
const blobPath = (h) => join(DATA, "blobs", h + ".wasm");
const hasBlob = (h) => /^[0-9a-f]{64}$/.test(h) && existsSync(blobPath(h));
const getBlob = (h) => new Uint8Array(readFileSync(blobPath(h)));
async function putBlob(bytes) { const h = await sha256(bytes); if (!existsSync(blobPath(h))) writeAtomic(blobPath(h), bytes); return h; }

// ---------- apps ----------
const apps = new Map(); // name -> { host, clients:Set, saveTimer }
const appDir = (name) => join(DATA, "apps", name);
const validName = (n) => /^[a-z0-9][a-z0-9._-]{0,63}$/.test(n);

function broadcast(app, msg) { const s = JSON.stringify(msg); for (const ws of app.clients) if (ws.readyState === 1) ws.send(s); }

function getApp(name) {
  if (apps.has(name)) return apps.get(name);
  mkdirSync(appDir(name), { recursive: true });
  const app = { name, clients: new Set(), last: [], saveTimer: null, logTail: [] };
  app.host = new LiveHost({
    app: name,
    trustedKeys: trusted(name),
    capabilities: {
      haptic: async (ms) => { broadcast(app, { t: "fx", name: "haptic", arg: ms }); },
      geo: async () => "Location isn't available to desktop apps yet.",
      notify: async (text) => { broadcast(app, { t: "fx", name: "notify", arg: text }); return "shown"; },
    },
    onRender: (slots) => { app.last = slots; broadcast(app, { t: "render", slots, version: app.host.version, layers: layerInfo(app), binds: binds(app, slots) }); scheduleSave(app); },
    onLog: (e) => { app.logTail = [...app.logTail, e].slice(-30); log(`[${name}] ${e.kind}: ${e.msg}`); broadcast(app, { t: "log", entry: e }); },
  });
  app.host.kv = new Map(readSealed(`apps/${name}/state.json`, []));
  apps.set(name, app);
  return app;
}
function binds(app, slots) {
  const out = {}; const walk = (n) => { if (!n) return; if (n.k === "input" && n.a?.bind) out[n.a.bind] = String(app.host.kv.get(n.a.bind) ?? ""); (n.c || []).forEach(walk); };
  for (const s of slots) walk(s.tree); return out;
}
const layerInfo = (app) => Object.fromEntries([...app.host.slots].map(([s, v]) => [s, v.hash.slice(0, 12)]));
function scheduleSave(app) {
  clearTimeout(app.saveTimer);
  app.saveTimer = setTimeout(() => saveState(app), 150);
}

const saveState = (app) => vault.write(`apps/${app.name}/state.json`, JSON.stringify([...app.host.kv]));

// Restore every installed app from disk: re-verify its signed manifest, then run it on saved state.
for (const name of readdirSync(join(DATA, "apps"))) {
  if (!validName(name)) continue;
  const cur = readSealed(`apps/${name}/current.json`, null);
  if (!cur) continue;
  const app = getApp(name);
  const r = await app.host.apply(cur.manifest, cur.sig, async (h) => { if (!hasBlob(h)) throw new Error("missing blob " + h.slice(0, 8)); return getBlob(h); });
  log(r.ok ? `restored ${name} (version ${cur.manifest.version}, ${r.ms} ms)` : `could not restore ${name}: ${r.reason}`);
  if (r.ok && vault.encrypted) { vault.reseal(`apps/${name}/current.json`); vault.reseal(`apps/${name}/state.json`); }
}

// ---------- HTTP + WebSocket ----------
const uiHtml = () => readFileSync(join(here, "ui.html"), "utf8").replace("__LLP_UI_TOKEN__", TOKEN);
const server = createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if ((url.pathname === "/" || url.pathname === "/status" || url.pathname === "/export" || url.pathname === "/erase") && !okToken(url.searchParams.get("token"))) {
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    return res.end("This needs the UI token. Run \"llp open\" to get the link.\n");
  }
  if (url.pathname === "/") { res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }); return res.end(uiHtml()); }
  // This device's copy of one app's state (section 14): everything llpd keeps for it, or erase it.
  if ((url.pathname === "/export" || url.pathname === "/erase") && okToken(url.searchParams.get("token"))) {
    const app = apps.get(url.searchParams.get("app") ?? "");
    if (!app) { res.writeHead(404, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: "no such app" })); }
    if (url.pathname === "/export") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      return res.end(JSON.stringify({ kind: "llp-device-export", app: app.name, device: hostname(), at: new Date().toISOString(), keys: Object.fromEntries([...app.host.kv].filter(([k]) => !k.startsWith("__schema."))) }, null, 2));
    }
    if (req.method !== "POST") { res.writeHead(405); return res.end("POST to erase\n"); }
    app.host.exclusive(async () => { for (const k of [...app.host.kv.keys()]) if (!k.startsWith("__schema.")) app.host.kv.delete(k); await app.host.renderNow(); }).then(() => {
      saveState(app);
      log(`[${app.name}] privacy: erased this device's app state`);
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ kind: "llp-device-erase", app: app.name, at: new Date().toISOString() }));
    });
    return;
  }
  if (url.pathname === "/status") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ device: hostname(), port: PORT, data: DATA, apps: [...apps.values()].map((a) => ({ name: a.name, version: a.host.version, layers: layerInfo(a), clients: a.clients.size })) }, null, 2));
  }
  res.writeHead(404); res.end("not found");
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
const okOrigin = (o) => !o || o === `http://127.0.0.1:${PORT}` || o === `http://localhost:${PORT}`;
server.on("upgrade", (req, sock, head) => {
  // A web page on any other site must not drive local apps.
  if (!okOrigin(req.headers.origin)) { sock.write("HTTP/1.1 403 Forbidden\r\n\r\n"); return sock.destroy(); }
  wss.handleUpgrade(req, sock, head, (ws) => wss.emit("connection", ws, req));
});

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, "http://localhost");
  const send = (m) => ws.readyState === 1 && ws.send(JSON.stringify(m));

  if (url.pathname === "/ui") {
    if (!okToken(url.searchParams.get("token"))) { send({ t: "error", msg: "This needs the UI token. Run \"llp open\" to get the link." }); return ws.close(); }
    const name = url.searchParams.get("app");
    if (!name) { send({ t: "apps", apps: [...apps.values()].map((a) => ({ name: a.name, version: a.host.version })) }); return; }
    if (!apps.has(name)) { send({ t: "error", msg: `No app named ${name}` }); return ws.close(); }
    const app = apps.get(name);
    app.clients.add(ws);
    send({ t: "render", slots: app.last, version: app.host.version, layers: layerInfo(app), binds: binds(app, app.last) });
    for (const e of app.logTail) send({ t: "log", entry: e });
    ws.on("message", async (raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.t === "event" && typeof m.slot === "string" && typeof m.id === "string") await app.host.dispatch(m.slot, m.id, String(m.value ?? ""));
      // Only keys bound to an input on the current screen can be set from the UI (SEC-04).
      if (m.t === "bind" && typeof m.key === "string" && Object.hasOwn(binds(app, app.last), m.key)) { app.host.setBound(m.key, String(m.value ?? "")); scheduleSave(app); broadcast(app, { t: "bound", key: m.key, value: m.value, from: m.cid }); }
    });
    ws.on("close", () => app.clients.delete(ws));
    return;
  }

  if (url.pathname === "/publish") {
    const waiting = new Map();
    ws.on("message", async (raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.t === "blob" && waiting.has(m.hash)) { waiting.get(m.hash)(b64.dec(m.data)); waiting.delete(m.hash); }
      if (m.t !== "manifest") return;
      const name = m.manifest?.app;
      if (!validName(name || "")) return send({ t: "nack", version: m.manifest?.version, reason: "invalid app name" });
      const app = getApp(name);
      app.host.trustedKeys = trusted(name);
      const r = await app.host.apply(m.manifest, m.sig, async (h) => {
        if (hasBlob(h)) return getBlob(h);
        const bytes = await new Promise((res, rej) => { waiting.set(h, res); send({ t: "want", hashes: [h] }); setTimeout(() => rej(new Error("blob timeout")), 15000); });
        if ((await sha256(bytes)) === h) await putBlob(bytes);
        return bytes;
      });
      if (r.ok) vault.write(`apps/${name}/current.json`, JSON.stringify({ manifest: m.manifest, sig: m.sig }));
      else if (!app.host.version) { app.host.close(); apps.delete(name); }
      send(r.ok ? { t: "ack", version: r.version, ms: r.ms, swapped: r.swapped } : { t: "nack", version: r.version, reason: r.reason });
    });
    return;
  }
  ws.close();
});

server.listen(PORT, "127.0.0.1", () => log(`llpd on http://127.0.0.1:${PORT}  data: ${DATA}  (run "llp open" for the UI link)`));
const stop = () => { for (const a of apps.values()) saveState(a); process.exit(0); };
process.on("SIGINT", stop); process.on("SIGTERM", stop);
