#!/usr/bin/env node
// llp — command line for the Live Layer daemon.
//
//   llp push  <app> <slot>=<file.wasm> [...]     sign with this device's key and stream to llpd
//   llp watch <app> <slot>=<file.wasm> [...]     push again whenever a file changes
//   llp trust <public-key.json> <app>            trust another publisher (a teammate or CI) for one app
//   llp open [app]                               print the link to the UI (it carries this user's UI token)
//   llp key                                      print this device's public key (to share)
//   llp status                                   what llpd is running
//   llp export <app> | llp erase <app>           this device's saved state for an app: print it, or clear it
import { readFileSync, writeFileSync, watch, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { sha256, signManifest, b64 } from "../host/llp-core.js";
import { dataKeyFromEnv, fileVault } from "../host/at-rest.mjs";

const PORT = +(process.env.LLP_PORT || 7710);
const DATA = process.env.LLP_DATA ||
  (process.platform === "win32" ? join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "LiveLayer")
   : process.platform === "darwin" ? join(homedir(), "Library", "Application Support", "LiveLayer")
   : join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "livelayer"));
const [cmd, ...rest] = process.argv.slice(2);
const die = (m) => { console.error(m); process.exit(1); };
const keyFile = join(DATA, "keys", "local.json");
const loadKey = async () => {
  if (!existsSync(keyFile)) die("No local key yet. Start llpd once first; it creates one.");
  let k;
  // Sealed when llpd runs with a data key (PR-03): the same LLP_DATA_KEY* variable opens it here.
  try { k = JSON.parse(fileVault(DATA, dataKeyFromEnv(), "llpd").read("keys/local.json")); } catch (e) { die(e.message); }
  return { priv: await crypto.subtle.importKey("jwk", k.private, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]), pub: k.public };
};

async function push(app, slots) {
  const { priv } = await loadKey();
  const blobs = new Map(), layers = {};
  for (const [slot, file] of slots) { const b = new Uint8Array(readFileSync(file)); const h = await sha256(b); blobs.set(h, b); layers[slot] = h; }
  const manifest = { app, version: Date.now(), layers, order: slots.map(([s]) => s) };
  const sig = await signManifest(manifest, priv);
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/publish`);
    const t = setTimeout(() => { console.log("✗ no answer from llpd"); ws.close(); resolve(false); }, 20000);
    ws.onerror = () => { clearTimeout(t); console.log(`✗ llpd isn't running on port ${PORT}`); resolve(false); };
    ws.onopen = () => ws.send(JSON.stringify({ t: "manifest", manifest, sig }));
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.t === "want") for (const h of m.hashes) ws.send(JSON.stringify({ t: "blob", hash: h, data: b64.enc(blobs.get(h)) }));
      if (m.t === "ack") { clearTimeout(t); console.log(`✓ ${app} live — swapped ${m.swapped.join(", ") || "nothing (unchanged)"} in ${m.ms} ms`); ws.close(); resolve(true); }
      if (m.t === "nack") { clearTimeout(t); console.log(`✗ ${app} refused: ${m.reason}`); ws.close(); resolve(false); }
    };
  });
}

const uiToken = () => { const f = join(DATA, "keys", "ui-token"); if (!existsSync(f)) die("No UI token yet. Start llpd once first; it creates one."); return readFileSync(f, "utf8").trim(); };
const parseSlots = (args) => args.map((a) => { const i = a.indexOf("="); if (i < 1) die(`expected slot=file, got "${a}"`); return [a.slice(0, i), a.slice(i + 1)]; });

if (cmd === "push") { const [app, ...s] = rest; if (!app || !s.length) die("usage: llp push <app> <slot>=<file.wasm> ..."); process.exit((await push(app, parseSlots(s))) ? 0 : 1); }
else if (cmd === "watch") {
  const [app, ...s] = rest; const slots = parseSlots(s);
  await push(app, slots);
  let timer;
  for (const [, f] of slots) watch(f, () => { clearTimeout(timer); timer = setTimeout(() => push(app, slots), 120); });
  console.log("watching for changes… (Ctrl+C to stop)");
}
else if (cmd === "trust") {
  // Trust is per app (SEC-03): a teammate's key for one app can't update the others.
  const [file, app] = rest;
  if (!file || !app) die("usage: llp trust <public-key.json> <app>");
  const k = JSON.parse(readFileSync(file, "utf8")); const jwk = k.public || k;
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || jwk.d) die("expected a P-256 public key (JWK) without a private part");
  const f = join(DATA, "keys", "trusted.json");
  let doc = existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : {};
  if (Array.isArray(doc)) { console.error(`note: ${f} trusted ${doc.length} key(s) for every app; they are kept under "*" until you remove them`); doc = doc.length ? { "*": doc } : {}; }
  const list = (doc[app] ||= []);
  if (!list.some((x) => x.x === jwk.x)) list.push({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y });
  writeFileSync(f, JSON.stringify(doc, null, 2), { mode: 0o600 }); console.log(`trusted key ${jwk.x.slice(0, 8)} for ${app} (${list.length} for this app)`);
}
else if (cmd === "open") {
  const t = uiToken();
  console.log(`http://127.0.0.1:${PORT}/?token=${t}` + (rest[0] ? `&app=${encodeURIComponent(rest[0])}` : ""));
}
else if (cmd === "key") { const { pub } = await loadKey(); console.log(JSON.stringify({ kty: pub.kty, crv: pub.crv, x: pub.x, y: pub.y })); }
else if (cmd === "status") {
  try { const r = await fetch(`http://127.0.0.1:${PORT}/status?token=${uiToken()}`); console.log(await r.text()); }
  catch { die(`llpd isn't running on port ${PORT}`); }
}
else if (cmd === "export" || cmd === "erase") {
  // This device's copy of an app's state (SPEC section 13). Server-side data is exported or erased by
  // the app's server host (ServerHost.exportUser / eraseUser, or the user's own client with selfService).
  const [app] = rest;
  if (!app) die(`usage: llp ${cmd} <app>`);
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/${cmd}?token=${uiToken()}&app=${encodeURIComponent(app)}`, { method: cmd === "erase" ? "POST" : "GET" });
    console.log(await r.text()); if (!r.ok) process.exit(1);
  } catch { die(`llpd isn't running on port ${PORT}`); }
}
else die("commands: push, watch, trust, open, key, status, export, erase");
