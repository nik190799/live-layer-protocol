// Encryption at rest for the device-side hosts (red-team PR-03): the llpd service and its CLI, and
// a fleet host's trust dir. Real processes, real files; also the device half of export and erase.
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateDataKey } from "../host/at-rest.mjs";
import { FleetController, serve } from "../tools/fleet.mjs";

const root = new URL("..", import.meta.url).pathname;
const results = [];
const check = (n, c, d = "") => { results.push(!!c); console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const files = (dir) => { const out = []; const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); statSync(p).isDirectory() ? walk(p) : out.push(p); } }; walk(dir); return out; };
const sealed = (f) => readFileSync(f, "utf8").startsWith("LLPE1.");
const B = (f) => join(root, "build", f);

// ---------- llpd ----------
const DATA = mkdtempSync(join(tmpdir(), "llpd-enc-"));
const PORT = 7791;
const KEY = generateDataKey();
const base = { ...process.env, LLP_DATA: DATA, LLP_PORT: String(PORT) };
delete base.LLP_DATA_KEY; delete base.LLP_DATA_KEY_FILE; delete base.LLP_DATA_KEY_CMD;
const keyEnv = { ...base, LLP_DATA_KEY_CMD: `node -e "process.stdout.write('${KEY}')"` }; // stands in for an OS keystore command
let daemon;
async function start(env) {
  daemon = spawn("node", [join(root, "service/llpd.mjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
  daemon.out = ""; daemon.stdout.on("data", (d) => (daemon.out += d)); daemon.stderr.on("data", (d) => (daemon.out += d));
  daemon.exited = new Promise((r) => daemon.on("exit", (code) => r(code)));
  for (let i = 0; i < 60; i++) {
    if (daemon.exitCode !== null) return daemon.exitCode;
    try { await fetch(`http://127.0.0.1:${PORT}/`); return null; } catch { await sleep(100); }
  }
  return await Promise.race([daemon.exited, sleep(1000).then(() => "timeout")]);
}
const stop = () => new Promise((r) => { if (daemon.exitCode !== null) return r(); daemon.on("exit", r); daemon.kill("SIGTERM"); });
const llp = (env, ...a) => { try { return execFileSync("node", [join(root, "service/llp.mjs"), ...a], { env, encoding: "utf8" }); } catch (e) { return e.stdout + e.stderr; } };
const token = () => readFileSync(join(DATA, "keys", "ui-token"), "utf8").trim();
function ui(app) {
  return new Promise((res) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ui?token=${token()}&app=${app}`);
    const c = { ws, send: (m) => ws.send(JSON.stringify(m)) };
    ws.onopen = () => setTimeout(() => res(c), 100);
  });
}

// 1. A device that ran without a key first: plain files, as before.
await start(base);
check("D1 without a data key llpd still works, and warns that state is unencrypted", /saved unencrypted/.test(daemon.out));
let out = llp(base, "push", "demo.tasks", `main=${B("tasks.wasm")}`, `footer=${B("stats.wasm")}`);
let a = await ui("demo.tasks");
a.send({ t: "bind", key: "draft", value: "Secret plan before the key" }); a.send({ t: "event", slot: "main", id: "add" });
await sleep(400);
a.ws.close();
await stop();
const plainBefore = files(DATA).filter((f) => !f.includes("/blobs/") && readFileSync(f, "utf8").includes("Secret plan before the key"));

// 2. The same device with a key from a keystore command: existing files are sealed at start.
await start(keyEnv);
await sleep(300);
const resealed = ["keys/local.json", "apps/demo.tasks/current.json", "apps/demo.tasks/state.json"].every((r) => sealed(join(DATA, r)));
check("D2 starting llpd with a key seals the device key and every app's saved state and release that were plain", plainBefore.length > 0 && resealed && !/saved unencrypted/.test(daemon.out),
  `before: ${plainBefore.map((f) => f.slice(DATA.length + 1)).join(", ")}`);
out = llp(keyEnv, "push", "demo.tasks", `main=${B("tasks_v2.wasm")}`, `footer=${B("stats.wasm")}`);
check("D3 the llp CLI opens the sealed device key with the same key setting and can still publish", out.includes("✓"), out.trim());
a = await ui("demo.tasks");
a.send({ t: "bind", key: "draft", value: "Secret plan after the key" }); a.send({ t: "event", slot: "main", id: "add" });
await sleep(400);
a.ws.close();
await stop();
const leaks = files(DATA).filter((f) => !f.includes("/blobs/") && /Secret plan|"private"|"manifest"/.test(readFileSync(f, "utf8")));
check("D4 nothing readable is left on disk: no state text, no private key, no release (blobs, public trust list and UI token stay plain)", !leaks.length, leaks.join(", "));

// 3. Restart with the key: everything comes back.
await start(keyEnv);
await sleep(200);
const exp = await (await fetch(`http://127.0.0.1:${PORT}/export?token=${token()}&app=demo.tasks`)).json();
check("D5 a restart with the key restores the app and its state", /restored demo.tasks/.test(daemon.out) && JSON.stringify(exp.keys).includes("Secret plan after the key"), (daemon.out.match(/restored.*/) || [""])[0]);
check("D6 llp export prints this device's state for the app", JSON.parse(llp(keyEnv, "export", "demo.tasks")).keys["tasks.n"] >= 2);
const er = JSON.parse(llp(keyEnv, "erase", "demo.tasks"));
await sleep(200);
const after = await (await fetch(`http://127.0.0.1:${PORT}/export?token=${token()}&app=demo.tasks`)).json();
await stop();
await start(keyEnv); await sleep(200);
const afterRestart = await (await fetch(`http://127.0.0.1:${PORT}/export?token=${token()}&app=demo.tasks`)).json();
await stop();
check("D7 llp erase clears this device's state for the app, and it stays cleared after a restart", er.kind === "llp-device-erase" && Object.keys(after.keys).length === 0 && Object.keys(afterRestart.keys).length === 0 && !JSON.stringify(afterRestart).includes("Secret plan"));

// 4. Without the key, or with the wrong one, llpd refuses to start instead of starting empty.
const noKey = await start(base);
const noKeyOut = daemon.out;
const wrong = await start({ ...base, LLP_DATA_KEY: generateDataKey() });
check("D8 llpd won't start on encrypted data without its key, or with another key (exit 2, clear message)", noKey === 2 && wrong === 2 && /encrypted at rest/.test(noKeyOut) && /doesn't match/.test(daemon.out), `${noKeyOut.trim()} / ${daemon.out.trim()}`);

// ---------- fleet-host trust dir ----------
{
  const fleet = await FleetController.create({ app: "demo.tasks", version: 100 });
  const wss = await serve(fleet, { port: 0, host: "127.0.0.1" });
  const dir = mkdtempSync(join(tmpdir(), "llp-fh-"));
  writeFileSync(join(dir, "keyring.pinned.json"), JSON.stringify(fleet.keyring));
  const run = (env) => {
    const p = spawn("node", [join(root, "host/fleet-host.mjs"), `ws://127.0.0.1:${wss.address().port}`, join(dir, "keyring.pinned.json"), "--id", "h1", "--channel", "stable"], { env, stdio: ["ignore", "pipe", "pipe"] });
    p.out = ""; p.stdout.on("data", (d) => (p.out += d)); p.stderr.on("data", (d) => (p.out += d));
    p.exited = new Promise((r) => p.on("exit", (c) => r(c)));
    return p;
  };
  const env = { ...base, LLP_DATA_KEY: KEY };
  const h = run(env);
  await fleet.publish("stable", { main: await fleet.addBlob(new Uint8Array(readFileSync(B("tasks.wasm")))) });
  for (let i = 0; i < 100 && !h.out.includes('"state":"live"'); i++) await sleep(50);
  await fleet.rotateReleaseKey();
  for (let i = 0; i < 100 && !existsSync(join(dir, "trust", "h1.keyring.json")); i++) await sleep(50);
  await sleep(200);
  h.kill(); await h.exited;
  const tf = files(join(dir, "trust"));
  const allSealed = tf.length >= 3 && tf.every(sealed) && !tf.some((f) => /"d"|"private"|"release"/.test(readFileSync(f, "utf8")));
  const noKey = run(base), code = await Promise.race([noKey.exited, sleep(5000).then(() => "timeout")]);
  check("F1 a fleet host with a data key seals its device key and saved keyring; without the key it won't start", allSealed && code === 2 && /encrypted at rest/.test(noKey.out),
    `${tf.map((f) => f.slice(dir.length + 1)).join(", ")}; no key → exit ${code}`);
  const back = run(env);
  for (let i = 0; i < 100 && !back.out.includes('"state"'); i++) await sleep(50);
  back.kill(); await back.exited;
  check("F2 restarted with the key, it is still on the rotated keyring (it reads its sealed files)", /"keyring":2/.test(back.out), back.out.split("\n")[0]);
  wss.close();
}

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
