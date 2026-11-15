// End-to-end proof tests for LLP v0. Each check maps to an assumption in the design doc.
import { readFileSync } from "node:fs";
import { LiveHost, sha256, generatePublisherKey, signManifest } from "../host/llp-core.js";

const read = (f) => new Uint8Array(readFileSync(new URL(`../build/${f}`, import.meta.url)));
const results = [];
const check = (name, cond, detail = "") => { results.push({ name, pass: !!cond, detail }); console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };

const store = new Map(); // publisher-side content store
async function put(f) { const b = read(f); const h = await sha256(b); store.set(h, b); return h; }
const fetchBlob = async (h) => store.get(h);
let fetches = 0;
const countingFetch = async (h) => { fetches++; return store.get(h); };

const publisher = await generatePublisherKey();
const attacker = await generatePublisherKey();
const sign = (m, k = publisher.privateKey) => signManifest(m, k);
const tasks = await put("tasks.wasm"), stats = await put("stats.wasm");
const v2 = await put("tasks_v2.wasm"), broken = await put("tasks_broken.wasm"), trap = await put("tasks_trap.wasm");

const haptics = [];
let lastTree = null;
const host = new LiveHost({
  app: "demo.tasks",
  trustedKeys: [publisher.publicJwk],
  capabilities: { haptic: async (ms) => { haptics.push(+ms); }, geo: async () => "41.88, -87.63 (test fixture)" },
  onRender: (t) => { lastTree = t; },
});
const textOf = (n) => !n ? "" : n.k === "text" ? n.t : (n.c || []).map(textOf).join(" ");
const screen = () => lastTree.map((s) => textOf(s.tree)).join(" | ");

// 1. Two languages, one app, one interface
let m = { app: "demo.tasks", version: 1, layers: { main: tasks, footer: stats }, order: ["main", "footer"] };
let r = await host.apply(m, await sign(m), countingFetch);
check("A1 layers in 2 languages (AssemblyScript + C) run side by side", r.ok && screen().includes("Tasks") && screen().includes("C layer"), screen());

// 2. Interaction + shared host state across languages
host.setBound("draft", "Write spec"); await host.dispatch("main", "add");
host.setBound("draft", "Ship demo"); await host.dispatch("main", "add");
await host.dispatch("main", "t:0");
check("A2 events mutate host-owned state; C layer sees AS layer's state", screen().includes("1 of 2 done") && screen().includes("50%"), screen());
check("A3 capability request reaches host (haptic)", haptics[0] === 20);
await host.dispatch("footer", "where"); await new Promise((r) => setTimeout(r, 10));
check("A4 async capability result flows back as an event (geo)", screen().includes("41.88"));

// 3. Live swap with state preserved + schema migration
fetches = 0;
m = { app: "demo.tasks", version: 2, layers: { main: v2, footer: stats }, order: ["main", "footer"] };
r = await host.apply(m, await sign(m), countingFetch);
check("A5 live swap keeps state (tasks survive)", r.ok && screen().includes("Tasks v2") && screen().includes("1 of 2 done"), `${r.ms} ms`);
check("A6 swap latency under 100 ms", r.ok && r.ms < 100, `${r.ms} ms`);
check("A7 only changed layers are fetched (content addressing)", fetches === 1, `${fetches} blob fetched`);
check("A8 schema migration ran on real state", host.kv.get("tasks.0.pri") === 1 && host.kv.get("migrated.from") === 1);

// 4. Safety
m = { app: "demo.tasks", version: 3, layers: { main: broken, footer: stats }, order: ["main", "footer"] };
r = await host.apply(m, await sign(m), fetchBlob);
check("A9 broken layer rejected before going live; old version keeps running", !r.ok && screen().includes("Tasks v2"), r.reason);
m = { app: "demo.tasks", version: 4, layers: { main: v2, footer: stats }, order: ["main"] };
r = await host.apply(m, await sign(m, attacker.privateKey), fetchBlob);
check("A10 manifest signed by untrusted key rejected", !r.ok, r.reason);
m = { app: "demo.tasks", version: 1, layers: { main: tasks, footer: stats }, order: ["main", "footer"] };
r = await host.apply(m, await sign(m), fetchBlob);
check("A11 rollback/replay attack (older version) rejected", !r.ok, r.reason);
const evil = new Map(store);
r = await host.apply({ app: "demo.tasks", version: 5, layers: { main: trap, footer: stats }, order: ["main", "footer"] },
  await sign({ app: "demo.tasks", version: 5, layers: { main: trap, footer: stats }, order: ["main", "footer"] }),
  async (h) => h === trap ? read("tasks.wasm") : evil.get(h));
check("A12 tampered blob (hash mismatch) rejected", !r.ok, r.reason);

m = { app: "demo.tasks", version: 6, layers: { main: trap, footer: stats }, order: ["main", "footer"] };
r = await host.apply(m, await sign(m), fetchBlob);
const before = host.kv.get("tasks.n");
host.setBound("draft", "this will trap"); await host.dispatch("main", "add");
check("A13 runtime trap → state restored + auto-revert to previous layer", r.ok && host.kv.get("tasks.n") === before && screen().includes("Tasks v2"),
  host.history.filter((e) => e.kind === "rollback").map((e) => e.msg).join("; "));

// 5. Throughput: how fast is one render?
const t0 = performance.now(); for (let i = 0; i < 1000; i++) await host.render(); const per = (performance.now() - t0) / 1000;
check("A14 full render of both layers is fast enough for 60 fps", per < 16, `${per.toFixed(3)} ms per render`);

const failed = results.filter((x) => !x.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
