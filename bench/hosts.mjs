// Scale measurements for the server host (SPEC section 10 open questions). Writes docs/hosts-results.json.
// Usage: node bench/hosts.mjs [--quick]
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { sha256, LiveHost, generatePublisherKey, signManifest } from "../host/llp-core.js";
import { ServerHost, ServerLiveHost, tokenAuth } from "../host/server-host.mjs";
import { connectServer } from "../host/remote-client.mjs";

const quick = process.argv.includes("--quick");
const read = (f) => new Uint8Array(readFileSync(new URL(`../build/${f}`, import.meta.url)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, ms = 60000) { const t = performance.now(); while (!(await cond())) { if (performance.now() - t > ms) return false; await sleep(2); } return true; }
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return +s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))].toFixed(2); };
const out = { node: process.version, when: new Date().toISOString(), sizes: [], fanout: null, throughput: null };

const key = await generatePublisherKey();
const blobs = new Map();
const put = async (f) => { const b = read(f); const h = await sha256(b); blobs.set(h, b); return h; };
const sync1 = await put("tasks_sync.wasm"), sync2 = await put("tasks_sync_v2.wasm"), shared = await put("tasks_shared.wasm");
const fetchBlob = async (h) => blobs.get(h);
let ver = 0;
const manifest = async (layers, hosts) => { const m = { app: "bench", version: ++ver, layers, order: ["main"], hosts }; return [m, await signManifest(m, key.privateKey)]; };

// 1. Store size: per-call cost, swap + migration of every task, client connect.
const SIZES = quick ? [1000, 100000] : [1000, 100000, 333333];
const auth = tokenAuth("bench");
for (const tasks of SIZES) {
  const server = new ServerHost({ trustedKeys: [key.publicJwk], authenticate: auth.authenticate, limits: { callMs: 30000, loadMs: 30000, heapMb: 1024 } });
  const port = await server.listen(0);
  const t = server.tenant("bench");
  const [m1, s1] = await manifest({ main: shared, sync: sync1 }, { main: "client", sync: "server" });
  await server.offer(m1, s1, fetchBlob);
  for (let i = 0; i < tasks; i++) { t.host.kv.set(`shared/tasks.${i}.text`, `task number ${i}`); t.host.kv.set(`shared/tasks.${i}.by`, "seed"); t.host.kv.set(`shared/tasks.${i}.done`, 0); }
  t.host.kv.set("shared/tasks.n", tasks);
  t.dirty.clear();
  const keys = t.host.kv.size;
  let t0 = performance.now();
  await t.host.invoke("sync", "count", "bench", "", ver); // first call after seeding: the worker gets a full copy once
  const firstCallMs = performance.now() - t0;
  const lat = [];
  for (let i = 0; i < 50; i++) { const t0 = performance.now(); await t.host.invoke("sync", "add", "bench", `added ${i}`, ver); lat.push(performance.now() - t0); }
  t.dirty.clear();
  // Swap to v2: a new worker gets a full copy of the store once, then migrate writes .pri on every task.
  const [m2, s2] = await manifest({ main: shared, sync: sync2 }, { main: "client", sync: "server" });
  t0 = performance.now();
  const r = await server.offer(m2, s2, fetchBlob);
  const swapMs = performance.now() - t0;
  const lat2 = [];
  for (let i = 0; i < 20; i++) { const t1 = performance.now(); await t.host.invoke("sync", "count", "bench", "", ver); lat2.push(performance.now() - t1); }
  // A client connecting mirrors shared/ (all of it, or only the prefixes it watches), then swaps.
  const connect = async (watch) => {
    const c = new LiveHost({ app: "bench", trustedKeys: [key.publicJwk] });
    const t2 = performance.now();
    const link = connectServer(c, `ws://127.0.0.1:${port}`, { app: "bench", token: auth.issue("u", "bench"), watch });
    const ok = await until(() => c.version === ver || c.history.some((h) => h.kind === "reject"), 30000);
    const res = c.version === ver ? +(performance.now() - t2).toFixed(0) : `failed: ${c.history.find((h) => h.kind === "reject")?.msg ?? "timeout"}`;
    link.close(); c.close();
    return res;
  };
  const connectMs = await connect();
  const connectWatchMs = await connect(["shared/tasks.n"]);
  const mem = process.memoryUsage().rss;
  const row = { tasks, keys, firstCallMs: +firstCallMs.toFixed(0), callP50: pct(lat, 50), callP99: pct(lat, 99), afterSwapP50: pct(lat2, 50), swapWithMigrationMs: +swapMs.toFixed(0), swapOk: r.ok, swapReason: r.reason, clientConnectAllMs: connectMs, clientConnectWatchMs: connectWatchMs, rssMb: Math.round(mem / 2 ** 20) };
  out.sizes.push(row);
  console.log(row);
  server.close();
  await sleep(200);
}

