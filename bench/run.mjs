// LLP shipping-speed benchmark. Measures the LLP side of "change -> running in production",
// and a traditional rebuild-and-restart baseline on the same machine.
// Usage: node bench/run.mjs [--quick] [--no-docker] [--only=compile,pipeline,fleet,rollback,baseline]
import { spawn, spawnSync, execSync } from "node:child_process";
import { readFileSync, writeFileSync, copyFileSync, mkdtempSync, mkdirSync, cpSync } from "node:fs";
import { tmpdir, cpus, totalmem, platform, release } from "node:os";
import { join } from "node:path";
import { LiveHost, sha256, signManifest, generatePublisherKey, canonical, b64 } from "../host/llp-core.js";
import { now, stats, withNonce } from "./lib.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const argv = process.argv.slice(2);
const QUICK = argv.includes("--quick");
const only = (argv.find((a) => a.startsWith("--only=")) || "").slice(7).split(",").filter(Boolean);
const want = (s) => !only.length || only.includes(s);
const T = (full, quick) => (QUICK ? quick : full);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const read = (f) => new Uint8Array(readFileSync(join(ROOT, "build", f)));
const results = { machine: { cpu: cpus()[0]?.model, cores: cpus().length, memGB: Math.round(totalmem() / 2 ** 30), os: `${platform()} ${release()}`, node: process.version }, at: new Date().toISOString() };
const log = (...a) => console.error(...a);
const time = (fn) => { const t = performance.now(); const r = fn(); return [performance.now() - t, r]; };
const timeA = async (fn) => { const t = performance.now(); const r = await fn(); return [performance.now() - t, r]; };

// ---------- 1. compile one changed layer ----------
if (want("compile")) {
  log("compile ...");
  const out = mkdtempSync(join(tmpdir(), "llp-bench-c-"));
  const asc = join(ROOT, "node_modules/.bin/asc");
  const runs = { assemblyscript: [], c: [] };
  for (let i = 0; i < T(10, 3); i++) {
    let t = performance.now();
    const a = spawnSync(asc, [join(ROOT, "layers/variants/tasks_v2.ts"), "-o", join(out, "v2.wasm"), "-O3"], { cwd: ROOT });
    if (a.status) throw new Error("asc failed: " + a.stderr);
    runs.assemblyscript.push(performance.now() - t);
    t = performance.now();
    const c = spawnSync("clang", ["--target=wasm32", "-nostdlib", "-O2", "-Wl,--no-entry", "-o", join(out, "stats.wasm"), join(ROOT, "layers/stats-c/stats.c")]);
    if (c.status) { runs.c = null; } else runs.c?.push(performance.now() - t);
  }
  results.compile = { assemblyscript_tasks_v2_O3: stats(runs.assemblyscript), c_stats_O2: runs.c ? stats(runs.c) : "clang with wasm32 target not available",
    sameBytesAsCommitted: Buffer.compare(readFileSync(join(out, "v2.wasm")), readFileSync(join(ROOT, "build/tasks_v2.wasm"))) === 0 };
}

