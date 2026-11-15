// Proof that a bad layer can't freeze or exhaust the host: every layer runs in its own worker
// with a time limit and a memory cap. Each check runs a real layer that misbehaves on purpose.
import { readFileSync } from "node:fs";
import { LiveHost, sha256, generatePublisherKey, signManifest, DEFAULT_LIMITS } from "../host/llp-core.js";

const read = (f) => new Uint8Array(readFileSync(new URL(`../build/${f}`, import.meta.url)));
const results = [];
const check = (name, cond, detail = "") => { results.push({ name, pass: !!cond, detail }); console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };

const store = new Map();
async function put(f) { const b = read(f); const h = await sha256(b); store.set(h, b); return h; }
const fetchBlob = async (h) => store.get(h);
const publisher = await generatePublisherKey();
const v2 = await put("tasks_v2.wasm"), hang = await put("tasks_hang.wasm"), hangMigrate = await put("tasks_hang_migrate.wasm"), stats = await put("stats.wasm");

let lastTree = null;
const host = new LiveHost({ app: "demo.tasks", trustedKeys: [publisher.publicJwk], onRender: (t) => { lastTree = t; } });
const textOf = (n) => !n ? "" : n.k === "text" ? n.t : (n.c || []).map(textOf).join(" ");
const screen = () => lastTree.map((s) => s.error ? `!! ${s.error}` : textOf(s.tree)).join(" | ");
let version = 0;
async function ship(main) {
  const m = { app: "demo.tasks", version: ++version, layers: { main, footer: stats }, order: ["main", "footer"] };
  return host.apply(m, await signManifest(m, publisher.privateKey), fetchBlob);
}
const lastLog = (kind) => host.history.filter((e) => e.kind === kind).at(-1)?.msg ?? "";

// The host's own thread must keep ticking while a layer spins: that's the freeze we're fixing.
let maxGap = 0, last = performance.now();
const ticker = setInterval(() => { const n = performance.now(); maxGap = Math.max(maxGap, n - last); last = n; }, 2);
const timed = async (fn) => { maxGap = 0; last = performance.now(); const t = performance.now(); const r = await fn(); return { r, ms: +(performance.now() - t).toFixed(1), gap: +maxGap.toFixed(1) }; };
const limit = DEFAULT_LIMITS.callMs, first = DEFAULT_LIMITS.firstCallMs;

// Baseline: v2 + C footer, with some state.
await ship(v2);
host.setBound("draft", "Buy milk"); await host.dispatch("main", "add");
const n0 = host.kv.get("tasks.n");
check("S0 baseline app is live", screen().includes("Tasks v2") && screen().includes("Buy milk"), screen());

// 1. Infinite loop in llp_view during the pre-swap health check.
host.setBound("draft", "hang view");
let t = await timed(() => ship(hang));
check("S1 infinite loop in view (at swap time) is killed and the swap refused", !t.r.ok && /time limit/.test(t.r.reason) && t.ms < first + 200, `${t.r.reason}; refused in ${t.ms} ms`);
check("S2 host thread kept running during the loop", t.gap < 50, `longest stall ${t.gap} ms`);
host.setBound("draft", ""); await host.render();
check("S3 old version still live after the refused swap", screen().includes("Tasks v2") && host.slots.get("main").hash === v2, screen());

// 2. Infinite loop in llp_migrate.
const migratedBefore = host.kv.get("migrated.from");
t = await timed(() => ship(hangMigrate));
check("S4 infinite loop in migrate is killed; swap refused; state untouched", !t.r.ok && /llp_migrate/.test(t.r.reason) && /time limit/.test(t.r.reason) && host.kv.get("migrated.from") === migratedBefore && host.kv.get("__schema.main") === 2,
  `${t.r.reason}; ${t.ms} ms; stall ${t.gap} ms`);

// 3. Infinite loop in llp_view after going live.
let r = await ship(hang);
check("S5 the test layer goes live when it isn't triggered", r.ok, `${r.ms} ms`);
host.setBound("draft", "hang view");
t = await timed(() => host.render());
check("S6 infinite loop in view at runtime → killed and reverted to the previous version", host.slots.get("main").hash === v2 && screen().includes("Tasks v2") && /time limit/.test(lastLog("rollback")),
  `${lastLog("rollback")}; ${t.ms} ms; stall ${t.gap} ms`);
check("S7 the other layer (C footer) kept rendering", screen().includes("C layer"), screen());
host.setBound("draft", "");

