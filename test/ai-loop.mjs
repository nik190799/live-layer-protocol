// AI publishing loop, proven over real processes: tools/ai-publish.mjs talks to a local mock of the
// Claude Messages API (through the real Anthropic SDK backend), streams to a real headless host,
// and a person's answers are typed on stdin. A last part runs the built-in stub demo.
// Usage: node test/ai-loop.mjs
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const results = [];
const check = (name, cond, detail = "") => { results.push(!!cond); console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- layer variants the "model" will return ----------
const good = JSON.parse(readFileSync(join(ROOT, "ai/demo-replies.json"), "utf8"))[1].match(/```ts\n([\s\S]*?)```/)[1];
const withHeading = (h, src = good) => src.replace('heading("Tasks")', `heading("${h}")`);
const reply = (src, note = "Here is the change.") => `${note}\n\n\`\`\`ts\n${src}\`\`\`\n`;
const V = {
  compileError: good.replace('big(left.toString() + (left == 1 ? " task left" : " tasks left"));', 'big(left + " tasks left");'),
  trapOnClick: withHeading("Tasks 3").replace('setNum("tasks.n", 0);\n  }', 'unreachable();\n  }'),
  loopInView: withHeading("Tasks 3").replace("const left = n - done;", "const left = n - done;\n  let spin = 0; while (n >= 0) { spin++; }"),
  trapsWithMoreThan5: withHeading("Tasks 4").replace("const left = n - done;", "const left = n - done;\n  if (n > 5) unreachable();"),
};

// ---------- mock Claude Messages API ----------
const queue = [], requests = [];
const api = createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    const parsed = JSON.parse(body);
    requests.push({ url: req.url, headers: req.headers, body: parsed });
    const text = queue.shift() ?? "no reply queued";
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: `msg_${requests.length}`, type: "message", role: "assistant", model: parsed.model,
      content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 } }));
  });
});
await new Promise((r) => api.listen(0, r));
const apiUrl = `http://127.0.0.1:${api.address().port}`;

function proc(args, cwd, env = {}) {
  const e = { ...process.env, ...env };
  delete e.ANTHROPIC_AUTH_TOKEN;
  const p = spawn(process.execPath, args, { cwd, env: e, stdio: ["pipe", "pipe", "pipe"] });
  p.out = "";
  p.stdout.on("data", (d) => (p.out += d));
  p.stderr.on("data", (d) => (p.out += d));
  p.waitFor = async (re, from = 0, ms = 8000) => { const t = Date.now(); while (!re.test(p.out.slice(from))) { if (Date.now() - t > ms) return false; await sleep(20); } return true; };
  p.cmd = (line) => p.stdin.write(line + "\n");
  return p;
}
const lastFrame = (out) => { const parts = out.split("─".repeat(48)); return parts[parts.length - 2] || ""; };
const lastUserMsg = (r) => r.body.messages[r.body.messages.length - 1].content;

const work = mkdtempSync(join(tmpdir(), "llp-ai-"));
const pub = proc([join(ROOT, "tools/ai-publish.mjs"), "--port", "7792", "--backend", "claude", "--source", join(ROOT, "layers/tasks-as/app.ts"), `footer=${join(ROOT, "build/stats.wasm")}`],
  work, { ANTHROPIC_BASE_URL: apiUrl, ANTHROPIC_API_KEY: "test-key-not-real" });
await pub.waitFor(/streaming on/);
const host = proc([join(ROOT, "host/node-host.mjs"), "ws://localhost:7792", join(work, "keys/publisher.pub.json")], work);
await host.waitFor(/Tasks/);
host.cmd("set draft Buy milk"); host.cmd("click main add");
host.cmd("set draft Call mom"); host.cmd("click main add"); host.cmd("click main t:0");
await sleep(300);
check("A1 host is running the starting layer with state the person added", /\[x\] Buy milk/.test(lastFrame(host.out)) && /Call mom/.test(lastFrame(host.out)));

// ---- A2–A4: compile error goes back to the model, person approves, app updates with state kept ----
let mark = pub.out.length;
queue.push(reply(V.compileError), reply(good, "Fixed the string join."));
pub.cmd("show how many tasks are left and add a clear all button");
await pub.waitFor(/approve\?/, mark);
const r1 = requests[0], r2 = requests[1];
check("A2 request uses the real SDK path: claude-opus-5-5, key from env, refusal fallback, ABI system prompt, live source",
  r1 && r1.body.model === "claude-opus-5-5" && (r1.headers["x-api-key"] === "test-key-not-real" || r1.headers.authorization === "Bearer test-key-not-real") && r1.body.fallbacks === "default"
  && /stateless/.test(r1.body.system) && /llp_view/.test(lastUserMsg(r1)) && /show how many tasks are left/.test(lastUserMsg(r1)));
check("A3 compile error is fed back to the model and it retries", r2 && /failed to compile/.test(lastUserMsg(r2)) && /TS2365/.test(lastUserMsg(r2)) && /✗ compile/.test(pub.out.slice(mark)));
const hostMark = host.out.length;
pub.cmd("y");
await pub.waitFor(/LIVE v\d+/, mark);
await host.waitFor(/tasks left|task left/, hostMark);
let f = lastFrame(host.out);
check("A4 after one approval the running app shows the AI-written layer with the person's tasks kept",
  /1 task left/.test(f) && /\[x\] Buy milk/.test(f) && /Call mom/.test(f) && /Clear all/.test(f), (pub.out.slice(mark).match(/LIVE[^\n]*/) || [""])[0]);

