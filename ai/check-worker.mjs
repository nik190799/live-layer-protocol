// Shadow check, run inside a worker thread (see check.mjs).
// 1. Start the live layers and use the slot being replaced like a person would, to build realistic state.
// 2. Swap the candidate in with the real host core (signature step skipped, everything else the same).
// 3. Click every button and toggle the candidate draws, and fail on any trap or rollback.
import { parentPort, workerData } from "node:worker_threads";
import { LiveHost, sha256 } from "../host/llp-core.js";

const { base, order, candidate } = workerData;
const blobs = new Map();
async function manifest(version, layers) {
  const hashes = {};
  for (const [slot, bytes] of Object.entries(layers)) { const h = await sha256(bytes); blobs.set(h, bytes); hashes[slot] = h; }
  return { app: "shadow", version, layers: hashes, order };
}
const fetchBlob = async (h) => blobs.get(h);

function controls(node, out = { ids: [], binds: [] }) {
  if (!node) return out;
  if ((node.k === "button" || node.k === "toggle") && node.a?.id) out.ids.push(node.a.id);
  if (node.k === "input" && node.a?.bind) out.binds.push(node.a.bind);
  for (const c of node.c || []) controls(c, out);
  return out;
}

async function use(host, slots, rounds, { skip = /^$/ } = {}) {
  for (let r = 0; r < rounds; r++) {
    for (const { slot, tree } of await host.render()) {
      if (!slots.includes(slot)) continue;
      const { ids, binds } = controls(tree);
      for (const b of binds) host.setBound(b, `sample ${r + 1}`);
      for (const id of ids) {
        if (skip.test(id)) continue;
        await host.dispatch(slot, id, "");
        await new Promise((res) => setImmediate(res)); // let capability replies land
      }
    }
  }
}

try {
  const log = [];
  const host = new LiveHost({ onLog: (e) => log.push(e), onRender: () => {} });
  const r1 = await host.apply(await manifest(1, base), "", fetchBlob);
  if (!r1.ok) throw new Error(`the current live layers did not start: ${r1.reason}`);
  await use(host, [candidate.slot], 3, { skip: /clear|delete|remove|reset/i });
  const stateBefore = host.kv.size;

  const r2 = await host.apply(await manifest(2, { ...base, [candidate.slot]: candidate.bytes }), "", fetchBlob);
  if (!r2.ok) throw new Error(`swap refused: ${r2.reason}`);
  const preview = await host.render();

  const mark = log.length;
  await use(host, [candidate.slot], 2);
  const bad = log.slice(mark).find((e) => e.kind === "rollback" || e.kind === "error");
  if (bad) throw new Error(`trapped while its buttons were clicked: ${bad.msg}`);
  const out = await host.render();
  const broken = out.find((s) => s.error);
  if (broken) throw new Error(`${broken.slot} failed to render: ${broken.error}`);

  parentPort.postMessage({ ok: true, stateKeys: stateBefore, preview });
} catch (e) {
  parentPort.postMessage({ ok: false, error: e.message });
}
