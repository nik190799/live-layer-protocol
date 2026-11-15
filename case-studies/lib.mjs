// Shared harness for the case studies (docs/CASE-STUDIES.md).
//
// Every case runs the same WebAssembly layers two ways:
//   LegacyHost  - the incident's delivery model: code is installed in place and runs in the host
//                 process. No signature check, no shadow check, no time budget, no per-host revert.
//                 A trap in the code takes the host process down, like a crashed driver or server.
//   LLP fleet   - real LiveHosts (host/llp-core.js) with FleetAgents (host/fleet.js), driven by the
//                 real FleetController (tools/fleet.mjs): signed manifests, shadow check, staged
//                 rollout with health gates, time and memory budgets, per-host auto revert.
// Hosts and controller talk through JSON messages with 1-10 ms of random latency per hop, like
// test/fleet.mjs. One process stands in for the whole fleet, so absolute times are lower bounds.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LiveHost } from "../host/llp-core.js";
import { FleetAgent, TrustStore } from "../host/fleet.js";
import { FleetController } from "../tools/fleet.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
export const wasm = (name) => new Uint8Array(readFileSync(join(ROOT, "build", name + ".wasm")));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const now = () => performance.now();

// ---------- the old delivery model ----------
export class LegacyHost {
  constructor(id) { this.id = id; this.kv = new Map(); this.down = null; this.ex = null; this.crashes = 0; }
  // Copy the code onto the host and start it. Like the incidents, nothing is checked first.
  install(bytes) {
    const td = new TextDecoder(), te = new TextEncoder();
    let ev = null, mem = null;
    const s = (p, l) => td.decode(new Uint8Array(mem.buffer, p, l));
    const put = (str, p, cap) => { const b = te.encode(str); new Uint8Array(mem.buffer, p, Math.min(b.length, cap)).set(b.subarray(0, cap)); return b.length; };
    const kv = this.kv;
    const llp = {
      ui_begin() {}, ui_attr() {}, ui_text() {}, ui_end() {},
      kv_get_n: (kp, kl, d) => { const v = kv.get(s(kp, kl)); return typeof v === "number" ? v : d; },
      kv_set_n: (kp, kl, v) => { kv.set(s(kp, kl), v); },  // writes land at once: no transaction
      kv_get_s: (kp, kl, bp, cap) => { const v = kv.get(s(kp, kl)); return put(v == null ? "" : String(v), bp, cap); },
      kv_set_s: (kp, kl, vp, vl) => { kv.set(s(kp, kl), s(vp, vl)); },
      ev_id: (bp, cap) => put(ev?.id ?? "", bp, cap), ev_val: (bp, cap) => put(ev?.value ?? "", bp, cap),
      cap: () => 0, log() {}, now: () => Date.now(),
    };
    const inst = new WebAssembly.Instance(new WebAssembly.Module(bytes), { llp, env: { abort: () => { throw new Error("abort"); }, seed: () => 1 } });
    mem = inst.exports.memory;
    this.ex = inst.exports;
    this.setEvent = (e) => { ev = e; };
    this.down = null;
  }
  // One event. A trap crashes the host process; it stays down until someone fixes it by hand
  // (the bad code is still installed, so a restart would only crash again).
  event(id, value = "") {
    if (this.down) return false;
    this.setEvent({ id, value });
    try { this.ex.llp_event(); return true; } catch (e) { this.down = e.message; this.crashes++; return false; }
  }
}

// ---------- the LLP fleet ----------
export async function makeFleet({ app, n, limits = {}, ids }) {
  const fleet = await FleetController.create({ app, version: 1 });
  const pinned = structuredClone(fleet.keyring);
  const nodes = [];
  for (let i = 0; i < n; i++) {
    const id = ids ? ids(i) : `${app}-${String(i).padStart(4, "0")}`;
    const host = new LiveHost({ limits });
    const agent = new FleetAgent({ host, id, channel: "prod", trust: new TrustStore(structuredClone(pinned)) });
    const node = { id, host, agent, online: false, reverts: 0, swaps: [] };
    const prev = host.onLog; // FleetAgent's hook; keep it and count what happens on this host
    host.onLog = (e) => { prev(e); if (e.kind === "rollback") node.reverts++; if (e.kind === "swap") node.swaps.push(e.version); };
    node.connect = () => {
      const link = { open: true, down: Promise.resolve(), up: Promise.resolve() };
      const later = (dir, f) => { link[dir] = link[dir].then(() => sleep(1 + Math.random() * 9)).then(() => { if (link.open) f(); }); };
      node.link = link;
      node.conn = fleet.attach((m) => { const c = JSON.parse(JSON.stringify(m)); if (link.open) later("down", () => agent.receive(c)); });
      agent.send = (m) => { const c = JSON.parse(JSON.stringify(m)); if (link.open) later("up", () => node.conn.message(c)); };
      node.online = true;
      agent.hello();
    };
    // Control channel down (the host keeps serving traffic; it just can't hear the controller).
    node.partition = () => { node.link.open = false; node.online = false; node.conn.close(); };
    nodes.push(node);
  }
  const close = () => { for (const nd of nodes) { if (nd.link) nd.link.open = false; nd.host.close(); } };
  return { fleet, nodes, close };
}

// Which hosts are running a given layer hash in a slot right now.
export const running = (nodes, slot, hash) => nodes.filter((n) => n.host.slots.get(slot)?.hash === hash);

export const pct = (a, b) => b ? +(100 * a / b).toFixed(1) : 0;
