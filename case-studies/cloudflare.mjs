// Case 3: Cloudflare, 2 July 2019. A new WAF managed rule went to every edge server at once (rule
// changes were allowed to skip staged rollout). Its regex, containing ".*(?:.*=.*)", backtracked
// so badly that CPUs serving HTTP traffic hit ~100% worldwide for 27 minutes.
//
// Each edge runs on its own thread and takes requests in a closed loop (next request when the last
// one is answered). Traffic is half GETs with a query string and half ~1 KB JSON POST bodies that
// contain no "=", the input that makes the pattern backtrack.
import { Worker } from "node:worker_threads";
import { makeFleet, wasm, sleep, now, pct, running } from "./lib.mjs";

const POST = '{"comment":"' + "great product, would buy again ".repeat(34) + '"}'; // ~1 KB, no "="
const GET = "GET /search?q=shoes&page=2&sort=price " + "x".repeat(150);
const bodyFor = (i) => (i % 2 ? POST : GET);

// ---- A: legacy edges, no time budget ----
async function legacyWindow(edges, ms) {
  const workers = Array.from({ length: edges }, (_, id) => new Worker(new URL("./legacy-edge-worker.mjs", import.meta.url), { workerData: { id, bytes: wasm("cf_waf") } }));
  const measure = async () => {
    let served = 0, stop = false, inflight = 0;
    const end = now() + ms;
    await Promise.all(workers.map((w, k) => new Promise((done) => {
      let seq = 0;
      const next = () => { if (now() >= end) { w.off("message", on); return done(); } w.postMessage({ seq: ++seq, body: bodyFor(seq + k) }); };
      const on = (m) => { if (m.ok) served++; next(); };
      w.on("message", on); next();
      setTimeout(() => { w.off("message", on); done(); }, ms + 50); // a request still running at the end doesn't count
    })));
    return served;
  };
  const before = await measure();
  for (const w of workers) w.postMessage({ install: wasm("cf_waf_bad") }); // global push, all edges at once
  await sleep(20);
  const after = await measure();
  await Promise.all(workers.map((w) => w.terminate()));
  return { servedPerWindowBefore: before, servedPerWindowAfter: after, throughputPctOfNormal: pct(after, before) };
}

// ---- B: the same rule through LLP: worker per layer, 100 ms call budget, staged rollout ----
async function llpRun(edges, ms, steps) {
  const { fleet, nodes, close } = await makeFleet({ app: "edge.waf", n: edges, limits: {} }); // default limits: 100 ms per call
  const H = { good: await fleet.addBlob(wasm("cf_waf")), bad: await fleet.addBlob(wasm("cf_waf_bad")) };
  await fleet.publish("prod", { waf: H.good });
  for (const n of nodes) n.connect();
  await fleet.waitForConvergence("prod", 30000);
  const drive = async () => { // closed-loop traffic on every edge for `ms`
    let served = 0, failed = 0;
    const end = now() + ms;
    await Promise.all(nodes.map(async (n, k) => {
      for (let i = 0; now() < end; i++) {
        const b = n.host.kv.get("served") ?? 0;
        await n.host.dispatch("waf", "req", bodyFor(i + k));
        if ((n.host.kv.get("served") ?? 0) > b) served++; else failed++;
      }
    }));
    return { served, failed };
  };
  await drive(); // warm-up (first calls compile lazily), not counted
  const before = await drive();
  const everBad = new Set(), traffic = [];
  const t0 = now();
  const r = await fleet.rollout("prod", { waf: H.bad }, {
    steps, maxFailRate: 0, soakMs: 200, timeoutMs: 30000,
    onStep: async (p) => { for (const n of running(nodes, "waf", H.bad)) everBad.add(n.id); traffic.push({ percent: p, ...(await drive()) }); },
  });
  const rolledBackMs = now() - t0;
  const after = await drive();
  const timeouts = nodes.reduce((a, n) => a + n.host.history.filter((e) => e.kind === "rollback" && /time limit/.test(e.msg)).length, 0);
  close();
  const during = traffic.reduce((a, t) => ({ served: a.served + t.served, failed: a.failed + t.failed }), { served: 0, failed: 0 });
  return {
    haltedAt: r.haltedAt, reason: r.reason, rolledBack: !r.ok, recovered: r.recovered,
    edgesThatRanBadRule: everBad.size, edgesThatRanBadPct: pct(everBad.size, edges),
    requestsFailedDuringRollout: during.failed, availabilityDuringRolloutPct: +(100 * during.served / (during.served + during.failed)).toFixed(3),
    throughputDuringRolloutPctOfNormal: pct(during.served / traffic.length, before.served),
    throughputAfterPctOfNormal: pct(after.served, before.served),
    callsKilledByTimeBudget: timeouts, cpuMsLostPerKill: 100,
    msPublishToFleetRolledBack: Math.round(rolledBackMs), traffic, servedPerWindowBefore: before.served,
  };
}

export async function run({ edges = 20, windowMs = 2000 } = {}) {
  return { case: "cloudflare", edges, windowMs, legacy: await legacyWindow(edges, windowMs),
    llp: await llpRun(edges, windowMs, [10, 50, 100]),
    // Cloudflare kept an emergency "push globally" path for rule changes. The same rule through LLP
    // at 100% in one step: no staging, so only the time budget and per-host revert are left.
    llpGlobalPush: await llpRun(edges, windowMs, [100]) };
}