// ---- A5: discarding streams nothing ----
mark = pub.out.length; let hm = host.out.length;
queue.push(reply(withHeading("Tasks NOPE")));
pub.cmd("rename the heading"); await pub.waitFor(/approve\?/, mark);
pub.cmd("n"); await pub.waitFor(/DISCARDED/, mark); await sleep(400);
check("A5 answering n streams nothing; the app is unchanged", /DISCARDED/.test(pub.out.slice(mark)) && !/NOPE/.test(host.out.slice(hm)) && !/LIVE/.test(pub.out.slice(mark)));

// ---- A6–A7: a layer that traps on click, then one that loops forever, are both caught before approval ----
mark = pub.out.length;
const before = requests.length;
queue.push(reply(V.trapOnClick), reply(V.loopInView), reply(withHeading("Tasks 3")));
pub.cmd("add a reset"); await pub.waitFor(/approve\?/, mark, 15000);
const fb = requests.slice(before).map(lastUserMsg);
check("A6 a layer that traps when its button is clicked fails the shadow check and the trap goes back to the model",
  /trapped while its buttons were clicked/.test(fb[1] || "") && /✗ check/.test(pub.out.slice(mark)));
check("A7 a layer with an infinite loop is stopped by the time limit and the model is told", /timed out after 3000 ms/.test(fb[2] || ""));
hm = host.out.length; pub.cmd("y"); await host.waitFor(/Tasks 3/, hm);
check("A8 the fixed version goes live and the publisher stayed responsive after the loop", /Tasks 3/.test(lastFrame(host.out)) && /Buy milk/.test(lastFrame(host.out)));

// ---- A9: the host's own check uses real state the shadow check didn't have; its refusal goes back too ----
for (const t of ["Eggs", "Bread", "Tea", "Rice"]) { host.cmd(`set draft ${t}`); host.cmd("click main add"); }
await sleep(400);
mark = pub.out.length; const b2 = requests.length;
queue.push(reply(V.trapsWithMoreThan5), reply(withHeading("Tasks 4")));
pub.cmd("rename the heading to Tasks 4"); await pub.waitFor(/approve\?/, mark);
pub.cmd("y"); await pub.waitFor(/✗ host/, mark); await pub.waitFor(/approve\?/, pub.out.indexOf("✗ host"));
const hostFb = lastUserMsg(requests[b2 + 1] || { body: { messages: [{ content: "" }] } });
hm = host.out.length; pub.cmd("y"); await host.waitFor(/Tasks 4/, hm);
f = lastFrame(host.out);
check("A9 host refuses a layer that traps on its real 6 tasks; the refusal goes to the model; the fix goes live with all 6 kept",
  /refused the layer/.test(hostFb) && /Tasks 4/.test(f) && ["Buy milk", "Call mom", "Eggs", "Bread", "Tea", "Rice"].every((t) => f.includes(t)));

// ---- A10: "r <change>" sends the reviewer's words back ----
mark = pub.out.length; const b3 = requests.length;
queue.push(reply(withHeading("Tasks 5")), reply(withHeading("Hello")));
pub.cmd("rename the heading"); await pub.waitFor(/approve\?/, mark);
pub.cmd("r make the heading say Hello"); await pub.waitFor(/approve\?[\s\S]*approve\?/, mark);
hm = host.out.length; pub.cmd("y"); await host.waitFor(/== Hello ==/, hm);
check("A10 revise sends the reviewer's words to the model and the revision goes live", /make the heading say Hello/.test(lastUserMsg(requests[b3 + 1])) && /== Hello ==/.test(lastFrame(host.out)));

// ---- A11: the loop gives up after max attempts and leaves the app alone ----
mark = pub.out.length; hm = host.out.length;
queue.push(...Array(4).fill(reply(V.compileError)));
pub.cmd("break it"); await pub.waitFor(/GAVE UP/, mark, 15000); await sleep(300);
check("A11 after 4 failed attempts it gives up and the running app is unchanged", /GAVE UP after 4/.test(pub.out.slice(mark)) && /== Hello ==/.test(lastFrame(host.out)) && host.out.length === hm);

pub.cmd("quit"); host.kill(); await sleep(200); pub.kill(); api.close();

// ---- A12: the built-in stub demo runs with no key at all ----
const work2 = mkdtempSync(join(tmpdir(), "llp-ai-stub-"));
const env2 = { ANTHROPIC_API_KEY: "" };
const demo = proc([join(ROOT, "tools/ai-publish.mjs"), "--port", "7793", "--source", join(ROOT, "layers/tasks-as/app.ts"), `footer=${join(ROOT, "build/stats.wasm")}`], work2, env2);
await demo.waitFor(/streaming on/);
const h2 = proc([join(ROOT, "host/node-host.mjs"), "ws://localhost:7793", join(work2, "keys/publisher.pub.json")], work2);
await h2.waitFor(/Tasks/);
h2.cmd("set draft Buy milk"); h2.cmd("click main add"); await sleep(200);
demo.cmd("anything"); await demo.waitFor(/approve\?/);
const h2m = h2.out.length; demo.cmd("y"); await h2.waitFor(/task left/, h2m);
check("A12 with no key the stub backend proves the same loop (compile error, retry, approve, live)",
  /stub/.test(demo.out) && /✗ compile/.test(demo.out) && /LIVE v\d+ after 2 attempt/.test(demo.out) && /1 task left/.test(lastFrame(h2.out)) && /Buy milk/.test(lastFrame(h2.out)),
  (demo.out.match(/time: [^\n]*/) || [""])[0]);
demo.kill(); h2.kill();

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} AI loop checks passed`);
process.exit(passed === results.length ? 0 : 1);