// 2. Fan-out: how long from the server committing vN until every client has swapped (window sizing).
{
  const N = quick ? 10 : 40;
  const server = new ServerHost({ trustedKeys: [key.publicJwk], authenticate: auth.authenticate });
  const port = await server.listen(0);
  const [m1, s1] = await manifest({ main: shared, sync: sync1 }, { main: "client", sync: "server" });
  await server.offer(m1, s1, fetchBlob);
  const clients = Array.from({ length: N }, (_, i) => { const h = new LiveHost({ app: "bench", trustedKeys: [key.publicJwk] }); return { h, link: connectServer(h, `ws://127.0.0.1:${port}`, { app: "bench", token: auth.issue("u" + i, "bench") }) }; });
  await until(() => clients.every((c) => c.h.version === ver));
  const rounds = [];
  for (let round = 0; round < 5; round++) {
    // A server-only change (a new server slot each round); the client slot is unchanged, so this
    // measures relay + signature check + commit on the client.
    const [m, s] = await manifest({ main: shared, sync: sync1, [`job${round}`]: sync1 }, { main: "client", sync: "server", [`job${round}`]: "server" });
    const t0 = performance.now();
    const ok = (await server.offer(m, s, fetchBlob)).ok;
    if (!ok) throw new Error("server refused a bench manifest");
    const committed = performance.now();
    const done = [];
    for (const c of clients) until(() => c.h.version === m.version).then(() => done.push(performance.now() - committed));
    await until(() => done.length === N);
    rounds.push({ serverMs: +(committed - t0).toFixed(1), p50: pct(done, 50), max: pct(done, 100) });
  }
  // A version that also changes the client slot (each client boots a worker and swaps).
  const tasks2 = await put("tasks_shared_v2.wasm");
  const [m, s] = await manifest({ main: tasks2, sync: sync2 }, { main: "client", sync: "server" });
  await server.offer(m, s, fetchBlob);
  const committed = performance.now();
  const done = [];
  for (const c of clients) until(() => c.h.version === m.version).then(() => done.push(performance.now() - committed));
  await until(() => done.length === N);
  out.fanout = { clients: N, serverOnlyChange: rounds, clientSlotChange: { p50: pct(done, 50), max: pct(done, 100) } };
  console.log(JSON.stringify(out.fanout));

  // 3. Throughput: one tenant's calls are serialized (one shared store, one writer at a time).
  const t = server.tenant("bench");
  const total = quick ? 500 : 2000, inflight = 32;
  let next = 0;
  const t0 = performance.now();
  await Promise.all(Array.from({ length: inflight }, async () => { while (next++ < total) await t.host.invoke("sync", "add", "bench", "x", ver); }));
  const sec = (performance.now() - t0) / 1000;
  out.throughput = { calls: total, inflight, perSecond: Math.round(total / sec) };
  console.log(out.throughput);
  for (const c of clients) { c.link.close(); c.h.close(); }
  server.close();
}

mkdirSync(new URL("../docs/", import.meta.url), { recursive: true });
if (!quick) writeFileSync(new URL("../docs/hosts-results.json", import.meta.url), JSON.stringify(out, null, 2));
process.exit(0);
