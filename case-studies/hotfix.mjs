// Case 5: "the hotfix waits on a release". Not one incident but a pattern: a one-line bug in a live
// app or game is found, the fix takes minutes to write, and then days to reach users through build,
// store review and users updating. Here: a live game where shop items cost 10x by mistake.
// Measured: how long the fix takes to reach every running client through LLP, and whether any
// player loses their session (coins, level, items) on the way.
import { makeFleet, wasm, now, running } from "./lib.mjs";

export async function run({ clients = 1000 } = {}) {
  const { fleet, nodes, close } = await makeFleet({ app: "game.client", n: clients, limits: { isolation: "inline" } });
  const H = { v1: await fleet.addBlob(wasm("hf_game_v1")), v2: await fleet.addBlob(wasm("hf_game_v2")) };
  await fleet.publish("prod", { game: H.v1 });
  for (const n of nodes) n.connect();
  await fleet.waitForConvergence("prod", 60000);
  // Every player is mid-session: a few wins, and a failed purchase (100 coins can't buy a 10x item).
  for (const [i, n] of nodes.entries()) { for (let w = 0; w < 2 + (i % 5); w++) await n.host.dispatch("game", "win"); await n.host.dispatch("game", "buy", "80"); }
  const snap = (n) => ["coins", "level", "items"].map((k) => n.host.kv.get(k) ?? 0).join("/");
  const before = nodes.map(snap);
  const boughtBefore = nodes.filter((n) => (n.host.kv.get("items") ?? 0) > 0).length;

  const t0 = now();
  const r = await fleet.rollout("prod", { game: H.v2 }, { steps: [1, 10, 50, 100], maxFailRate: 0, timeoutMs: 60000 });
  const ms = now() - t0;
  const sameSession = nodes.filter((n, i) => snap(n) === before[i]).length;
  for (const n of nodes) await n.host.dispatch("game", "buy", "80"); // the same purchase, after the fix
  const boughtAfter = nodes.filter((n) => (n.host.kv.get("items") ?? 0) > 0).length;
  const out = {
    case: "hotfix", clients, rolloutOk: r.ok, converged: r.converged, steps: r.steps.map((s) => s.percent),
    msFixPublishedToAllClients: Math.round(ms), clientsOnFix: running(nodes, "game", H.v2).length,
    sessionsPreserved: sameSession, sessionsLost: clients - sameSession,
    purchaseWorksBefore: boughtBefore, purchaseWorksAfter: boughtAfter,
  };
  close();
  return out;
}
