// Service tests: the daemon as a long-lived OS service.
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { sha256, signManifest, b64 } from "../host/llp-core.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const DATA = mkdtempSync(join(tmpdir(), "llpd-"));
const PORT = 7790;
const env = { ...process.env, LLP_DATA: DATA, LLP_PORT: String(PORT) };
const results = [];
const check = (n, c, d = "") => { results.push(c); console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let daemon;
async function start() {
  daemon = spawn("node", [join(root, "service/llpd.mjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
  daemon.out = ""; daemon.stdout.on("data", (d) => (daemon.out += d)); daemon.stderr.on("data", (d) => (daemon.out += d));
  for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${PORT}/`); return; } catch { await sleep(100); } }
  throw new Error("daemon did not start:\n" + daemon.out);
}
const stop = () => new Promise((r) => { daemon.on("exit", r); daemon.kill("SIGTERM"); });
const llp = (...a) => { try { return execFileSync("node", [join(root, "service/llp.mjs"), ...a], { env, encoding: "utf8" }); } catch (e) { return e.stdout + e.stderr; } };
const B = (f) => join(root, "build", f);

const token = () => readFileSync(join(DATA, "keys", "ui-token"), "utf8").trim();
function ui(app, tok = token()) {
  return new Promise((res) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ui?token=${tok}&app=${app}`, { headers: {} });
    const c = { ws, last: null, fx: [], bound: [], errors: [], send: (m) => ws.send(JSON.stringify(m)) };
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.t === "render") c.last = m; if (m.t === "fx") c.fx.push(m); if (m.t === "bound") c.bound.push(m.key); if (m.t === "error") c.errors.push(m.msg); };
    ws.onopen = () => setTimeout(() => res(c), 100);
  });
}
const text = (n) => !n ? "" : n.k === "text" ? n.t : (n.c || []).map(text).join(" ");
const screen = (c) => (c.last?.slots || []).map((s) => text(s.tree)).join(" | ");

await start();
check("S1 daemon starts and creates a device key", /local publisher key/.test(daemon.out));
let out = llp("push", "demo.tasks", `main=${B("tasks.wasm")}`, `footer=${B("stats.wasm")}`);
check("S2 llp push installs an app into the running service", out.includes("✓"), out.trim());

const a = await ui("demo.tasks"), b = await ui("demo.tasks");
a.send({ t: "bind", key: "draft", value: "Survive a reboot" }); a.send({ t: "event", slot: "main", id: "add" });
await sleep(150);
a.send({ t: "event", slot: "main", id: "t:0" }); await sleep(150);
check("S3 two UI clients see the same live app (one acts, both update)", screen(b).includes("1 of 1 done") && screen(b).includes("100%"), screen(b));
check("S4 capability effects reach the UI clients (haptic)", b.fx.some((f) => f.name === "haptic"));

out = llp("push", "demo.tasks", `main=${B("tasks_broken.wasm")}`, `footer=${B("stats.wasm")}`);
check("S5 a broken layer is refused by the service", out.includes("refused"), out.trim());

