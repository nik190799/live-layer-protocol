// Case 2: Knight Capital, 1 August 2012. New router code (RLP) was copied by hand to 7 of 8 SMARS
// servers. It reused a flag that, on old code, switched on the dead "Power Peg" feature. The 8th
// server still ran old code, so every flagged order sent to it set off Power Peg, which never saw
// its orders as filled and kept sending child orders. Rolling the 7 servers back made it worse.
//
// Simulated time: 45 minutes in 10-second market ticks; 212 flagged parent orders (the SEC's figure)
// spread evenly over the window and round-robined over the 8 servers.
import { LegacyHost, makeFleet, wasm, pct } from "./lib.mjs";

const TICKS = 270, ORDERS = 212, SERVERS = 8, SHARES = 1000;
const orderAt = new Map(); // tick -> [order index]
for (let i = 0; i < ORDERS; i++) { const t = Math.floor(i * TICKS / ORDERS); orderAt.set(t, [...(orderAt.get(t) ?? []), i]); }
const minute = (tick) => +(tick / 6).toFixed(1);

function legacyRun({ rollbackAtTick = null } = {}) {
  const oldCode = wasm("kn_smars_old"), rlp = wasm("kn_smars_rlp");
  const servers = Array.from({ length: SERVERS }, (_, i) => new LegacyHost(i));
  servers.forEach((s, i) => s.install(i < 7 ? rlp : oldCode)); // the 8th copy never happened
  for (let t = 0; t < TICKS; t++) {
    if (t === rollbackAtTick) for (let i = 0; i < 7; i++) { const kv = servers[i].kv; servers[i].install(oldCode); servers[i].kv = kv; }
    for (const i of orderAt.get(t) ?? []) servers[i % SERVERS].event("order", `${SHARES},1`);
    for (const s of servers) s.event("tick");
  }
  return tally(servers.map((s) => s.kv));
}
function tally(kvs) {
  const child = kvs.reduce((a, kv) => a + (kv.get("child") ?? 0), 0);
  const shares = kvs.reduce((a, kv) => a + (kv.get("shares") ?? 0), 0);
  return { parentOrders: ORDERS, childOrders: child, unintendedChildOrders: child - ORDERS, shares, intendedShares: ORDERS * SHARES, perServer: kvs.map((kv) => kv.get("child") ?? 0) };
}

// LLP: the 8th server's control channel is down when the release goes out (the stand-in for the
// copy that never happened). It keeps taking orders. It comes back at `healAtTick`.
async function llpRun({ gate, healAtTick }) { // gate: null | "converged" | "complete"
  const { fleet, nodes, close } = await makeFleet({ app: "smars", n: SERVERS, ids: (i) => `smars-${i + 1}` });
  const H = { old: await fleet.addBlob(wasm("kn_smars_old")), rlp: await fleet.addBlob(wasm("kn_smars_rlp")) };
  await fleet.publish("prod", { router: H.old });
  for (const n of nodes) n.connect();
  await fleet.waitForConvergence("prod", 30000);
  nodes[7].partition();
  const r = await fleet.rollout("prod", { router: H.rlp }, { steps: [100], timeoutMs: 3000 });
  const report = fleet.convergence("prod");
  const laggards = nodes.filter((n) => !n.online).map((n) => n.id);
  let flagOnAt = null, convergedAt = null;
  for (let t = 0; t < TICKS; t++) {
    if (t === healAtTick) { nodes[7].connect(); await fleet.waitFor(() => fleet.convergence("prod").complete, 30000); }
    const c = fleet.convergence("prod");
    if (c.complete && convergedAt === null) convergedAt = t;
    // The gate: flagged (RLP) orders are only sent once the report says the fleet is on the release.
    const flag = gate ? (c[gate] ? 1 : 0) : 1;
    if (flag && flagOnAt === null) flagOnAt = t;
    for (const i of orderAt.get(t) ?? []) await nodes[i % SERVERS].host.dispatch("router", "order", `${SHARES},${flag}`);
    await Promise.all(nodes.map((n) => n.host.dispatch("router", "tick")));
  }
  const out = {
    ...tally(nodes.map((n) => n.host.kv)),
    rolloutResult: { ok: r.ok, reason: r.reason ?? null },
    convergenceAtRelease: { live: report.live, offline: report.offline, converged: report.converged, complete: report.complete, laggards },
    flagOnAtMinute: flagOnAt === null ? null : minute(flagOnAt), allServersOnNewCodeAtMinute: convergedAt === null ? null : minute(convergedAt),
  };
  close();
  return out;
}

export async function run({ healAtTick = 30 } = {}) {
  return {
    case: "knight", servers: SERVERS, minutes: TICKS / 6, partitionHealsAtMinute: minute(healAtTick),
    legacy: legacyRun(),
    legacyWithRollback: { rollbackAtMinute: minute(TICKS / 2), ...legacyRun({ rollbackAtTick: TICKS / 2 }) },
    llpGatedOnComplete: await llpRun({ gate: "complete", healAtTick }),
    llpGatedOnConverged: await llpRun({ gate: "converged", healAtTick }), // the signal LLP had before this study
    llpUngated: await llpRun({ gate: null, healAtTick }),
  };
}
