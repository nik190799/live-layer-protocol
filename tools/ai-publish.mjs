// AI publishing loop: type what you want changed, a model writes the layer, it is compiled,
// shadow-checked against real-looking state, shown to you, and streamed live after you approve.
//
// Usage:
//   node tools/ai-publish.mjs [--port 7700] [--backend claude|stub] [--stub replies.json]
//        [--source layers/tasks-as/app.ts] [--slot main] [--max-attempts 4] [footer=build/stats.wasm ...]
// Then connect any Live Host, e.g.  node host/node-host.mjs ws://localhost:7700 keys/publisher.pub.json
//
// At the "ai>" prompt type a change. At "approve?" answer y (ship), n (discard) or r <what to change>.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { claudeBackend, stubBackend } from "../ai/backends.mjs";
import { compile, shadowCheck } from "../ai/check.mjs";
import { SYSTEM, extractCode, feedback, firstRequest, summaryOf } from "../ai/prompt.mjs";
import { StreamServer, loadKey } from "../ai/stream.mjs";

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const port = +opt("port", 7700);
const slot = opt("slot", "main");
const maxAttempts = +opt("max-attempts", 4);
const statics = Object.fromEntries(args.filter((a) => a.includes("=") && !a.startsWith("--")).map((a) => a.split("=")));
const order = [slot, ...Object.keys(statics)];
const WORK = ".ai-live";
mkdirSync(join(WORK, "attempts"), { recursive: true });

// ---- model backend ----
const hasKey = !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
const which = opt("backend", hasKey ? "claude" : "stub");
const backend = which === "claude" ? await claudeBackend()
  : stubBackend(opt("stub", new URL("../ai/demo-replies.json", import.meta.url).pathname));
console.log(`model backend: ${backend.name}`);
if (which === "stub" && !hasKey) console.log("  (no ANTHROPIC_API_KEY set; set one to use Claude instead)");

// ---- starting point ----
const current = join(WORK, "current.ts");
let source = existsSync(current) && !args.includes("--fresh")
  ? readFileSync(current, "utf8")
  : readFileSync(opt("source", "layers/tasks-as/app.ts"), "utf8").replace(/from\s+"[^"]*sdk\/assemblyscript\/llp"/, 'from "./llp"');
const first = await compile(source, join(WORK, "attempts"), "base");
if (!first.ok) { console.error("starting layer does not compile:\n" + first.error); process.exit(1); }
let liveBytes = first.bytes;
writeFileSync(current, source);
const staticBytes = Object.fromEntries(Object.entries(statics).map(([s, f]) => [s, new Uint8Array(readFileSync(f))]));

const { privateKey } = await loadKey("keys");
const server = new StreamServer({ port, privateKey });
await server.ready;
await server.publish({ [slot]: liveBytes, ...staticBytes }, order);
console.log(`streaming on ws://localhost:${port}; hosts trust keys/publisher.pub.json`);

// ---- terminal I/O ----
const rl = createInterface({ input: process.stdin, terminal: false });
const lines = rl[Symbol.asyncIterator]();
async function ask(q) { process.stdout.write(q); const r = await lines.next(); if (r.done) process.exit(0); return r.value.trim(); }

function draw(node, depth = 0) {
  const pad = "  ".repeat(depth);
  if (node.k === "text") return [pad + node.t];
  const a = node.a || {};
  const label = (node.c || []).filter((c) => c.k === "text").map((c) => c.t).join(" ");
  switch (node.k) {
    case "button": return [`${pad}[ ${label} ]`];
    case "toggle": return [`${pad}${a.on === "1" ? "[x]" : "[ ]"} ${label}`];
    case "input": return [`${pad}<${a.placeholder}>`];
    case "progress": return [`${pad}${"█".repeat(Math.round(+a.value / 10)).padEnd(10, "░")} ${a.value}%`];
    case "heading": return [`${pad}== ${label} ==`];
    default: return (node.c || []).flatMap((c) => draw(c, node.k === "row" ? depth + 1 : depth));
  }
}