// ---------- 2. in-process pipeline stages ----------
if (want("pipeline")) {
  log("pipeline ...");
  const pub = await generatePublisherKey();
  const store = new Map();
  const put = async (bytes) => { const h = await sha256(bytes); store.set(h, bytes); return h; };
  const fetchBlob = async (h) => store.get(h);
  const tasks = await put(read("tasks.wasm")), statsL = await put(read("stats.wasm"));
  const v2bytes = read("tasks_v2.wasm");
  const N = T(200, 30);
  const st = { hash: [], sign: [], verify: [], publish: [], swapPlain: [], swapMigrate: [], instantiateOnly: [] };
  let kept = true;

  // migration swap (v1 -> v2, schema 1 -> 2) on a fresh host with real user state, each trial
  // each trial uses its own build, so V8's in-process compiled-module cache never gives a free compile
  const v2 = await put(v2bytes);
  for (let i = 0; i < N; i++) {
    const v2i = await put(withNonce(v2bytes, `m${i}`));
    const host = new LiveHost({ trustedKeys: [pub.publicJwk] });
    let m = { app: "demo.tasks", version: 1, layers: { main: tasks, footer: statsL }, order: ["main", "footer"] };
    await host.apply(m, await signManifest(m, pub.privateKey), fetchBlob);
    for (const t of ["Buy milk", "Call mom"]) { host.setBound("draft", t); await host.dispatch("main", "add"); }
    m = { ...m, version: 2, layers: { main: v2i, footer: statsL } };
    const sig = await signManifest(m, pub.privateKey);
    const [ms, r] = await timeA(() => host.apply(m, sig, fetchBlob));
    if (!r.ok || host.kv.get("tasks.n") !== 2 || host.kv.get("migrated.from") !== 1) kept = false;
    st.swapMigrate.push(ms);
    host.close?.(); // stop this trial's layer workers
  }

  // plain swaps: a new build of the same layer, on one long-running host
  const host = new LiveHost({ trustedKeys: [pub.publicJwk] });
  let m = { app: "demo.tasks", version: 1, layers: { main: v2, footer: statsL }, order: ["main", "footer"] };
  await host.apply(m, await signManifest(m, pub.privateKey), fetchBlob);
  for (const t of ["Buy milk", "Call mom"]) { host.setBound("draft", t); await host.dispatch("main", "add"); }
  const ECDSA = { name: "ECDSA", namedCurve: "P-256" };
  for (let i = 0; i < N; i++) {
    const bytes = withNonce(v2bytes, i);
    // publisher side
    const tp = performance.now();
    const [th, h] = await timeA(() => sha256(bytes));
    store.set(h, bytes);
    m = { ...m, version: m.version + 1, layers: { main: h, footer: statsL } };
    const [ts, sig] = await timeA(() => signManifest(m, pub.privateKey));
    st.publish.push(performance.now() - tp); st.hash.push(th); st.sign.push(ts);
    // host side, stage by stage (verify measured on its own; apply repeats it internally)
    const [tv] = await timeA(async () => { const k = await crypto.subtle.importKey("jwk", pub.publicJwk, ECDSA, false, ["verify"]); return crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, k, b64.dec(sig), new TextEncoder().encode(canonical(m))); });
    st.verify.push(tv);
    const nb = withNonce(v2bytes, `i${i}`), nh = await sha256(nb); host.blobs.set(nh, nb);
    const [ti, box] = await timeA(() => host.load("bench", nh)); host.recycle(box); host.blobs.delete(nh); st.instantiateOnly.push(ti); // load = memory cap + instantiate in a worker
    const [ta, r] = await timeA(() => host.apply(m, sig, fetchBlob));
    if (!r.ok || host.kv.get("tasks.n") !== 2) kept = false;
    st.swapPlain.push(ta);
  }
  results.pipeline = { trials: N, stateKeptEveryTrial: kept, ms: Object.fromEntries(Object.entries(st).map(([k, v]) => [k, stats(v)])),
    note: "swap* = host.apply(): verify signature + fetch from local store + integrity hash + instantiate + migrate (if any) + shadow render on a copy of state + atomic commit + render" };
}

// ---------- 3. fleet convergence over real WebSockets ----------
async function fleet(N, trials) {
  const work = mkdtempSync(join(tmpdir(), "llp-bench-f-"));
  const live = join(work, "live-main.wasm"), foot = join(work, "live-footer.wasm");
  copyFileSync(join(ROOT, "build/tasks.wasm"), live); copyFileSync(join(ROOT, "build/stats.wasm"), foot);
  const port = 7800 + N % 97;
  const pub = spawn(process.execPath, [join(ROOT, "tools/publisher.mjs"), "--port", String(port), `main=${live}`, `footer=${foot}`], { cwd: work });
  let pubOut = ""; pub.stdout.on("data", (d) => (pubOut += d)); pub.stderr.on("data", (d) => (pubOut += d));
  while (!/publisher on/.test(pubOut)) await sleep(10);

  const events = []; let ready = 0, nacks = 0;
  const K = Math.min(N, cpus().length), per = Math.ceil(N / K), kids = [];
  for (let k = 0; k < K; k++) {
    const count = Math.min(per, N - k * per); if (count <= 0) break;
    const p = spawn(process.execPath, [join(ROOT, "bench/sim-hosts.mjs"), `ws://localhost:${port}`, join(work, "keys/publisher.pub.json"), String(count), String(k * per)]);
    let buf = "";
    p.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1);
      const [kind, id, ver, t, ms, n] = line.split(" ");
      if (kind === "READY") ready++; else if (kind === "LIVE") events.push({ id: +id, ver: +ver, t: +t, ms: +ms, tasks: +n }); else if (kind === "NACK") nacks++; } });
    p.stderr.on("data", (d) => log(String(d)));
    kids.push(p);
  }
  const waitAll = async (pred, ms = 120000) => { const t = Date.now(); while (!pred()) { if (Date.now() - t > ms) throw new Error(`fleet ${N}: timeout`); await sleep(5); } };
  await waitAll(() => ready === kids.length && new Set(events.map((e) => e.id)).size === N);
  await sleep(300);

  const v2 = read("tasks_v2.wasm"), rows = [];
  let lastVer = Math.max(...events.map((e) => e.ver));
  for (let i = 0; i <= trials; i++) { // trial 0 = v1 -> v2 schema migration (reported separately)
    const bytes = withNonce(v2, `${N}-${i}`);
    const t0 = now();
    writeFileSync(live, bytes); // the "ship": a compiled layer lands on disk
    await waitAll(() => events.filter((e) => e.ver > lastVer).length === N);
    const got = events.filter((e) => e.ver > lastVer);
    if (new Set(got.map((e) => e.ver)).size !== 1) throw new Error(`fleet ${N}: hosts went live on different versions in one trial`);
    lastVer = got[0].ver;
    const ts = got.map((e) => e.t - t0).sort((a, b) => a - b);
    rows.push({ first: ts[0], p50host: ts[Math.floor(N / 2)], all: ts[N - 1], applyMs: stats(got.map((e) => e.ms)).p50, stateKept: got.every((e) => e.tasks === 2) });
    await sleep(N >= 1000 ? 800 : 300);
  }
  for (const p of kids) p.kill(); pub.kill();
  const measured = rows.slice(1);
  return { hosts: N, trials, processes: kids.length, nacks, stateKeptOnEveryHost: rows.every((r) => r.stateKept),
    migrationTrial_ms: { first: +rows[0].first.toFixed(1), all: +rows[0].all.toFixed(1) },
    fileSavedTo_firstHostLive: stats(measured.map((r) => r.first)), fileSavedTo_medianHostLive: stats(measured.map((r) => r.p50host)),
    fileSavedTo_allHostsLive: stats(measured.map((r) => r.all)), perHostApply_p50ms: stats(measured.map((r) => r.applyMs)) };
}
if (want("fleet")) {
  results.fleet = { note: "Includes the publisher's fixed 80 ms file-watch debounce (tools/publisher.mjs). All hosts share this machine's CPU, so large fleets are CPU-bound here; real devices verify in parallel." , runs: [] };
  for (const [N, tr] of [[1, T(30, 5)], [100, T(20, 3)], [1000, T(10, 2)]]) { log(`fleet ${N} ...`); results.fleet.runs.push(await fleet(N, tr)); }
}

