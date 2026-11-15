// The "today" side of the demo: a conventional pipeline, run for real.
//   commit -> push to GitHub -> GitHub Actions runs the app's tests (.github/workflows/today-demo.yml)
//   -> deploy: stop the server, start the new release -> open pages notice and reload.
// With ci: "local" the same tests run in a fresh clone on this machine instead of GitHub Actions.
// Every step is timed; nothing here is simulated.
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { cpSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Everything here is async: the LLP side runs in the same process at the same time and must never wait on us.
const run = async (cmd, args, opts = {}) => (await promisify(execFile)(cmd, args, { encoding: "utf8", maxBuffer: 1 << 26, ...opts })).stdout.trim();

export class TodayPipeline {
  // root: the repo; work: a scratch dir; branch: the branch force-pushed for each change (one branch, reused).
  constructor({ root, work, ci = "github", branch = "demo-today/recording", port, tasks, onStep = () => {} }) {
    Object.assign(this, { root, work, ci, branch, port, tasks, onStep });
    this.wt = join(work, "today-repo");
    this.app = join(this.wt, "tools/demo-gif/today-app");
    this.data = join(work, "today-tasks.json");
  }
  git(...a) { return run("git", a, { cwd: this.wt }); }

  async init() {
    // A worktree at HEAD, so the commits the demo makes never touch the checkout you are in.
    await run("git", ["worktree", "add", "--detach", this.wt, "HEAD"], { cwd: this.root });
    if (this.ci === "github") {
      const url = await run("git", ["remote", "get-url", "origin"], { cwd: this.root });
      this.repo = /github\.com[:/](.+?\/.+?)(\.git)?$/.exec(url)?.[1];
      if (!this.repo) throw new Error(`origin is not a GitHub repo: ${url}`);
    }
    copyFileSync(join(this.app, "versions/app-v1.js"), join(this.app, "src/app.js"));
    await this.git("add", "-A"); await this.git("-c", "user.name=demo", "-c", "user.email=demo@localhost", "commit", "-q", "--allow-empty", "-m", "today demo: v1");
    writeFileSync(this.data, JSON.stringify(this.tasks.map(([text, done]) => ({ text, done: !!done }))));
    await this.deploy();
  }

  // Ship one version of app.js through the whole pipeline. Returns the measured times in ms.
  async ship(version, message) {
    const t = { start: Date.now() };
    this.onStep("commit");
    copyFileSync(join(this.app, `versions/${version}`), join(this.app, "src/app.js"));
    await this.git("add", "-A"); await this.git("-c", "user.name=demo", "-c", "user.email=demo@localhost", "commit", "-q", "-m", message);
    const sha = await this.git("rev-parse", "HEAD");
    if (this.ci === "github") {
      await run("git", ["push", "-q", "-f", "origin", `HEAD:refs/heads/${this.branch}`], { cwd: this.wt });
      t.pushed = Date.now();
      t.ci = await this.githubCi(sha);
    } else {
      t.pushed = Date.now();
      t.ci = await this.localCi();
    }
    t.ciDone = Date.now();
    if (!t.ci.ok) { this.onStep("ci-failed", t.ci); return t; }
    this.onStep("deploy");
    t.downtime = await this.deploy();
    t.live = Date.now();
    return t;
  }

  async githubCi(sha) {
    this.onStep("ci", { name: "queued" });
    const api = async (path) => JSON.parse(await run("gh", ["api", `repos/${this.repo}/${path}`]));
    let ci;
    for (let i = 0; i < 600; i++) {
      ci ??= (await api(`actions/runs?branch=${encodeURIComponent(this.branch)}&head_sha=${sha}&per_page=1`)).workflow_runs[0];
      if (ci) {
        ci = await api(`actions/runs/${ci.id}`);
        const steps = (await api(`actions/runs/${ci.id}/jobs`)).jobs.flatMap((j) => j.steps ?? []);
        const now = steps.find((s) => s.status === "in_progress");
        this.onStep("ci", { name: ci.status === "queued" ? "queued for a runner" : (now?.name ?? ci.status).replace(/^Run /, "") });
        if (ci.status === "completed") return { ok: ci.conclusion === "success", url: ci.html_url, steps: steps.map((s) => ({ name: s.name, ms: Date.parse(s.completed_at) - Date.parse(s.started_at) })) };
      }
      await sleep(2000);
    }
    return { ok: false, error: "timed out waiting for GitHub Actions" };
  }

  async localCi() {
    this.onStep("ci", { name: "fresh clone" });
    const dir = join(this.work, `ci-${Date.now()}`);
    await run("git", ["clone", "-q", this.wt, dir]);
    this.onStep("ci", { name: "node --test" });
    const ok = await new Promise((r) => spawn(process.execPath, ["--test", "test/app.test.mjs"], { cwd: join(dir, "tools/demo-gif/today-app/src"), stdio: "ignore" }).on("exit", (c) => r(c === 0)));
    rmSync(dir, { recursive: true, force: true });
    return { ok };
  }

  // Stop the running release and start the new one. Returns the downtime in ms (no server answering).
  async deploy() {
    const id = await this.git("rev-parse", "--short", "HEAD");
    const rel = join(this.work, "releases", id);
    mkdirSync(rel, { recursive: true });
    cpSync(join(this.app, "src"), rel, { recursive: true });
    const t0 = Date.now();
    if (this.server) { const s = this.server; await new Promise((r) => { s.once("exit", r); s.kill("SIGTERM"); }); }
    this.server = spawn(process.execPath, [join(rel, "server.mjs"), String(this.port), this.data, id], { stdio: ["ignore", "pipe", "inherit"] });
    await new Promise((r) => this.server.stdout.once("data", r));
    return Date.now() - t0;
  }

  async close() {
    this.server?.kill();
    try { await run("git", ["worktree", "remove", "--force", this.wt], { cwd: this.root }); } catch {}
  }
}
