// Case 1: CrowdStrike, 19 July 2024. A content update (Channel File 291) went to every online
// Windows sensor at once. Its template instances read a 21st input field that the sensor never
// supplied; the out-of-bounds read crashed the kernel driver, and the machines boot-looped.
import { LegacyHost, makeFleet, wasm, now, pct, running } from "./lib.mjs";

const ipc = () => Array.from({ length: 20 }, (_, i) => i === 3 ? "\\\\.\\pipe\\svc" : `f${i}`).join(",");

export async function run({ hosts = 1000 } = {}) {
  const good = wasm("cs_sensor"), bad = wasm("cs_sensor_291");

  // ---- A: the incident's delivery model: the update goes to everyone at once ----
  const legacy = Array.from({ length: hosts }, (_, i) => new LegacyHost(i));
  for (const h of legacy) { h.install(good); h.event("ipc", ipc()); }
  const upBefore = legacy.filter((h) => !h.down).length;
  for (const h of legacy) h.install(bad);           // pushed to 100% of hosts
  for (const h of legacy) h.event("ipc", ipc());    // the next named-pipe event on each machine
  const legacyDown = legacy.filter((h) => h.down).length;
  // A reboot reloads the same file and crashes again (the boot loop): try it once on every host.
  for (const h of legacy) { if (h.down) { h.install(bad); h.event("ipc", ipc()); } }
  const legacyStillDown = legacy.filter((h) => h.down).length;

  // ---- B: the same update through LLP ----
  // Many simulated machines share one process, so layers run inline (no worker per host). A trap is
  // caught the same way inline as in a worker; only the time budget needs workers (case 3 uses them).
  const { fleet, nodes, close } = await makeFleet({ app: "falcon.sensor", n: hosts, limits: { isolation: "inline" } });
  const H = { good: await fleet.addBlob(good), bad: await fleet.addBlob(bad) };
  await fleet.publish("prod", { sensor: H.good });
  for (const n of nodes) n.connect();
  await fleet.waitForConvergence("prod", 60000);
  for (const n of nodes) await n.host.dispatch("sensor", "ipc", ipc());
  const scannedBefore = nodes.reduce((a, n) => a + n.host.kv.get("scanned"), 0);

  const everBad = new Set();
  const t0 = now();
  const r = await fleet.rollout("prod", { sensor: H.bad }, {
    steps: [1, 10, 50, 100], maxFailRate: 0, soakMs: 300, timeoutMs: 60000,
    // Machines keep producing IPC events while the update is out: one per host per step.
    onStep: async () => {
      for (const n of running(nodes, "sensor", H.bad)) everBad.add(n.id);
      await Promise.all(nodes.map((n) => n.host.dispatch("sensor", "ipc", ipc())));
    },
  });
  const recoveredMs = now() - t0;
  // After the rollback, is every sensor still up and scanning?
  const before = nodes.map((n) => n.host.kv.get("scanned"));
  await Promise.all(nodes.map((n) => n.host.dispatch("sensor", "ipc", ipc())));
  const scanning = nodes.filter((n, i) => n.host.kv.get("scanned") === before[i] + 1).length;
  const onBadNow = running(nodes, "sensor", H.bad).length;
  const dropped = nodes.reduce((a, n) => a + n.reverts, 0);
  const result = {
    case: "crowdstrike", hosts,
    legacy: { upBefore, crashed: legacyDown, crashedPct: pct(legacyDown, hosts), stillDownAfterReboot: legacyStillDown, recovery: "manual, per machine (not simulated)" },
    llp: {
      haltedAt: r.haltedAt, reason: r.reason, steps: r.steps, rolledBack: !r.ok, recovered: r.recovered,
      hostsThatRanBadUpdate: everBad.size, hostsThatRanBadPct: pct(everBad.size, hosts),
      hostsDown: hosts - scanning, onBadUpdateAtEnd: onBadNow,
      eventsDropped: dropped, // the one event per exposed host whose transaction trapped and was reverted
      msPublishToFleetRolledBack: Math.round(recoveredMs), scannedBefore,
    },
  };
  close();
  return result;
}