function diff(a, b) {
  const x = a.split("\n"), y = b.split("\n");
  const L = Array.from({ length: x.length + 1 }, () => new Int32Array(y.length + 1));
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const ops = []; let i = 0, j = 0;
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) { ops.push([" ", x[i]]); i++; j++; }
    else if (i < x.length && (j === y.length || L[i + 1][j] >= L[i][j + 1])) ops.push(["-", x[i++]]);
    else ops.push(["+", y[j++]]);
  }
  const keep = ops.map((o, k) => o[0] !== " " || ops.slice(Math.max(0, k - 2), k + 3).some((p) => p[0] !== " "));
  const out = []; let gap = false;
  ops.forEach((o, k) => { if (keep[k]) { out.push(`${o[0]} ${o[1]}`); gap = false; } else if (!gap) { out.push("  ..."); gap = true; } });
  return out.join("\n");
}

// ---- the loop ----
let seq = 0;
async function change(prompt) {
  const t0 = performance.now();
  const times = { model: 0, compile: 0, check: 0, approval: 0, stream: 0 };
  const messages = [{ role: "user", content: firstRequest(prompt, source) }];
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const name = String(++seq).padStart(3, "0");
    console.log(`\n· attempt ${attempt}/${maxAttempts}: asking ${backend.name}…`);
    let t = performance.now(), reply;
    try { reply = await backend.generate({ system: SYSTEM, messages }); }
    catch (e) { console.log(`  model call failed: ${e.message}`); return log({ prompt, outcome: "model-error", error: e.message }); }
    times.model += performance.now() - t;
    messages.push({ role: "assistant", content: reply });
    const retry = (stage, detail) => { console.log(`  ✗ ${stage}: ${detail.split("\n")[0]}`); messages.push({ role: "user", content: feedback(stage, detail) }); };

    const code = extractCode(reply);
    if (!code) { retry("format", "no ```ts block"); continue; }

    t = performance.now();
    const built = await compile(code, join(WORK, "attempts"), name);
    times.compile += performance.now() - t;
    if (!built.ok) { retry("compile", built.error); continue; }
    console.log(`  ✓ compiled (${built.bytes.length} bytes)`);

    t = performance.now();
    const chk = await shadowCheck({ base: { [slot]: liveBytes, ...staticBytes }, order, candidate: { slot, bytes: built.bytes } });
    times.check += performance.now() - t;
    if (!chk.ok) { retry("check", chk.error); continue; }
    console.log(`  ✓ shadow check passed (state built by using the live app: ${chk.stateKeys} keys; every button clicked)`);

    console.log(`\n${summaryOf(reply) || "(no summary)"}\n\n--- diff ---\n${diff(source, code)}\n\n--- preview (sample data) ---`);
    for (const s of chk.preview) console.log(draw(s.tree).join("\n"));
    t = performance.now();
    const answer = await ask("\napprove? [y] ship  [n] discard  [r <change>] revise: ");
    times.approval += performance.now() - t;
    if (answer === "n") { console.log("DISCARDED: nothing was streamed"); return log({ prompt, outcome: "discarded", attempt }); }
    if (answer.startsWith("r")) { retry("revise", answer.slice(1).trim() || "Please improve it."); continue; }
    if (answer !== "y") { console.log("  (treating anything but y as n)"); console.log("DISCARDED: nothing was streamed"); return log({ prompt, outcome: "discarded", attempt }); }

    t = performance.now();
    const r = await server.publish({ [slot]: built.bytes, ...staticBytes }, order);
    times.stream += performance.now() - t;
    if (r.t === "nack") { retry("host", r.reason); continue; }
    if (r.t === "timeout") { console.log("  host did not answer in time; not marking it live"); return log({ prompt, outcome: "timeout" }); }

    source = code; liveBytes = built.bytes; writeFileSync(current, source);
    const total = performance.now() - t0, ms = (n) => Math.round(n);
    const where = r.t === "ack" ? `host swapped in ${r.ms} ms` : "no host connected yet; it gets this version when it connects";
    console.log(`LIVE v${r.version} after ${attempt} attempt(s): ${where}`);
    console.log(`  time: total ${ms(total)} ms = model ${ms(times.model)} + compile ${ms(times.compile)} + check ${ms(times.check)} + your approval ${ms(times.approval)} + stream ${ms(times.stream)}`);
    return log({ prompt, outcome: "live", attempt, version: r.version, times, total });
  }
  console.log(`GAVE UP after ${maxAttempts} attempts; the live app was not changed`);
  return log({ prompt, outcome: "gave-up" });
}
function log(entry) { appendFileSync(join(WORK, "history.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n"); return entry; }

while (true) {
  const prompt = await ask("\nai> ");
  if (!prompt) continue;
  if (prompt === "quit" || prompt === "exit") break;
  await change(prompt);
}
server.close();
process.exit(0);
