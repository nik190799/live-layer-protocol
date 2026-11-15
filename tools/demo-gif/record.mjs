// Records the launch demo GIF from a real run. Nothing on screen is mocked:
// - the AI publisher is the real tools/ai-publish.mjs (handoff backend: the model's replies are read
//   from files, so no API key is needed; the replies in tools/demo-gif/replies/ were written by Claude),
// - the phone is a real Live Host (host/llp-core.js) in Chromium, connected to it over WebSocket,
// - every number in a caption is parsed from the publisher's output or the host's own swap result.
// The second reply has an off-by-one planted on purpose (a StaticArray read past its end), so the
// shadow check has something real to catch; its error goes back to the model like any other.
//
// Usage: node tools/demo-gif/record.mjs [--out docs/demo] [--keep-video]
// Needs Playwright with Chromium and ffmpeg on PATH. Writes <out>.gif and <out>.mp4, plus
// <out>-run.json with the measured numbers and the publisher's full output.
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync, renameSync, existsSync, readdirSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { createRequire } from "node:module";
const { chromium } = createRequire(import.meta.url)("playwright");

const root = new URL("../..", import.meta.url).pathname;
const here = new URL(".", import.meta.url).pathname;
const args = process.argv.slice(2);
const out = resolve(root, args.includes("--out") ? args[args.indexOf("--out") + 1] : "docs/demo");
const port = 7790 + Math.floor(Math.random() * 100);
const work = mkdtempSync(join(tmpdir(), "llp-gif-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the real AI publisher ----
const pub = spawn(process.execPath, [join(root, "tools/ai-publish.mjs"), "--backend", "handoff", "--handoff-dir", join(work, "handoff"),
  "--source", join(root, "layers/tasks-as/app.ts"), "--fresh", "--port", String(port), `footer=${join(root, "build/stats.wasm")}`], { cwd: work });
let output = "", seen = 0;
pub.stdout.on("data", (d) => { output += d; if (process.env.DEBUG) process.stdout.write(d); });
pub.stderr.on("data", (d) => { output += d; process.stderr.write(d); });
const say = (line) => pub.stdin.write(line + "\n");
async function until(re, ms = 60000) { // wait for publisher output (after what was already consumed) to match
  const t = Date.now();
  while (Date.now() - t < ms) { const m = re.exec(output.slice(seen)); if (m) { seen += m.index + m[0].length; return m; } await sleep(30); }
  throw new Error(`timed out waiting for ${re}\n--- publisher output ---\n${output}`);
}
async function answerModel(n, replyFile, mustContain) { // play the model through the handoff files
  const req = join(work, "handoff", `${String(n).padStart(3, "0")}.request.md`);
  while (!existsSync(req)) await sleep(30);
  await sleep(50);
  if (mustContain && !mustContain.test(readFileSync(req, "utf8"))) throw new Error(`request ${n} does not contain ${mustContain}`);
  const dst = join(work, "handoff", `${String(n).padStart(3, "0")}.reply.md`);
  writeFileSync(dst + ".tmp", readFileSync(join(here, "replies", replyFile)));
  renameSync(dst + ".tmp", dst);
}
await until(/streaming on ws:\/\/localhost:\d+/);

// ---- static server for the stage page and host core ----
const types = { js: "text/javascript", mjs: "text/javascript", html: "text/html", json: "application/json" };
const server = createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  try {
    const b = u.pathname === "/key" ? readFileSync(join(work, "keys/publisher.pub.json"))
      : u.pathname === "/" ? readFileSync(join(here, "stage.html")) : readFileSync(join(root, u.pathname.slice(1)));
    res.setHeader("content-type", u.pathname === "/" ? "text/html" : types[u.pathname.split(".").pop()] ?? "application/json"); res.end(b);
  } catch { res.statusCode = 404; res.end(); }
}).listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));

const videoDir = join(work, "video");
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, recordVideo: { dir: videoDir, size: { width: 1280, height: 720 } } });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.error("[page]", e.message));
const t0 = Date.now();
const marks = [];
const mark = (name) => marks.push({ name, at: (Date.now() - t0) / 1000 });
await page.goto(`http://127.0.0.1:${server.address().port}/?port=${port}`);
await page.waitForFunction(() => window.stage?.swaps.length === 1, null, { timeout: 30000 });

