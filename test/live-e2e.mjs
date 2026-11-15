// Live, over-the-wire tests: real publisher process -> real headless host process over WebSocket.
// Then a rogue stream sends bad manifests/blobs to a second real host process.
// Usage: node test/live-e2e.mjs
import { spawn } from "node:child_process";
import { copyFileSync, readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { sha256, signManifest, generatePublisherKey, b64 } from "../host/llp-core.js";

const ROOT = new URL("..", import.meta.url).pathname;
const work = mkdtempSync(join(tmpdir(), "llp-e2e-"));
const results = [];
const check = (name, cond, detail = "") => { results.push(!!cond); console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function proc(args, cwd) {
  const p = spawn(process.execPath, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
  p.out = "";
  p.stdout.on("data", (d) => (p.out += d));
  p.stderr.on("data", (d) => (p.out += d));
  p.waitFor = async (re, ms = 5000) => { const t = Date.now(); while (!re.test(p.out)) { if (Date.now() - t > ms) return false; await sleep(20); } return true; };
  p.cmd = (line) => p.stdin.write(line + "\n");
  return p;
}
const lastFrame = (out) => { const parts = out.split("─".repeat(48)); return parts[parts.length - 2] || ""; };

// ---------- Part 1: honest publisher, live edits ----------
const live = join(work, "live-main.wasm"), foot = join(work, "live-footer.wasm");
copyFileSync(join(ROOT, "build/tasks.wasm"), live);
copyFileSync(join(ROOT, "build/stats.wasm"), foot);

const pub = proc([join(ROOT, "tools/publisher.mjs"), "--port", "7791", `main=${live}`, `footer=${foot}`], work);
await pub.waitFor(/publisher on/);
const host = proc([join(ROOT, "host/node-host.mjs"), "ws://localhost:7791", join(work, "keys/publisher.pub.json")], work);
check("L1 host connects to publisher over WebSocket and goes live", await host.waitFor(/Tasks/) && await pub.waitFor(/host is live/), lastFrame(host.out).trim().split("\n")[0]);

host.cmd("set draft Buy milk"); host.cmd("click main add"); await sleep(200);
host.cmd("set draft Call mom"); host.cmd("click main add"); await sleep(200);
check("L2 user adds state in the running app", /Buy milk/.test(lastFrame(host.out)) && /Call mom/.test(lastFrame(host.out)));

let mark = host.out.length;
copyFileSync(join(ROOT, "build/tasks_v2.wasm"), live); // "edit the code" while app runs
const swapped = await (async () => { const t = Date.now(); while (Date.now() - t < 5000) { if (/Tasks v2/.test(host.out.slice(mark))) return true; await sleep(20); } return false; })();
const f2 = lastFrame(host.out);
check("L3 file change streams in live; app shows v2 with tasks kept", swapped && /Buy milk/.test(f2) && /Call mom/.test(f2), (pub.out.match(/host is live on v\d+ \(([\d.]+) ms\)/g) || []).pop());

mark = pub.out.length;
copyFileSync(join(ROOT, "build/tasks_broken.wasm"), live);
await pub.waitFor(/host rejected/, 5000);
await sleep(100);
check("L4 broken layer streamed in is refused; v2 keeps running", /host rejected/.test(pub.out.slice(mark)) && /Tasks v2/.test(lastFrame(host.out)), (pub.out.slice(mark).match(/rejected[^\n]*/) || [""])[0]);

const lives = (pub.out.match(/host is live/g) || []).length;
copyFileSync(join(ROOT, "build/tasks_trap.wasm"), live);
{ const t = Date.now(); while ((pub.out.match(/host is live/g) || []).length === lives && Date.now() - t < 5000) await sleep(20); }
mark = host.out.length;
host.cmd("set draft this will crash"); host.cmd("click main add"); await sleep(400);
const after = host.out.slice(mark);
host.cmd("state"); await sleep(200);
const f5 = lastFrame(host.out);
// tasks_trap.wasm is v1 code (schema 1), so the revert skips v2 (schema 2) and lands on v1 (ST-01).
check("L5 layer that traps at runtime is auto-reverted; state kept, crashing task not added", /reverted to/i.test(after) && /Tasks/.test(f5) && /Buy milk/.test(f5) && !/this will crash/.test(f5), (after.match(/·[^\n]*revert[^\n]*/i) || [""])[0].trim());

host.kill(); pub.kill();

// ---------- Part 2: rogue stream against a real host ----------
// The rogue holds the real publisher key for some cases to simulate a replayed capture or a corrupted blob store.
const k = JSON.parse(readFileSync(join(work, "keys/publisher.json"), "utf8"));
const ECDSA = { name: "ECDSA", namedCurve: "P-256" };
const realKey = await crypto.subtle.importKey("jwk", k.private, ECDSA, false, ["sign"]);
const attacker = await generatePublisherKey();
const bytes = (f) => new Uint8Array(readFileSync(join(ROOT, "build", f)));
const blobs = new Map();
const put = async (b) => { const h = await sha256(b); blobs.set(h, b); return h; };
const tasks = await put(bytes("tasks.wasm")), stats = await put(bytes("stats.wasm")), v2 = await put(bytes("tasks_v2.wasm"));
let tamper = null; // hash -> wrong bytes

const wss = new WebSocketServer({ port: 7792 });
let sock; const replies = [];
wss.on("connection", (ws) => { sock = ws; ws.on("message", (raw) => {
  const m = JSON.parse(raw);
  if (m.t === "want") for (const h of m.hashes) ws.send(JSON.stringify({ t: "blob", hash: h, data: b64.enc(tamper?.[h] ?? blobs.get(h)) }));
  if (m.t === "ack" || m.t === "nack") replies.push(m);
}); });
const host2 = proc([join(ROOT, "host/node-host.mjs"), "ws://localhost:7792", join(work, "keys/publisher.pub.json")], work);
while (!sock) await sleep(20);
const push = async (manifest, key) => { const n = replies.length; sock.send(JSON.stringify({ t: "manifest", manifest, sig: await signManifest(manifest, key) })); const t = Date.now(); while (replies.length === n && Date.now() - t < 3000) await sleep(10); return replies[n]; };

let r = await push({ app: "demo.tasks", version: 10, layers: { main: v2, footer: stats }, order: ["main", "footer"] }, realKey);
check("R0 baseline: valid signed v10 goes live", r?.t === "ack");
r = await push({ app: "demo.tasks", version: 11, layers: { main: tasks, footer: stats }, order: ["main", "footer"] }, attacker.privateKey);
check("R1 manifest signed by an untrusted key is refused", r?.t === "nack", r?.reason);
r = await push({ app: "demo.tasks", version: 9, layers: { main: tasks, footer: stats }, order: ["main", "footer"] }, realKey);
check("R2 older version (rollback/replay) is refused even with a valid signature", r?.t === "nack", r?.reason);
const fake = bytes("tasks.wasm"); fake[fake.length - 1] ^= 0xff;
const h3 = await put(bytes("tasks_broken.wasm")); tamper = { [h3]: fake };
r = await push({ app: "demo.tasks", version: 12, layers: { main: h3, footer: stats }, order: ["main", "footer"] }, realKey);
check("R3 tampered blob (bytes don't match hash) is refused", r?.t === "nack", r?.reason);
await sleep(200);
check("R4 host still running v2 after all attacks", host2.exitCode === null && /Tasks v2/.test(lastFrame(host2.out)));

host2.kill(); wss.close();
const pass = results.filter(Boolean).length;
console.log(`\n${pass}/${results.length} passed`);
process.exit(pass === results.length ? 0 : 1);
