// One legacy edge server for case 3: runs the WAF layer on its own thread with no time budget.
import { parentPort, workerData } from "node:worker_threads";
import { LegacyHost } from "./lib.mjs";
const h = new LegacyHost(workerData.id);
h.install(workerData.bytes);
parentPort.on("message", (m) => {
  if (m.install) { h.install(m.install); return; }
  const ok = h.event("req", m.body);
  parentPort.postMessage({ seq: m.seq, ok });
});