// ---------- 4. rollback ----------
if (want("rollback")) {
  log("rollback ...");
  const pub = await generatePublisherKey();
  const store = new Map();
  const put = async (b) => { const h = await sha256(b); store.set(h, b); return h; };
  const fetchBlob = async (h) => store.get(h);
  const v2 = await put(read("tasks_v2.wasm")), statsL = await put(read("stats.wasm"));
  const trapBytes = read("tasks_trap.wasm"), brokenBytes = read("tasks_broken.wasm");
  const host = new LiveHost({ trustedKeys: [pub.publicJwk] });
  let m = { app: "demo.tasks", version: 1, layers: { main: v2, footer: statsL }, order: ["main", "footer"] };
  await host.apply(m, await signManifest(m, pub.privateKey), fetchBlob);
  for (const t of ["Buy milk", "Call mom"]) { host.setBound("draft", t); await host.dispatch("main", "add"); }
  const N = T(200, 30), st = { normalEvent: [], trapDetectRestoreRevert: [], refuseBrokenBeforeLive: [] };
  let ok = true;
  for (let i = 0; i < N; i++) {
    // a normal event on the good version, for comparison (then undo it so state stays the same size)
    host.setBound("draft", "x");
    const n0 = host.kv.get("tasks.n");
    const [tn] = await timeA(() => host.dispatch("main", "add")); st.normalEvent.push(tn);
    host.kv.set("tasks.n", n0);
    // a crashing version goes live, then traps on the next user action
    const trap = await put(withNonce(trapBytes, i));
    m = { ...m, version: m.version + 1, layers: { main: trap, footer: statsL } };
    const r = await host.apply(m, await signManifest(m, pub.privateKey), fetchBlob);
    if (!r.ok) ok = false;
    host.setBound("draft", "boom");
    const [tr] = await timeA(() => host.dispatch("main", "add")); st.trapDetectRestoreRevert.push(tr);
    if (host.slots.get("main").hash !== v2 || host.kv.get("tasks.n") !== n0) ok = false;
    // a version that fails its health check is refused before it is ever live
    const broken = await put(withNonce(brokenBytes, i));
    const mb = { ...m, version: m.version + 1, layers: { main: broken, footer: statsL } };
    const [tb, rb] = await timeA(async () => host.apply(mb, await signManifest(mb, pub.privateKey), fetchBlob));
    if (rb.ok || host.slots.get("main").hash !== v2) ok = false;
    st.refuseBrokenBeforeLive.push(tb); m = { ...m, version: mb.version };
  }
  results.rollback = { trials: N, revertedToGoodVersionAndStateRestoredEveryTrial: ok, ms: Object.fromEntries(Object.entries(st).map(([k, v]) => [k, stats(v)])),
    note: "trapDetectRestoreRevert = the user action that hits the crash: trap caught, state snapshot restored, slot reverted to previous version, UI re-rendered. refuseBrokenBeforeLive includes signing the bad manifest." };
}

