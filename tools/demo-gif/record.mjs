// Records the launch demo GIF: the same two AI changes shipped two ways, side by side, both for real.
// Today (left): tools/demo-gif/today-app, a plain JS app on a Node server. A change is committed, pushed
//   to GitHub, tested by GitHub Actions (.github/workflows/today-demo.yml), then deployed by restarting
//   the server; the open page notices and reloads (today-pipeline.mjs). With --ci local the same tests
//   run in a fresh clone on this machine instead.
// With LLP (right): the real tools/ai-publish.mjs (handoff backend: the model's replies are read from
//   files, so no API key is needed) streaming to a real Live Host (host/llp-core.js) in Chromium.
// The AI's replies were written by Claude, for both sides (replies/ for LLP, today-app/versions/ for
// today). The Delete change has the same off-by-one planted on both sides on purpose. Both are approved
// at once, so neither clock includes a person's review time. Clocks are real; long waits are sped up in
// the video and the page says so while they are.
//
// Usage: node tools/demo-gif/record.mjs [--out docs/demo] [--ci github|local] [--keep-video]
// Needs Playwright with Chromium and ffmpeg on PATH; --ci github (the default) also needs push access to
// origin and the gh CLI signed in. It force-pushes one branch, demo-today/recording, for each change.
// Writes <out>.gif, <out>.mp4 and <out>-run.json (every measured number and the publisher's output).
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync, renameSync, existsSync, readdirSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { TodayPipeline } from "./today-pipeline.mjs";
import { createRequire } from "node:module";
const { chromium } = createRequire(import.meta.url)("playwright");

const root = new URL("../..", import.meta.url).pathname;
const here = new URL(".", import.meta.url).pathname;
const args = process.argv.slice(2);
const out = resolve(root, args.includes("--out") ? args[args.indexOf("--out") + 1] : "docs/demo");
const port = 7790 + Math.floor(Math.random() * 100);
const todayPort = 7900 + Math.floor(Math.random() * 100);
const ciMode = args.includes("--ci") ? args[args.indexOf("--ci") + 1] : "github";
const SPEED = 20; // how much the long waits are sped up in the video
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

const TASKS = [["Buy milk", 1], ["Call mom", 0], ["Ship the demo", 0]];
const marks = [], fast = [];
const t0 = Date.now();
const mark = (name) => { marks.push({ name, at: (Date.now() - t0) / 1000 }); if (process.env.DEBUG) console.log("MARK", name); };
let page, S;
const todayStep = { cur: null };
const today = new TodayPipeline({ root, work, ci: ciMode, port: todayPort, tasks: TASKS, onStep: (name, d) => todayStep.cb?.(name, d) });
await today.init();