// 4. Infinite loop in llp_event, after the layer already wrote state.
r = await ship(hang);
host.setBound("draft", "hang event");
t = await timed(() => host.dispatch("main", "add"));
check("S8 infinite loop in event → killed, its state writes discarded, reverted", host.kv.get("tasks.n") === n0 && host.slots.get("main").hash === v2 && /time limit/.test(lastLog("rollback")),
  `tasks.n=${host.kv.get("tasks.n")} (was ${n0}); ${t.ms} ms; stall ${t.gap} ms`);

// 5. Memory blowup: allocate 1 MB at a time forever.
host.setBound("draft", "");
r = await ship(hang);
const rss0 = process.memoryUsage().rss;
host.setBound("draft", "blow memory");
t = await timed(() => host.dispatch("main", "add"));
const grew = Math.round((process.memoryUsage().rss - rss0) / 2 ** 20);
check("S9 memory blowup stops at the memory cap; state writes discarded; reverted", host.kv.get("tasks.n") === n0 && host.slots.get("main").hash === v2 && /memory at \d+ of 32 MB/.test(lastLog("rollback")),
  `${lastLog("rollback")}; process grew ${grew} MB; ${t.ms} ms`);

// 6. UI flood: a million nodes in one render.
host.setBound("draft", "");
r = await ship(hang);
host.setBound("draft", "flood ui");
t = await timed(() => host.render());
check("S10 UI flood is capped and reverted", host.slots.get("main").hash === v2 && /UI exceeded/.test(lastLog("rollback")), `${lastLog("rollback")}; ${t.ms} ms`);

// 7. After all that, the app still works and still accepts swaps.
host.setBound("draft", "Still alive"); await host.dispatch("main", "add");
r = await ship(hang);
check("S11 app still takes events and swaps after every kill", host.kv.get("tasks.n") === n0 + 1 && r.ok && screen().includes("Still alive"), screen());

// 7b. Inputs and clicks sent back-to-back without waiting keep their order.
const nOrder = host.kv.get("tasks.n");
host.setBound("draft", "First"); const c1 = host.dispatch("main", "add");
host.setBound("draft", "Second"); const c2 = host.dispatch("main", "add");
await Promise.all([c1, c2]);
check("S11b typed input and clicks sent without waiting keep their order", host.kv.get("tasks.n") === nOrder + 2 && host.kv.get(`tasks.${nOrder}.text`) === "First" && host.kv.get(`tasks.${nOrder + 1}.text`) === "Second",
  `${host.kv.get(`tasks.${nOrder}.text`)}, ${host.kv.get(`tasks.${nOrder + 1}.text`)}`);

// 8. No previous version: the slot shows an error for that render, then recovers in a fresh worker.
const solo = new LiveHost({ allowUnsigned: true, onRender: (t) => { lastTree = t; } });
solo.setBound("draft", "");
let m = { app: "solo", version: 1, layers: { main: hang }, order: ["main"] };
await solo.apply(m, "", fetchBlob);
solo.setBound("draft", "hang view"); await solo.render();
const errShown = screen().startsWith("!!");
solo.setBound("draft", ""); await solo.render();
check("S12 with no version to revert to, the slot errors once and then recovers", errShown && screen().includes("Tasks v2"), screen());

// 9. Overhead of running in a worker.
const swaps = [];
for (let i = 0; i < 10; i++) { await new Promise((res) => setTimeout(res, 60)); swaps.push((await ship(i % 2 ? hang : v2)).ms); }
swaps.sort((a, b) => a - b);
const t0 = performance.now(); for (let i = 0; i < 500; i++) await host.render(); const per = (performance.now() - t0) / 500;
check("S13 swap stays fast in a worker (median of 10 swaps < 25 ms)", swaps[5] < 25, `median ${swaps[5]} ms, max ${swaps.at(-1)} ms`);
check("S14 two-layer render stays well under a 60 fps frame", per < 4, `${per.toFixed(3)} ms per render`);

// 10. Opt-in inline mode (for simulating many devices in one process) still runs the app.
const inl = new LiveHost({ allowUnsigned: true, limits: { isolation: "inline" }, onRender: (t) => { lastTree = t; } });
m = { app: "inline", version: 1, layers: { main: v2, footer: stats }, order: ["main", "footer"] };
r = await inl.apply(m, "", fetchBlob);
inl.setBound("draft", "Inline task"); await inl.dispatch("main", "add");
check("S15 inline isolation (opt-in, no time limit) runs layers without workers", r.ok && screen().includes("Inline task") && inl.spare === null, screen());

clearInterval(ticker);
host.close(); solo.close();
const failed = results.filter((x) => !x.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