const S = (fn, ...a) => page.evaluate(([f, a]) => window.stage[f](...a), [fn, a]);
const cap = (step, title, sub) => S("caption", step, title, sub);
const line = (t, cls) => page.evaluate(([t, c]) => { window.stage.line(t, c); }, [t, cls]);
async function typeLine(prefix, text, cls = "you") { // type into the terminal pane, then send to the publisher
  await page.evaluate(([p, c]) => { window.__l = window.stage.line(p, c); window.stage.cursor(window.__l, true); }, [prefix, cls]);
  for (let i = 1; i <= text.length; i++) { await page.evaluate(([s]) => window.stage.edit(window.__l, s), [prefix + text.slice(0, i)]); await sleep(32); }
  await sleep(250);
  await page.evaluate(() => window.stage.cursor(window.__l, false));
  say(text);
}
// Copy what the publisher printed into the terminal pane: progress lines only (the diff and the
// sample preview are long; the full output is saved in <out>-run.json).
let shown = 0;
function pump() {
  const lines = output.split("\n"), done = output.endsWith("\n") ? lines.length - 1 : lines.length - 1;
  const outLines = [];
  for (; shown < done; shown++) {
    const l = lines[shown];
    if (/^· attempt/.test(l)) outLines.push([l.replace(/asking handoff.*$/, "asking the model…"), "dim"]);
    else if (/^\s+✓/.test(l)) outLines.push([l.trim().replace(/ \(state built.*$/, ": every button clicked"), "ok"]);
    else if (/^\s+✗/.test(l)) outLines.push([l.trim(), "bad"]);
    else if (/^the model says:/.test(l)) outLines.push([l.slice(0, 90) + (l.length > 90 ? "…" : ""), "dim"]);
    else if (/^LIVE /.test(l)) outLines.push([l, "live"]);
    else if (/^\s+time:/.test(l)) { const m = /compile (\d+) \+ check (\d+) .*stream (\d+)/.exec(l); if (m) outLines.push([`  compile ${m[1]} ms · check ${m[2]} ms · stream ${m[3]} ms`, "dim"]); }
  }
  return outLines;
}
async function flush() { for (const [t, c] of pump()) { await line(t, c); await sleep(120); } }
const pumpTimer = setInterval(() => {}, 1000);

// ---- scene 0: the app is running and in use ----
mark("intro");
await cap("Live Layer Protocol", "A running app. No CI/CD, no restart.", "Real run: AI publisher on the left, a Live Host in Chromium on the right.");
await line("$ node tools/ai-publish.mjs --backend handoff", "dim");
await line(`streaming on ws://localhost:${port}`, "dim");
await sleep(1500);
for (const t of ["Buy milk", "Call mom", "Ship the demo"]) {
  await page.click("#in-draft"); await page.keyboard.type(t, { delay: 45 }); await page.keyboard.press("Enter"); await sleep(250);
}
await page.click('[data-id="t:0"]');
await sleep(1800);

// ---- scene 1: a good change ----
mark("ask-1");
await cap("1 · Ask the AI", "“Add a progress bar and how many are left”", "The app keeps running while the AI writes the change.");
await typeLine("ai> ", "add a progress bar and how many tasks are left");
await answerModel(1, "1-progress.md");
await until(/approve\?/); await flush();
await line("approve? y", "you"); await sleep(500); say("y");
const live1 = await until(/LIVE v\d+ after (\d+) attempt\(s\): host swapped in ([\d.]+) ms\n\s+time: total \d+ ms = model \d+ \+ compile (\d+) \+ check (\d+)/);
await flush();
const swap1 = await page.evaluate(() => window.stage.swaps.at(-1));
mark("live-1");
await cap("1 · Live", `<em>Live in ${fmt(swap1.ms)} ms.</em> Same process, all ${swap1.tasks} tasks kept.`, `Compiled in ${live1[3]} ms, shadow-checked in ${live1[4]} ms, signed, streamed, hot-swapped.`);
await sleep(2600);
await page.click('[data-id="t:1"]'); await sleep(2400);

// ---- scene 2: a bad change is caught ----
mark("ask-2");
await cap("2 · A buggy change", "“Add a Delete button on each task”", "This time the AI's code has an off-by-one bug.");
await typeLine("ai> ", "add a delete button on each task");
await answerModel(2, "2-delete-bad.md");
const caught = await until(/✗ check: (.*)/);
await flush();
await S("held");
const stateHeld = await page.evaluate(() => window.stage.state());
mark("caught");
await cap("2 · Caught", "<s>Crash caught before it shipped.</s> The app never saw it.", "The shadow check clicked every button on a copy of the live state; Delete trapped.");
await sleep(4000);
await answerModel(3, "3-delete-fixed.md", /trapped/);
mark("retry");
await cap("2 · Fixed", "The error went back to the AI. It fixed it.", "Same checks again, then you approve.");
await until(/approve\?/); await flush(); await sleep(1500);
await line("approve? y", "you"); await sleep(500); say("y");
const live2 = await until(/LIVE v\d+ after (\d+) attempt\(s\): host swapped in ([\d.]+) ms/);
await flush();
const swap2 = await page.evaluate(() => window.stage.swaps.at(-1));
mark("live-2");
await cap("2 · Live", `<em>Fix live in ${fmt(swap2.ms)} ms.</em> Still the same running app.`, `${swap2.tasks} tasks kept. Only checked code ever reaches it.`);
await sleep(2400);
await page.click('[data-id="del:2"]'); await sleep(2400);
const finalState = await page.evaluate(() => window.stage.state());

// ---- end card ----
mark("end");
await S("end", `<h1>Change a running app<br><em>in milliseconds.</em></h1><ul>
<li>AI change live in <b>${fmt(swap1.ms)} ms</b>, data kept, no restart</li>
<li>Buggy change <b>caught</b> before it shipped</li>
<li>Every layer signed, sandboxed, and rolled back on failure</li></ul>
<div class="repo">Live Layer Protocol · github.com/nik190799/live-layer-protocol</div>`);
await sleep(4500);
mark("done");
clearInterval(pumpTimer);
const video = await page.video().path();
await ctx.close(); await browser.close(); server.close(); say("quit");
function fmt(ms) { return ms < 10 ? ms.toFixed(1) : String(Math.round(ms)); }

// ---- checks: prove the run showed what the captions claim ----
const fail = [];
if (swap1.tasks !== 3) fail.push(`scene 1 kept ${swap1.tasks} tasks, expected 3`);
if (!/trapped/.test(caught[1])) fail.push(`scene 2 was not caught as a trap: ${caught[1]}`);
if (stateHeld.build !== 2) fail.push(`the buggy layer reached the app (build ${stateHeld.build})`);
if (live2[1] !== "2") fail.push(`fix took ${live2[1]} attempts, expected 2`);
if (finalState.n !== 2) fail.push(`after Delete the app has ${finalState.n} tasks, expected 2`);
if (fail.length) { console.error("RUN DID NOT SHOW WHAT THE CAPTIONS SAY:\n" + fail.join("\n")); process.exit(1); }

// ---- video -> gif + mp4 ----
mkdirSync(dirname(out), { recursive: true });
const ff = (a) => execFileSync("ffmpeg", ["-v", "error", "-y", ...a], { stdio: "inherit" });
const trim = ["-ss", String(Math.max(0, marks[0].at - 0.2))];
ff([...trim, "-i", video, "-vf", "fps=30,scale=1280:-2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", "-movflags", "+faststart", out + ".mp4"]);
ff([...trim, "-i", video, "-vf", "fps=10,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle", out + ".gif"]);
writeFileSync(out + "-run.json", JSON.stringify({ recordedAt: new Date().toISOString(), swaps: [swap1, swap2],
  scene1: { attempts: +live1[1], hostSwapMs: +live1[2], compileMs: +live1[3], checkMs: +live1[4] },
  scene2: { caught: caught[1], appBuildWhileCaught: stateHeld.build, fixAttempts: +live2[1], hostSwapMs: +live2[2] },
  final: finalState, timeline: marks, publisherOutput: output }, null, 2) + "\n");
if (args.includes("--keep-video")) console.log("raw video:", video); else rmSync(work, { recursive: true, force: true });
console.log(`wrote ${out}.gif, ${out}.mp4, ${out}-run.json (${Math.round(marks.at(-1).at - marks[0].at)} s)`);
process.exit(0);
