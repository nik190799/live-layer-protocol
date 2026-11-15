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
const mark = (name) => marks.push({ name, at: (Date.now() - t0) / 1000 });
let page, S;
const todayStep = { cur: null };
const today = new TodayPipeline({ root, work, ci: ciMode, port: todayPort, tasks: TASKS, onStep: (name, d) => todayStep.cb?.(name, d) });
await today.init();

const videoDir = join(work, "video");
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, recordVideo: { dir: videoDir, size: { width: 1280, height: 720 } } });
page = await ctx.newPage();
page.on("pageerror", (e) => console.error("[page]", e.message));
const tv = Date.now(); // video time zero (close enough: the context starts recording on the first page)
const vt = () => (Date.now() - tv) / 1000;
await page.goto(`http://127.0.0.1:${server.address().port}/?port=${port}&today=${encodeURIComponent(`http://127.0.0.1:${todayPort}/`)}&tasks=${encodeURIComponent(JSON.stringify(TASKS))}`);
await page.waitForFunction(() => window.stage?.ready(), null, { timeout: 30000 });
const frame = page.frameLocator("#today");
await frame.locator("#draft").waitFor();
S = (fn, ...a) => page.evaluate(([f, a]) => window.stage[f](...a), [fn, a]);
await S("how", ciMode === "github" ? "git push → GitHub Actions → restart" : "git commit → CI on this machine → restart");
const fmtS = (ms) => ms < 1000 ? `${(ms / 1000).toFixed(2)} s` : ms < 60000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60000)}m ${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}s`;
function fmt(ms) { return ms < 10 ? ms.toFixed(1) : String(Math.round(ms)); }
async function ask(text) {
  await S("ask", ""); await S("typing", true);
  for (let i = 1; i <= text.length; i++) { await S("ask", text.slice(0, i)); await sleep(36); }
  await sleep(200); await S("typing", false);
}
async function fastForward(untilDone) { // speed up the video while only the today side is waiting
  const a = vt(); await S("ff", `⏩ sped up ×${SPEED} while CI runs · clocks are real`);
  const r = await untilDone; await S("ff", null); fast.push([a, vt()]); return r;
}
async function waitTodayReload(before) {
  while ((await page.evaluate(() => window.stage.todayLoads())) <= before) await sleep(20);
  const at = Date.now();
  await frame.locator("#app .u-heading").waitFor();
  return at;
}
const LLP_STEPS = ["AI writes the change", "Safety check", "Approve", "Live swap"];
const TODAY_STEPS = ["AI writes the change", "Commit and push", ciMode === "github" ? "CI: GitHub Actions" : "CI: tests on this machine", "Deploy: restart server", "Open pages reload"];
const ciName = (n = "") => /playwright/i.test(n) ? "installing the test browser" : /node --test/.test(n) ? "running the tests" : /checkout/.test(n) ? "checking out the code" : /setup-node/.test(n) ? "setting up Node" : /set up job/i.test(n) ? "starting a runner" : n;
let stepChain = Promise.resolve(); // pipeline events are shown in the order they happened
function todayStepper(offset = 0) { // map pipeline progress onto the today steps list
  const show = async (name, d) => {
    try {
      if (name === "commit") { await S("step", "t", offset + 0, "ok", "same AI, same change"); await S("step", "t", offset + 1, "act"); }
      if (name === "ci") { await S("step", "t", offset + 1, "ok", "pushed"); await S("step", "t", offset + 2, "act", ciName(d?.name)); }
      if (name === "ci-failed") await S("step", "t", offset + 2, "bad", "tests failed");
      if (name === "deploy") { await S("step", "t", offset + 2, "ok", "tests passed"); await S("step", "t", offset + 3, "act", "stopping the old server"); }
    } catch {}
  };
  todayStep.show = show;
  todayStep.cb = (name, d) => (stepChain = stepChain.then(() => todayStep.show(name, d)));
}
const settled = () => stepChain;

// The LLP side of one request: returns when the change is live (or blocked) on the device.
async function llpChange(prompt, replies) {
  say(prompt);
  await S("step", "l", 0, "act");
  const r = { blocked: null };
  await answerModel(replies.n, replies.first);
  await until(/✓ compiled/); await S("step", "l", 0, "ok", "compiled"); await S("step", "l", 1, "act");
  const res = await until(/✓ shadow check passed|✗ check: (.*)/);
  if (res[1] !== undefined) {
    r.blocked = { reason: res[1], at: Date.now(), state: await page.evaluate(() => window.stage.llpState()) };
    await S("step", "l", 1, "bad", "crashed on Delete → blocked");
    await S("phone", "l", "held"); await S("badge", "l", "Blocked", "app untouched", "warn");
    await sleep(1600);
    await S("badge", "l", null); await S("phone", "l", "");
    await S("step", "l", 0, "act", "crash sent back to the AI"); await S("step", "l", 1, "");
    await answerModel(replies.n + 1, replies.fix, /trapped/);
    await until(/✓ compiled/); await S("step", "l", 0, "ok", "AI fixed it"); await S("step", "l", 1, "act");
    await until(/✓ shadow check passed/);
  }
  await S("step", "l", 1, "ok", "every button clicked"); await S("step", "l", 2, "act");
  await until(/approve\?/); say("y"); await S("step", "l", 2, "ok", "approved");
  const live = await until(/LIVE v\d+ after (\d+) attempt\(s\): host swapped in ([\d.]+) ms\n\s+time: total \d+ ms = model \d+ \+ compile (\d+) \+ check (\d+)/);
  const before = r.blocked ? 2 : 1;
  await page.waitForFunction((b) => window.stage.llpState().build > b, before, { timeout: 10000 });
  const sw = await page.evaluate(() => window.stage.swaps.at(-1));
  r.swap = sw; r.liveAt = sw.at; r.attempts = +live[1]; r.compileMs = +live[3]; r.checkMs = +live[4];
  await S("step", "l", 3, "ok", `swapped in ${fmt(sw.ms)} ms, no restart`);
  return r;
}

// ---- intro: same app on both sides, someone is mid-typing ----
mark("intro");
await S("title", "Same app, same AI change.<br>Two ways to ship it.");
await S("steps", "t", TODAY_STEPS); await S("steps", "l", LLP_STEPS);
await sleep(600);
await page.click("#in-draft"); await page.keyboard.type("Call the ba", { delay: 40 });
await frame.locator("#draft").click(); await frame.locator("#draft").pressSequentially("Call the ba", { delay: 40 });
await sleep(700);

// ---- scene 1: a good change ----
mark("ask-1");
await ask("Add a progress bar");
const s1 = Date.now();
await S("clockStart", "t", s1); await S("clockStart", "l", s1);
todayStepper();
const loads1 = await page.evaluate(() => window.stage.todayLoads());
const today1 = today.ship("app-v2.js", "AI: add a progress bar");
const llp1 = await llpChange("add a progress bar", { n: 1, first: "1-progress.md" });
await S("clockStop", "l", llp1.liveAt, "live: no restart, draft kept");
await S("phone", "l", "live"); await S("badge", "l", `${fmtS(llp1.liveAt - s1)}`, "no restart · draft kept");
mark("llp-live-1");
await S("title", "<em>LLP is live.</em><br>Today is still in CI.");
await sleep(1500);
const t1 = await fastForward(today1); await settled();
if (!t1.ci.ok) throw new Error("today CI failed on the good change: " + JSON.stringify(t1.ci));
await S("step", "t", 3, "ok", `server down ${t1.downtime} ms`); await S("step", "t", 4, "act", "the page reloads");
const reload1 = await waitTodayReload(loads1);
const draftAfter1 = await frame.locator("#draft").inputValue();
await S("step", "t", 4, "ok", draftAfter1 ? "reloaded" : "reloaded: typed text lost");
await S("clockStop", "t", reload1, "live after CI and a restart");
await S("phone", "t", "live"); await S("badge", "t", fmtS(reload1 - s1), draftAfter1 ? "page reloaded" : "page reloaded · draft lost", "warn");
mark("today-live-1");
await S("title", `LLP: <em>${fmtS(llp1.liveAt - s1)}</em>, nothing lost.<br>Today: ${fmtS(reload1 - s1)}, page reloaded.`);
await sleep(3800);

// ---- scene 2: the AI writes a bug, on both sides ----
mark("ask-2");
for (const x of ["t", "l"]) { await S("badge", x, null); await S("phone", x, ""); await S("clockReset", x); }
await S("steps", "t", TODAY_STEPS); await S("steps", "l", LLP_STEPS);
await S("title", "Now the AI<br>writes a bug.");
await ask("Add a Delete button");
const s2 = Date.now();
await S("clockStart", "t", s2); await S("clockStart", "l", s2);
todayStepper();
const loads2 = await page.evaluate(() => window.stage.todayLoads());
const today2 = today.ship("app-v3.js", "AI: add a Delete button");
const llp2 = await llpChange("add a delete button on each task", { n: 2, first: "2-delete-bad.md", fix: "3-delete-fixed.md" });
await S("clockStop", "l", llp2.liveAt, "the bug never shipped");
await S("phone", "l", "live"); await S("badge", "l", fmtS(llp2.liveAt - s2), "bug blocked · fix live");
mark("llp-live-2");
await S("title", "<em>LLP blocked the bug.</em><br>Today's CI passes it.");
await sleep(1200);
await page.click('#screen [data-id="del:2"]');
const t2 = await fastForward(today2); await settled();
if (!t2.ci.ok) throw new Error("today CI failed on the Delete change (it should pass: no test covers Delete): " + JSON.stringify(t2.ci));
await S("step", "t", 2, "ok", "tests passed (none cover Delete)");
await S("step", "t", 3, "ok", `server down ${t2.downtime} ms`); await S("step", "t", 4, "act", "the page reloads");
const reload2 = await waitTodayReload(loads2);
await S("step", "t", 4, "ok", "reloaded");
await sleep(600);
await frame.locator('.del[data-i="0"]').click();
await frame.locator("#crash").waitFor({ state: "visible", timeout: 5000 });
const crashAt = Date.now();
mark("today-crash");
await S("phone", "t", "broken"); await S("badge", "t", "Crashed", "the bug reached the user", "bad");
await S("title", "<s>Today, a user hits the bug.</s><br>Roll back: the whole pipeline again.");
await sleep(2200);
// roll back: revert to the last good version, through the same pipeline
await S("badge", "t", null);
await S("steps", "t", ["A user hits the bug", "Revert and push", TODAY_STEPS[2], TODAY_STEPS[3], TODAY_STEPS[4]]);
await S("step", "t", 0, "bad", "app crashed on Delete");
todayStepper();
const loads3 = await page.evaluate(() => window.stage.todayLoads());
todayStep.show = ((show) => async (n, d) => { if (n !== "commit") return show(n, d); await S("step", "t", 1, "act", "git revert"); })(todayStep.show);
const t3 = await fastForward(today.ship("app-v2.js", "Revert: the Delete button crashes")); await settled();
await S("step", "t", 3, "ok", `server down ${t3.downtime} ms`); await S("step", "t", 4, "act", "the page reloads");
const reload3 = await waitTodayReload(loads3);
await S("step", "t", 4, "ok", "back to the old version");
await S("clockStop", "t", reload3, "until it worked again");
await S("phone", "t", "live"); await S("badge", "t", fmtS(reload3 - crashAt), "broken for users", "bad");
mark("today-back");
await S("title", `LLP: bug never shipped.<br>Today: broken for ${fmtS(reload3 - crashAt)}.`);
await sleep(3800);
const llpFinal = await page.evaluate(() => window.stage.llpState());

// ---- end card ----
mark("end");
await S("end", `<h2>Ship AI changes <em>live</em>,<br>without shipping its bugs.</h2>
<table><tr><th></th><th class="t">TODAY</th><th class="l">WITH LLP</th></tr>
<tr><td>A change goes live</td><td class="t">${fmtS(reload1 - s1)}</td><td class="l">${fmtS(llp1.liveAt - s1)}</td></tr>
<tr><td>Half-typed text</td><td class="t">${draftAfter1 ? "kept" : "lost: page reloaded"}</td><td class="l">${llp1.swap.draft ? "kept" : "lost"}</td></tr>
<tr><td>A buggy change</td><td class="t">reached users, ${fmtS(reload3 - crashAt)} to fix</td><td class="l">blocked, fix live in ${fmtS(llp2.liveAt - s2)}</td></tr></table>
<div class="src2">Measured in this recording. Today: ${ciMode === "github" ? "GitHub Actions (ubuntu-latest)" : "tests on this machine"} + restarting a Node server. LLP: compile, shadow check, signed stream, live swap.</div>`);
await sleep(4500);
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
// ---- video -> gif + mp4, with the CI waits sped up ----
mkdirSync(dirname(out), { recursive: true });
const ff = (a) => execFileSync("ffmpeg", ["-v", "error", "-y", ...a], { stdio: "inherit" });
const start = Math.max(0, (marks[0].at * 1000 - (tv - t0)) / 1000 - 0.2), end = (marks.at(-1).at * 1000 - (tv - t0)) / 1000;
const segs = []; let at = start;
for (const [a, b] of fast) { if (a > at) segs.push([at, a, 1]); segs.push([a, b, SPEED]); at = b; }
segs.push([at, end, 1]);
const parts = segs.map(([a, b, k], i) => `[0:v]trim=${a.toFixed(3)}:${b.toFixed(3)},setpts=(PTS-STARTPTS)/${k}[s${i}]`).join(";");
const cat = `${parts};${segs.map((_, i) => `[s${i}]`).join("")}concat=n=${segs.length}:v=1:a=0[v]`;
const mid = join(work, "cut.mp4");
ff(["-i", video, "-filter_complex", cat, "-map", "[v]", "-r", "30", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", mid]);
ff(["-i", mid, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", "-movflags", "+faststart", out + ".mp4"]);
ff(["-i", mid, "-vf", "fps=10,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle", out + ".gif"]);
const seconds = segs.reduce((n, [a, b, k]) => n + (b - a) / k, 0);
writeFileSync(out + "-run.json", JSON.stringify({ recordedAt: new Date().toISOString(), ...result, speedUp: { factor: SPEED, segments: fast }, timeline: marks, publisherOutput: output }, null, 2) + "\n");
if (args.includes("--keep-video")) console.log("raw video:", video); else rmSync(work, { recursive: true, force: true });
console.log(`wrote ${out}.gif, ${out}.mp4, ${out}-run.json (${Math.round(seconds)} s of video from ${Math.round(end - start)} s of real time)`);
console.log(JSON.stringify(result));
process.exit(0);
