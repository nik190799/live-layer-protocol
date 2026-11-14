// Simulated fleet member: opens `count` independent Live Hosts in this process, each with its
// own WebSocket to the publisher, own blob store and own state. Client logic is the same as
// host/node-host.mjs (hello -> manifest -> want -> blob -> apply -> ack), minus terminal drawing.
// Prints "LIVE <hostId> <version> <epochMs>" each time a host goes live on a new version.
// Usage: node bench/sim-hosts.mjs <url> <pubkey.json> <count> <idOffset>
import { readFileSync } from "node:fs";
import { LiveHost, b64 } from "../host/llp-core.js";
import { now } from "./lib.mjs";

const [url, keyFile, count = "1", offset = "0"] = process.argv.slice(2);
const trusted = JSON.parse(readFileSync(keyFile, "utf8"));
let open = 0;

function startHost(id) {
  // Hundreds of simulated devices share one process, so layers run inline: a real device runs its own
  // workers, and that per-device cost is measured in the pipeline section (bench/run.mjs).
  const host = new LiveHost({ trustedKeys: [trusted], limits: { isolation: "inline" } });
  const ws = new WebSocket(url);
  const pending = new Map();
  const send = (m) => ws.send(JSON.stringify(m));
  ws.onopen = () => { send({ t: "hello", app: "demo.tasks", version: host.version }); if (++open === +count) console.log("READY"); };
  ws.onmessage = async (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.t === "blob") pending.get(msg.hash)?.(b64.dec(msg.data));
    if (msg.t === "manifest") {
      const r = await host.apply(msg.manifest, msg.sig, (h) => new Promise((res) => { pending.set(h, res); send({ t: "want", hashes: [h] }); }));
      if (r.ok) {
        // seed some user state on first go-live so later swaps carry real data
        if (!host.seeded) { host.seeded = true; for (const t of ["Buy milk", "Call mom"]) { host.setBound("draft", t); await host.dispatch("main", "add"); } }
        console.log(`LIVE ${id} ${r.version} ${now().toFixed(3)} ${r.ms} ${countTasks(host)}`);
      } else console.log(`NACK ${id} ${r.version} ${r.reason}`);
      send(r.ok ? { t: "ack", version: r.version, ms: r.ms } : { t: "nack", version: r.version, reason: r.reason });
    }
  };
}
const countTasks = (host) => host.kv.get("tasks.n") ?? 0;
for (let i = 0; i < +count; i++) startHost(+offset + i);