const videoDir = join(work, "video");
const browser = await chromium.launch();
// 4:5 for phone feeds; rendered at 1.5x so the MP4 is 1080x1350.
const ctx = await browser.newContext({ viewport: { width: 720, height: 900 }, deviceScaleFactor: 1.5, recordVideo: { dir: videoDir, size: { width: 1080, height: 1350 } } });
page = await ctx.newPage();
page.on("pageerror", (e) => console.error("[page]", e.message));
const tv = Date.now(); // video time zero (close enough: the context starts recording on the first page)
const vt = () => (Date.now() - tv) / 1000;
await page.goto(`http://127.0.0.1:${server.address().port}/?port=${port}&today=${encodeURIComponent(`http://127.0.0.1:${todayPort}/`)}&tasks=${encodeURIComponent(JSON.stringify(TASKS))}`);
await page.waitForFunction(() => window.stage?.ready(), null, { timeout: 30000 });
const frame = page.frameLocator("#today");
await frame.locator("#draft").waitFor();
S = (fn, ...a) => page.evaluate(([f, a]) => window.stage[f](...a), [fn, a]);
await S("how", ciMode === "github" ? "git push → GitHub Actions tests → server restart" : "git commit → tests → server restart");
const fmtS = (ms) => ms < 10000 ? `${(ms / 1000).toFixed(1)} s` : ms < 60000 ? `${Math.floor(ms / 1000)} s` : `${Math.floor(ms / 60000)} min ${Math.floor(ms / 1000) % 60} s`;
async function ask(text) {
  await S("ask", ""); await S("typing", true);
  for (let i = 1; i <= text.length; i++) { await S("ask", text.slice(0, i)); await sleep(36); }
  await sleep(200); await S("typing", false);
}
const FF = `⏩ ×${SPEED}`;
async function fastForward(untilDone) { // speed up the video while only the today side is waiting
  const a = vt(); await S("foot", `⏩ Video sped up ×${SPEED} while CI runs. Clocks show real time.`);
  const r = await untilDone; await S("foot", "Real recording of both sides. Clocks show real time."); fast.push([a, vt()]); return r;
}
async function waitTodayReload(before) {
  while ((await page.evaluate(() => window.stage.todayLoads())) <= before) await sleep(20);
  const at = Date.now();
  await frame.locator("#app .u-heading").waitFor();
  return at;
}
let stepChain = Promise.resolve(); // pipeline events are shown in the order they happened
let ciLabel = "Waiting for CI tests…";
function todayStatus() {
  todayStep.cb = (name) => (stepChain = stepChain.then(async () => {
    try {
      if (name === "commit") await S("status", "t", "Pushing to GitHub…", "act");
      if (name === "ci") await S("status", "t", ciLabel, "act", FF);
      if (name === "ci-failed") await S("status", "t", "CI failed", "bad");
      if (name === "deploy") await S("status", "t", "Restarting the server…", "act");
    } catch {}
  }));
}
const settled = () => stepChain;

// The LLP side of one request: returns when the change is live on the device.
async function llpChange(prompt, replies) {
  say(prompt);
  await S("status", "l", "AI writing the change…", "act");
  const r = { blocked: null };
  await answerModel(replies.n, replies.first);
  await until(/✓ compiled/); await S("status", "l", "Safety check: trying every button…", "act");
  const res = await until(/✓ shadow check passed|✗ check: (.*)/);
  if (res[1] !== undefined) {
    r.blocked = { reason: res[1], at: Date.now(), state: await page.evaluate(() => window.stage.llpState()) };
    await S("status", "l", "Crashed in the check. Blocked.", "bad");
    await S("phone", "l", "held"); await S("stamp", "l", "BLOCKED", "no user ever got this bug", "warn");
    await answerModel(replies.n + 1, replies.fix, /trapped/); // the crash goes back to the AI at once
    await until(/✓ shadow check passed/);
  }
  await until(/approve\?/); say("y");
  const live = await until(/LIVE v\d+ after (\d+) attempt\(s\): host swapped in ([\d.]+) ms\n\s+time: total \d+ ms = model \d+ \+ compile (\d+) \+ check (\d+)/);
  await page.waitForFunction((b) => window.stage.llpState().build > b, r.blocked ? 2 : 1, { timeout: 10000 });
  const sw = await page.evaluate(() => window.stage.swaps.at(-1));
  Object.assign(r, { swap: sw, liveAt: sw.at, attempts: +live[1], compileMs: +live[3], checkMs: +live[4] });
  return r;
}

// ================= clip 1: the same change, shipped two ways =================
mark("clip1");
await S("title", "Same app. Same AI change.<br>Which one ships first?", "LLP streams new code into an app while it runs.");
await sleep(1200);
await S("chip", "t", "unsaved text"); await S("chip", "l", "unsaved text");
await page.click("#in-draft"); await page.keyboard.type("Call the ba", { delay: 45 });
await frame.locator("#draft").click(); await frame.locator("#draft").pressSequentially("Call the ba", { delay: 45 });
await sleep(900);
await S("title", "Same app. Same AI change.");
await ask("Add a progress bar");
const s1 = Date.now();
await S("clockStart", "t", s1); await S("clockStart", "l", s1);
todayStatus();
const loads1 = await page.evaluate(() => window.stage.todayLoads());
const today1 = today.ship("app-v2.js", "AI: add a progress bar");
const llp1 = await llpChange("add a progress bar", { n: 1, first: "1-progress.md" });
await S("clockStop", "l", llp1.liveAt, "to go live");
await S("status", "l", "Live. No restart.", "ok");
await S("phone", "l", "live"); await S("chip", "l", "unsaved text: KEPT", "kept");
mark("llp-live-1");
await sleep(1800);
const t1 = await fastForward(today1); await settled();
if (!t1.ci.ok) throw new Error("today CI failed on the good change: " + JSON.stringify(t1.ci));
await S("status", "t", "Page reloading…", "act");
const reload1 = await waitTodayReload(loads1);
const draftAfter1 = await frame.locator("#draft").inputValue();
await S("clockStop", "t", reload1, "to go live");
await S("status", "t", "Live, after a restart and reload.", "warn");
await S("phone", "t", "live"); await S("chip", "t", draftAfter1 ? "unsaved text: kept" : "unsaved text: LOST", draftAfter1 ? "kept" : "lost");
mark("today-live-1");
await sleep(3000);
await S("card", `<div class="k">SAME CHANGE, MEASURED</div><div class="vs">
<div class="t"><span>TODAY</span><b>${fmtS(reload1 - s1)}</b></div>
<div class="l"><span>LLP</span><b>${fmtS(llp1.liveAt - s1)}</b></div></div>
<p>${draftAfter1 ? "Both kept the user's typing." : "Today's restart wiped what the user was typing. LLP kept it."}</p>`);
await sleep(3200);
mark("clip1-end");

// ================= clip 2: the AI writes a bug =================
mark("clip2");
await S("card", null);
for (const x of ["t", "l"]) { await S("phone", x, ""); await S("chip", x, null); await S("clockReset", x); await S("status", x, ""); }
await S("ask", null);
await S("title", "Now the AI writes a bug.", "Same buggy change, sent to both at once.");
await sleep(1600);
await S("title", "Now the AI writes a bug.");
await ask("Add a Delete button");
const s2 = Date.now();
await S("clockStart", "t", s2); await S("clockStart", "l", s2);
todayStatus();
const loads2 = await page.evaluate(() => window.stage.todayLoads());
const today2 = today.ship("app-v3.js", "AI: add a Delete button");
const llp2 = await llpChange("add a delete button on each task", { n: 2, first: "2-delete-bad.md", fix: "3-delete-fixed.md" });
await S("clockStop", "l", llp2.liveAt, "to block it and ship the fix");
mark("llp-live-2");
await sleep(1500); // keep the BLOCKED stamp on screen a moment (after the clock stopped)
await S("stamp", "l", null); await S("phone", "l", "live");
await S("status", "l", "AI fixed it. Fix is live.", "ok");
await page.click('#screen [data-id="del:2"]');
await sleep(1200);
const t2 = await fastForward(today2); await settled();
if (!t2.ci.ok) throw new Error("today CI failed on the Delete change (it should pass: no test covers Delete): " + JSON.stringify(t2.ci));
await S("status", "t", "Page reloading…", "act");
const reload2 = await waitTodayReload(loads2);
await S("status", "t", "Tests passed. Bug is live.", "warn");
await sleep(900);
await frame.locator('.del[data-i="0"]').click();
await frame.locator("#crash").waitFor({ state: "visible", timeout: 5000 });
const crashAt = Date.now();
mark("today-crash");
await S("phone", "t", "broken"); await S("stamp", "t", "BROKEN", "a user hit the bug", "bad");
await S("clockStart", "t", crashAt, "broken for users");
await S("status", "t", "Rolling back: CI again…", "bad");
await sleep(1800);
const loads3 = await page.evaluate(() => window.stage.todayLoads());
ciLabel = "Rolling back: CI again…";
todayStatus();
const t3 = await fastForward(today.ship("app-v2.js", "Revert: the Delete button crashes")); await settled();
const reload3 = await waitTodayReload(loads3);
await S("stamp", "t", null);
await S("clockStop", "t", reload3, "broken for users");
await S("status", "t", "Rolled back. Working again.", "warn"); await S("phone", "t", "");
mark("today-back");
await sleep(2600);
const llpFinal = await page.evaluate(() => window.stage.llpState());
await S("card", `<div class="k">SAME BUG, MEASURED</div><div class="vs">
<div class="t"><span>TODAY</span><b>broken ${fmtS(reload3 - crashAt)}</b></div>
<div class="l"><span>LLP</span><b>never shipped</b></div></div>
<p>LLP tried every button before release and caught it. The fix was live in ${fmtS(llp2.liveAt - s2)}.</p>`);
await sleep(3200);
mark("clip2-end");

// ================= closing card (combined video only) =================
mark("close");
await S("card", `<div class="k">LIVE LAYER PROTOCOL</div><p style="margin:0;font:800 50px/1.08 'Inter Display',Inter,sans-serif;color:#f2f5fa">Ship AI changes <span style="color:#3ddc97">live</span>, without shipping its bugs.</p>
<p>${fmtS(llp1.liveAt - s1)} vs ${fmtS(reload1 - s1)}.<br>Bug blocked vs broken for ${fmtS(reload3 - crashAt)}.</p>
<div class="src">Both sides measured in this recording. Today: ${ciMode === "github" ? "GitHub Actions" : "tests on this machine"} + server restart.</div>`);
await sleep(3500);
mark("done");
const video = await page.video().path();
await ctx.close(); await browser.close(); server.close(); say("quit"); await today.close();

// ---- checks: prove the run showed what the captions claim ----
const fail = [];
if (llp1.swap.tasks !== 3 || llp1.swap.draft !== "Call the ba") fail.push(`LLP scene 1: tasks ${llp1.swap.tasks}, draft "${llp1.swap.draft}"`);
if (draftAfter1 !== "") fail.push(`today's draft survived the reload ("${draftAfter1}"), so the caption would be wrong`);
if (!/trapped/.test(llp2.blocked?.reason ?? "")) fail.push(`LLP did not block the bug as a trap: ${llp2.blocked?.reason}`);
if (llp2.blocked?.state.build !== 2) fail.push(`the buggy layer reached the LLP device (build ${llp2.blocked?.state.build})`);
if (llp2.attempts !== 2) fail.push(`LLP fix took ${llp2.attempts} attempts, expected 2`);
if (llpFinal.n !== 2) fail.push(`after Delete the LLP app has ${llpFinal.n} tasks, expected 2`);
if (!(reload1 - s1 > llp1.liveAt - s1)) fail.push("today was faster than LLP on the good change; the captions say otherwise");
if (fail.length) { console.error("RUN DID NOT SHOW WHAT THE CAPTIONS SAY:\n" + fail.join("\n")); process.exit(1); }
const result = {
  ci: ciMode,
  scene1: { llpMs: llp1.liveAt - s1, llpSwapMs: llp1.swap.ms, compileMs: llp1.compileMs, checkMs: llp1.checkMs, todayMs: reload1 - s1, todayCi: t1.ci, todayDowntimeMs: t1.downtime, todayDraftAfter: draftAfter1 },
  scene2: { llpBlocked: llp2.blocked.reason, llpFixLiveMs: llp2.liveAt - s2, todayBugLiveMs: reload2 - s2, todayBrokenMs: reload3 - crashAt, todayCi: t2.ci, rollbackCi: t3.ci },
};
// ---- video -> three cuts (clip 1, clip 2, both), with the CI waits sped up ----
mkdirSync(dirname(out), { recursive: true });
const ff = (a) => execFileSync("ffmpeg", ["-v", "error", "-y", ...a], { stdio: "inherit" });
const at = (name) => (marks.find((m) => m.name === name).at * 1000 - (tv - t0)) / 1000;
function render(from, to, base) {
  const segs = []; let p = from;
  for (const [a, b] of fast) { if (b <= from || a >= to) continue; if (a > p) segs.push([p, a, 1]); segs.push([Math.max(a, p), Math.min(b, to), SPEED]); p = Math.min(b, to); }
  if (to > p) segs.push([p, to, 1]);
  const parts = segs.map(([a, b, k], i) => `[0:v]trim=${a.toFixed(3)}:${b.toFixed(3)},setpts=(PTS-STARTPTS)/${k}[s${i}]`).join(";");
  const mid = join(work, "cut.mp4");
  ff(["-i", video, "-filter_complex", `${parts};${segs.map((_, i) => `[s${i}]`).join("")}concat=n=${segs.length}:v=1:a=0[v]`, "-map", "[v]", "-r", "30", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "17", mid]);
  ff(["-i", mid, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", "-movflags", "+faststart", base + ".mp4"]);
  ff(["-i", mid, "-vf", "fps=10,scale=600:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle", base + ".gif"]);
  return Math.round(segs.reduce((n, [a, b, k]) => n + (b - a) / k, 0));
}
const lengths = {
  clip1: render(Math.max(0, at("clip1") - 0.2), at("clip1-end"), out + "-1-speed"),
  clip2: render(at("clip2"), at("clip2-end"), out + "-2-bug"),
  both: render(Math.max(0, at("clip1") - 0.2), at("done"), out),
};
writeFileSync(out + "-run.json", JSON.stringify({ recordedAt: new Date().toISOString(), ...result, speedUp: { factor: SPEED, segments: fast }, lengths, timeline: marks, publisherOutput: output }, null, 2) + "\n");
if (args.includes("--keep-video")) console.log("raw video:", video); else rmSync(work, { recursive: true, force: true });
console.log(`wrote ${out}{,-1-speed,-2-bug}.{gif,mp4} and ${out}-run.json; seconds: ${JSON.stringify(lengths)}`);
console.log(JSON.stringify(result));
process.exit(0);
