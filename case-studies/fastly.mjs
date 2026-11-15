// Case 4: Fastly, 8 June 2021. A software deploy on 12 May introduced a latent bug. On 8 June a
// customer pushed a valid configuration change that set it off, and 85% of Fastly's network
// returned errors; 95% was back within 49 minutes. The trigger was a config (data) change, not a
// code release, and the buggy code had already passed its own rollout weeks earlier.
import { LegacyHost, makeFleet, wasm, pct, running } from "./lib.mjs";

const CUSTOMERS = ["acme", "news", "shop", "video", "docs", "gov", "bank", "game", "maps", "blog"];
const reqFor = (i) => `${CUSTOMERS[i % CUSTOMERS.length]}/page/${i}`;

export async function run({ edges = 20, requests = 300 } = {}) {
  const v1 = wasm("fa_edge_v1"), v2 = wasm("fa_edge_v2");

  // ---- A: the incident's model: the bug crashes the edge process, taking every customer with it ----
  const legacy = Array.from({ length: edges }, (_, i) => new LegacyHost(i));
  for (const h of legacy) h.install(v2); // the May 12 release, long since everywhere
  let okBefore = 0; for (const h of legacy) for (let i = 0; i < requests; i++) okBefore += h.event("req", reqFor(i)) ? 1 : 0;
  for (const h of legacy) h.kv.set("cfg.acme.shards", 0); // June 8: one customer's valid config change
  let ok = 0, okOthers = 0, othersTotal = 0;
  for (const h of legacy) for (let i = 0; i < requests; i++) {
    const r = h.event("req", reqFor(i)); ok += r ? 1 : 0;
    if (!reqFor(i).startsWith("acme/")) { othersTotal++; okOthers += r ? 1 : 0; }
  }
  const legacyResult = { okBeforePct: pct(okBefore, edges * requests), edgesDown: legacy.filter((h) => h.down).length, availabilityPct: pct(ok, edges * requests), otherCustomersAvailabilityPct: pct(okOthers, othersTotal) };

  // ---- B: LLP ----
  const { fleet, nodes, close } = await makeFleet({ app: "edge.cdn", n: edges, limits: {} });
  const H = { v1: await fleet.addBlob(v1), v2: await fleet.addBlob(v2) };
  await fleet.publish("prod", { edge: H.v1 });
  for (const n of nodes) n.connect();
  await fleet.waitForConvergence("prod", 30000);
  const traffic = async (count) => {
    let served = 0, total = 0, others = 0, othersOk = 0;
    await Promise.all(nodes.map(async (n) => { for (let i = 0; i < count; i++) {
      const b = n.host.kv.get("served") ?? 0;
      await n.host.dispatch("edge", "req", reqFor(i));
      const good = (n.host.kv.get("served") ?? 0) > b;
      total++; served += good; if (!reqFor(i).startsWith("acme/")) { others++; othersOk += good; }
    } }));
    return { served, total, availabilityPct: +(100 * served / total).toFixed(3), otherCustomersAvailabilityPct: +(100 * othersOk / others).toFixed(3) };
  };
  // May 12: v2 goes out through a staged rollout with health gates, under real traffic. It passes,
  // because no customer has the setting that triggers the bug yet.
  const may = await fleet.rollout("prod", { edge: H.v2 }, { steps: [10, 50, 100], maxFailRate: 0, soakMs: 100, timeoutMs: 30000, onStep: () => traffic(50) });
  const onV2 = running(nodes, "edge", H.v2).length;
  // June 8: the customer's config reaches every edge at once (it is data, so no rollout applies).
  for (const n of nodes) n.host.setBound("cfg.acme.shards", 0);
  const june = await traffic(requests);
  const c = fleet.convergence("prod");
  const llpResult = {
    may12RolloutPassed: may.ok, edgesOnV2BeforeTrigger: onV2,
    ...june, requestsFailed: june.total - june.served,
    perHostReverts: nodes.reduce((a, n) => a + n.reverts, 0), edgesNowOnV1: running(nodes, "edge", H.v1).length,
    controllerSees: { reverted: c.reverted, live: c.live, converged: c.converged }, // the alarm: every host reports a revert of the current release
  };
  // Which edges still serve? One more request for another customer on each.
  let up = 0;
  for (const n of nodes) { const b0 = n.host.kv.get("served"); await n.host.dispatch("edge", "req", "news/check"); up += n.host.kv.get("served") === b0 + 1; }
  llpResult.edgesDown = edges - up;
  // Is acme served after the revert? (v1 has no sharding, so its setting is harmless there.)
  const n0 = nodes[0], b = n0.host.kv.get("served");
  await n0.host.dispatch("edge", "req", "acme/after");
  llpResult.acmeServedAfterRevert = n0.host.kv.get("served") === b + 1;
  close();
  return { case: "fastly", edges, requestsPerEdge: requests, customers: CUSTOMERS.length, legacy: legacyResult, llp: llpResult };
}
