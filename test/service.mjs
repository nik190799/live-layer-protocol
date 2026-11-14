// Service tests: the daemon as a long-lived OS service.
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, copyFileSync } from "node:fs";
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
  for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${PORT}/status`); return; } catch { await sleep(100); } }
  throw new Error("daemon did not start:\n" + daemon.out);
}
const stop = () => new Promise((r) => { daemon.on("exit", r); daemon.kill("SIGTERM"); });
const llp = (...a) => { try { return execFileSync("node", [join(root, "service/llp.mjs"), ...a], { env, encoding: "utf8" }); } catch (e) { return e.stdout + e.stderr; } };
const B = (f) => join(root, "build", f);

function ui(app) {
  return new Promise((res) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ui?app=${app}`, { headers: {} });
    const c = { ws, last: null, fx: [], send: (m) => ws.send(JSON.stringify(m)) };
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.t === "render") c.last = m; if (m.t === "fx") c.fx.push(m); };
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
c.ws.close(); await stop();
console.log(`\n${results.filter(Boolean).length}/${results.length} passed  (data dir ${DATA})`);
process.exit(results.every(Boolean) ? 0 : 1);