const bad = await new Promise((r) => { const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ui?app=demo.tasks`, { headers: { Origin: "https://evil.example" } }); ws.onopen = () => r("open"); ws.onerror = () => r("blocked"); });
check("S6 web pages from other sites can't connect to local apps", bad === "blocked");

a.ws.close(); b.ws.close();
await stop();
await start();
check("S7 after a restart the service restores the app (re-verifying its signature)", /restored demo.tasks/.test(daemon.out), (daemon.out.match(/restored.*/) || [""])[0]);
const c = await ui("demo.tasks");
check("S8 state survives the restart", screen(c).includes("Survive a reboot") && screen(c).includes("1 of 1 done"), screen(c));

out = llp("push", "demo.tasks", `main=${B("tasks_v2.wasm")}`, `footer=${B("stats.wasm")}`);
await sleep(150);
check("S9 live swap after restart, open client updates in place, state kept", out.includes("✓") && screen(c).includes("Tasks v2") && screen(c).includes("Survive a reboot"), out.trim());

const st = JSON.parse(llp("status"));
check("S10 status reports apps, versions and layers", st.apps?.[0]?.name === "demo.tasks" && st.apps[0].layers.main);

// SEC-04: the UI needs this user's token, and it can only set keys bound to an input on screen.
const tf = join(DATA, "keys", "ui-token");
const noTok = await Promise.all([fetch(`http://127.0.0.1:${PORT}/`), fetch(`http://127.0.0.1:${PORT}/status`), fetch(`http://127.0.0.1:${PORT}/?token=wrong`)]);
const page = await (await fetch(llp("open").trim())).text();
check("S11 the UI page and status need the UI token, which only this user can read",
  noTok.every((r) => r.status === 403) && page.includes(token()) && (statSync(tf).mode & 0o077) === 0, `${noTok.map((r) => r.status)}; mode ${(statSync(tf).mode & 0o777).toString(8)}`);
const anon = await ui("demo.tasks", "wrong"); await sleep(100);
check("S12 a UI socket without the token gets nothing and is closed", !anon.last && anon.errors.length === 1 && anon.ws.readyState >= 2, anon.errors[0]);
c.send({ t: "bind", key: "tasks.n", value: "999" }); c.send({ t: "bind", key: "__schema.main", value: "0" }); c.send({ t: "bind", key: "draft", value: "typed" });
await sleep(150);
check("S13 the UI can only set keys bound to an input on the current screen", c.bound.join() === "draft", `accepted: ${c.bound.join()}`);
c.ws.close(); await stop();
const kv = new Map(JSON.parse(readFileSync(join(DATA, "apps", "demo.tasks", "state.json"), "utf8")));
check("S14 refused UI writes never reach saved state", kv.get("tasks.n") !== "999" && kv.get("__schema.main") !== "0" && kv.get("draft") === "typed");

// SEC-03: a key trusted for one app can't update another.
const ECDSA = { name: "ECDSA", namedCurve: "P-256" };
const mate = await crypto.subtle.generateKey(ECDSA, true, ["sign", "verify"]);
const mateFile = join(DATA, "mate.json");
writeFileSync(mateFile, JSON.stringify(await crypto.subtle.exportKey("jwk", mate.publicKey)));
out = llp("trust", mateFile);
const usage = /usage: llp trust/.test(out);
out = llp("trust", mateFile, "team.notes");
await start();
async function pushAs(key, app) {
  const bytes = new Uint8Array(readFileSync(B("tasks.wasm"))); const h = await sha256(bytes);
  const manifest = { app, version: Date.now(), layers: { main: h }, order: ["main"] };
  const sig = await signManifest(manifest, key);
  return new Promise((res) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/publish`);
    ws.onopen = () => ws.send(JSON.stringify({ t: "manifest", manifest, sig }));
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.t === "want") ws.send(JSON.stringify({ t: "blob", hash: h, data: b64.enc(bytes) })); if (m.t === "ack" || m.t === "nack") { ws.close(); res(m); } };
  });
}
const own = await pushAs(mate.privateKey, "team.notes"), other = await pushAs(mate.privateKey, "demo.tasks");
check("S15 a teammate's key trusted for one app can update that app but not another", usage && own.t === "ack" && other.t === "nack" && /not trusted/.test(other.reason), `team.notes: ${own.t}; demo.tasks: ${other.t} ${other.reason ?? ""}`);
await stop();
writeFileSync(join(DATA, "keys", "trusted.json"), JSON.stringify([await crypto.subtle.exportKey("jwk", mate.publicKey)]));
await start();
const legacy = await pushAs(mate.privateKey, "demo.tasks");
check("S16 an older trust file (one list for every app) still works, with a warning", legacy.t === "ack" && /trusts 1 key\(s\) for every app/.test(daemon.out), (daemon.out.match(/warning:.*/) || [""])[0].slice(0, 90));
await stop();
console.log(`\n${results.filter(Boolean).length}/${results.length} passed  (data dir ${DATA})`);
process.exit(results.every(Boolean) ? 0 : 1);