// ---------- 5. baseline: traditional rebuild + restart ----------
async function httpOk(url) { try { const r = await fetch(url); return r.ok; } catch { return false; } }
async function waitHealthy(url, ms = 30000) { const t = Date.now(); while (!(await httpOk(url))) { if (Date.now() - t > ms) throw new Error("not healthy: " + url); await sleep(5); } }
async function stateCount(base) { await fetch(`${base}/tasks?text=Buy%20milk`, { method: "POST" }); await fetch(`${base}/tasks?text=Call%20mom`, { method: "POST" }); }
const getTasks = async (base) => (await (await fetch(base + "/")).json()).tasks.length;

if (want("baseline")) {
  results.baseline = {};
  const dir = mkdtempSync(join(tmpdir(), "llp-bench-b-"));
  cpSync(join(ROOT, "bench/baseline"), dir, { recursive: true });
  const src = readFileSync(join(dir, "server.js"), "utf8");
  const edit = (i) => writeFileSync(join(dir, "server.js"), src.replace(`"Tasks v0"`, `"Tasks v${i}"`));

  // 5a. plain process restart (no build, no container): the fastest a restart-based deploy can be
  log("baseline: process restart ...");
  const base = "http://127.0.0.1:3000";
  let p = spawn(process.execPath, ["server.js"], { cwd: dir }); await waitHealthy(base + "/health");
  const pr = { restartToHealthy: [], stateLostEveryTrial: true };
  for (let i = 1; i <= T(20, 3); i++) {
    await stateCount(base); edit(i);
    const t = performance.now();
    p.kill(); await new Promise((r) => p.once("exit", r));
    p = spawn(process.execPath, ["server.js"], { cwd: dir }); await waitHealthy(base + "/health");
    pr.restartToHealthy.push(performance.now() - t);
    if ((await getTasks(base)) !== 0) pr.stateLostEveryTrial = false;
  }
  p.kill();
  results.baseline.processRestart = { trials: pr.restartToHealthy.length, stateLostEveryTrial: pr.stateLostEveryTrial, ms: { restartToHealthy: stats(pr.restartToHealthy) } };

  // 5b. docker: build image (warm cache, base image already pulled) + replace container
  let docker = !argv.includes("--no-docker");
  if (docker) try { execSync("docker info", { stdio: "ignore" }); execSync("docker image inspect node:22-alpine", { stdio: "ignore" }); } catch { docker = false; }
  if (!docker) results.baseline.docker = "skipped: docker daemon or node:22-alpine image not available (run `docker pull node:22-alpine`)";
  else {
    log("baseline: docker ...");
    const sh = (c) => execSync(c, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] }).toString();
    const name = "llp-bench-baseline", dbase = "http://127.0.0.1:18090";
    try { sh(`docker rm -f ${name}`); } catch {}
    edit(0); sh(`docker build -q -t ${name}:0 .`); sh(`docker run -d --name ${name} -p 18090:3000 ${name}:0`); await waitHealthy(dbase + "/health");
    const d = { build: [], stopOld: [], startToHealthy: [], total: [] }; let lost = true;
    for (let i = 1; i <= T(10, 2); i++) {
      await stateCount(dbase); edit(i);
      const t0 = performance.now();
      sh(`docker build -q -t ${name}:${i} .`); const t1 = performance.now();
      sh(`docker rm -f ${name}`); const t2 = performance.now();
      sh(`docker run -d --name ${name} -p 18090:3000 ${name}:${i}`); await waitHealthy(dbase + "/health"); const t3 = performance.now();
      d.build.push(t1 - t0); d.stopOld.push(t2 - t1); d.startToHealthy.push(t3 - t2); d.total.push(t3 - t0);
      if ((await getTasks(dbase)) !== 0) lost = false;
      try { sh(`docker rmi ${name}:${i - 1}`); } catch {}
    }
    sh(`docker rm -f ${name}`);
    results.baseline.docker = { trials: d.total.length, stateLostEveryTrial: lost, downtime_note: "app is unreachable from stopOld until healthy", ms: Object.fromEntries(Object.entries(d).map(([k, v]) => [k, stats(v)])) };
  }
}

mkdirSync(join(ROOT, "bench/out"), { recursive: true });
writeFileSync(join(ROOT, "bench/out/results.json"), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
