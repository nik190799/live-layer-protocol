// Proof for SPEC section 10 (run-anywhere hosts): one signed layer stream, a server host for shared
// data, secrets and heavy compute, client hosts that keep swaps and rollback. Everything runs for
// real: WebSocket links, layer workers, an HTTP payment API, several users and tenants.
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { LiveHost, sha256, b64, generatePublisherKey, signManifest } from "../host/llp-core.js";
import { ServerHost, tokenAuth } from "../host/server-host.mjs";
import { connectServer } from "../host/remote-client.mjs";

const read = (f) => new Uint8Array(readFileSync(new URL(`../build/${f}`, import.meta.url)));
const results = [];
const check = (name, cond, detail = "") => { results.push({ name, pass: !!cond, detail }); console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, ms = 3000) { const t = performance.now(); while (!(await cond())) { if (performance.now() - t > ms) return false; await sleep(5); } return true; }
const textOf = (n) => !n ? "" : n.k === "text" ? n.t : (n.c || []).map(textOf).join(" ");

// ---------- publisher (authority): holds the only signing key ----------
const key = await generatePublisherKey();
const blobs = new Map();
async function put(f) { const b = read(f); const h = await sha256(b); blobs.set(h, b); return h; }
const L = {
  shared: await put("tasks_shared.wasm"), shared2: await put("tasks_shared_v2.wasm"), broken: await put("tasks_broken.wasm"),
  sync: await put("tasks_sync.wasm"), sync2: await put("tasks_sync_v2.wasm"), pay: await put("pay.wasm"), bad: await put("bad.wasm"),
};
const pubWss = new WebSocketServer({ port: 0 });
await new Promise((r) => pubWss.on("listening", r));
const pubUrl = `ws://127.0.0.1:${pubWss.address().port}`;
const latest = new Map(); // app -> { manifest, sig }
const acks = [];
pubWss.on("connection", (ws) => ws.on("message", (raw) => {
  const m = JSON.parse(raw);
  if (m.t === "hello" && latest.has(m.app)) ws.send(JSON.stringify({ t: "manifest", ...latest.get(m.app) }));
  if (m.t === "want") for (const h of m.hashes) ws.send(JSON.stringify({ t: "blob", hash: h, data: b64.enc(blobs.get(h)) }));
  if (m.t === "ack" || m.t === "nack") acks.push({ ...m, at: performance.now() });
}));
let ver = 0;
async function publish(app, layers, hosts, order = ["main"]) {
  const manifest = { app, version: ++ver, layers, order, hosts };
  latest.set(app, { manifest, sig: await signManifest(manifest, key.privateKey) });
  for (const ws of pubWss.clients) ws.send(JSON.stringify({ t: "manifest", ...latest.get(app) }));
  return manifest.version;
}
const serverAck = (v) => until(() => acks.some((a) => a.version === v && a.host === "server"));

// ---------- a payment API that needs a secret ----------
const SECRET = "sk_live_" + crypto.randomUUID();
let charges = 0;
const payApi = createServer((req, res) => {
  let body = ""; req.on("data", (d) => body += d); req.on("end", () => {
    if (req.headers.authorization !== `Bearer ${SECRET}`) { res.writeHead(401); return res.end("bad key"); }
    res.end(`ok ch_${++charges} ${body}`);
  });
}).listen(0);
await new Promise((r) => payApi.on("listening", r));

// ---------- the server host ----------
const auth = tokenAuth("server-session-secret");
const logs = [];
const server = new ServerHost({
  trustedKeys: [key.publicJwk], authenticate: auth.authenticate, windowMs: 400, maxPending: 4,
  capabilities: {
    charge: async (arg) => {
      const r = await fetch(`http://127.0.0.1:${payApi.address().port}/charge`, { method: "POST", headers: { authorization: `Bearer ${SECRET}` }, body: arg });
      if (!r.ok) throw new Error(`payment API said ${r.status}`);
      return r.text();
    },
  },
  onLog: (e) => logs.push({ ...e, at: performance.now() }),
});
const port = await server.listen(0);
const srvUrl = `ws://127.0.0.1:${port}`;
const APP = "demo.shared";
const v1 = await publish(APP, { main: L.shared, sync: L.sync, pay: L.pay }, { main: "client", sync: "server", pay: "server" });
server.subscribe(pubUrl, APP);
await serverAck(v1);
const st = server.tenant(APP);

// ---------- client hosts (two users) ----------
function client(user, opts = {}) {
  const c = { screen: "", rendered: 0 };
  c.host = new LiveHost({ trustedKeys: [key.publicJwk], onRender: (t) => { c.screen = t.map((s) => s.error ? `!! ${s.error}` : textOf(s.tree)).join(" | "); c.rendered++; } });
  c.link = connectServer(c.host, srvUrl, { app: APP, token: opts.token ?? auth.issue(user, APP), upgradeWaitMs: 2000, ...opts });
  return c;
}
const alice = client("alice"), bob = client("bob");
await until(() => alice.host.version === v1 && bob.host.version === v1);

check("H1 each host runs only the slots placed on it", [...st.host.slots.keys()].sort().join() === "pay,sync" && [...alice.host.slots.keys()].join() === "main",
  `server: ${[...st.host.slots.keys()].join(",")}; client: ${[...alice.host.slots.keys()].join(",")}`);
check("H2 the server host holds only public keys (no signing key on a node that runs layers)", server.trustedKeys.every((k) => !k.d) && !JSON.stringify(server.trustedKeys).includes('"d"'));

// ---------- shared data, multi-user ----------
alice.host.setBound("draft", "Ship the server host"); await alice.host.dispatch("main", "add");
let ok = await until(() => bob.screen.includes("Ship the server host (alice)") && alice.host.kv.get("last") === "0");
check("H3 alice's write reaches bob's screen through the server (shared/ read cache)", ok && alice.host.kv.get("last") === "0", bob.screen);
const bobT = performance.now();
bob.host.setBound("draft", "Review it"); await bob.host.dispatch("main", "add");
ok = await until(() => alice.screen.includes("Review it (bob)"));
check("H4 round trip: bob's call → server layer → alice's screen", ok && st.host.kv.get("shared/tasks.n") === 2, `${(performance.now() - bobT).toFixed(1)} ms`);

await alice.host.dispatch("main", "try-write");
await sleep(50);
check("H5 a client layer can't write shared/ (dropped on the client; server untouched)", alice.host.kv.get("shared/tasks.n") === 2 && st.host.kv.get("shared/tasks.n") === 2 && alice.host.history.some((h) => /wrote shared\/ keys on a client/.test(h.msg)));

// A modified client: raw protocol, no layer code in the way.
async function raw(token, app = APP) {
  const ws = new WebSocket(srvUrl); const inbox = [];
  ws.onmessage = (e) => inbox.push(JSON.parse(e.data));
  await new Promise((r) => ws.onopen = r);
  ws.send(JSON.stringify({ t: "hello", app, version: 0, have: [], token }));
  let n = 0;
  const call = async (slot, op, args, version, extra = {}) => {
    const id = "r" + ++n; ws.send(JSON.stringify({ t: "call", id, slot, op, args, version, ...extra }));
    await until(() => inbox.some((m) => m.id === id) || ws.readyState > 1, 5000);
    return inbox.find((m) => m.id === id) ?? { closed: true };
  };
  return { ws, inbox, call };
}
const evil = await raw(auth.issue("mallory", APP));
await until(() => evil.inbox.some((m) => m.t === "shared"));
let r = await evil.call("sync", "add", "pretend\nbob", st.host.version);
const k = `shared/tasks.${r.value}.by`;
check("H6 the caller is the authenticated user, whatever the client sends", r.ok && st.host.kv.get(k) === "mallory", `${k} = ${st.host.kv.get(k)}`);
const r1 = await evil.call("sync", "add", "x".repeat(5000), st.host.version), r2 = await evil.call("sync", "toggle", "abc", st.host.version), r3 = await evil.call("sync", 42, null, "v");
check("H7 server layers validate untrusted input; malformed calls are refused", r1.error?.code === "app_error" && r2.error?.code === "app_error" && r3.error?.code === "bad_request" && st.host.kv.get("shared/tasks.n") === 3,
  `${r1.error?.message} / ${r2.error?.message} / ${r3.error?.code}`);
const anon = await raw("forged.token"), other = await raw(auth.issue("alice", "other.app")), expired = await raw(auth.issue("alice", APP, -1));
await until(() => [anon, other, expired].every((x) => x.ws.readyState === 3));
check("H8 bad, wrong-app and expired tokens are refused and disconnected", [anon, other, expired].every((x) => x.inbox[0]?.code === "unauthorized" && x.ws.readyState === 3));
const allToClients = () => [alice, bob].flatMap((c) => c.link.received).join("\n") + evil.inbox.map((m) => JSON.stringify(m)).join("\n");
check("H9 server-private state (server/…) never reaches a client", st.host.kv.get("server/calls") > 0 && !allToClients().includes("server/calls"), `server/calls = ${st.host.kv.get("server/calls")}`);

// ---------- secrets and payments ----------
await alice.host.dispatch("main", "buy");
ok = await until(() => /^ok ch_\d+ alice 1299$/.test(alice.host.kv.get("last") ?? ""));
const everything = allToClients() + [alice, bob].flatMap((c) => c.link.sent).join("\n") + JSON.stringify([...st.host.kv]) + [...blobs.values()].map((b) => Buffer.from(b).toString("latin1")).join("");
check("H10 payment goes through the server's capability; the reply reaches the client layer", ok && st.host.kv.get("shared/orders.n") === 1, alice.host.kv.get("last"));
check("H11 the API key is never in any layer, any state, or any byte sent to or from a client", !everything.includes(SECRET) && !everything.includes(SECRET.slice(8)));

// ---------- version changes: server first, overlap window, expand/contract ----------
const relayAt = []; for (const c of [alice, bob]) { const orig = c.link.received.push.bind(c.link.received); c.link.received.push = (s) => { if (s.includes('"t":"manifest"')) relayAt.push(performance.now()); return orig(s); }; }
const v2 = await publish(APP, { main: L.shared2, sync: L.sync2, pay: L.pay }, { main: "client", sync: "server", pay: "server" });
await until(() => alice.screen.includes("Shared tasks v2") && bob.screen.includes("Shared tasks v2"));
const srvSwap = logs.find((e) => e.app === APP && e.kind === "swap" && e.version === v2);
check("H12 server commits first: clients hear about v2 only after the server is live on it", srvSwap && relayAt.length === 2 && relayAt.every((t) => t > srvSwap.at) && st.host.version === v2,
  `server live on v2 at ${srvSwap?.at.toFixed(1)} ms; client manifests at ${relayAt.map((t) => t.toFixed(1)).join(", ")}`);
check("H13 the server migration ran on shared data and the new keys reached clients", st.host.kv.get("shared/tasks.0.pri") === 1 && alice.host.kv.get("shared/tasks.2.pri") === 1 && /P1 Ship the server host/.test(alice.screen), alice.screen.slice(0, 80));
alice.host.setBound("draft", "Use a v2-only op"); await alice.host.dispatch("main", "add");
ok = await until(() => /P3 Use a v2-only op/.test(bob.screen));
check("H14 a v2 client calls a v2-only server op immediately after the swap", ok, alice.host.kv.get("last"));

r = await evil.call("sync", "count", "", v1);
const viaOld = await evil.call("sync", "add", "from a v1 client", v1);
check("H15 inside the overlap window, a client still on v1 is served by the v1 server layer", r.ok && viaOld.ok && st.host.kv.get(`shared/tasks.${viaOld.value}.pri`) === undefined, `count=${r.value}; v1 add wrote no .pri (v1 code ran)`);
await sleep(450);
r = await evil.call("sync", "count", "", v1);
check("H16 after the window, a v1 call gets version_mismatch with the version to fetch", r.error?.code === "version_mismatch" && r.error.serverVersion === v2, r.error?.message);

// A client that was offline across a version change: its queued call goes out with the old version,
// gets version_mismatch, the client swaps to the latest manifest and the call is retried once.
const carol = client("carol");
await until(() => carol.host.version === v2);
carol.link.drop();
await until(() => !carol.link.online);
carol.link.close = carol.link.close; // keep reconnect on
const v3 = await publish(APP, { main: L.shared2, sync: L.sync2, pay: L.pay, extra: L.sync }, { main: "client", sync: "server", pay: "server", extra: "server" });
await serverAck(v3);
await sleep(450); // v2's window closes while carol is offline
const callP = carol.host.capabilities.remote("sync:add2 2|written offline");
ok = await until(() => carol.link.online && carol.host.version === v3, 4000);
const offlineReply = await callP.catch((e) => "ERR " + e.message);
check("H17 offline across a version change: call queued, version_mismatch, client swaps, call retried", ok && /^\d+$/.test(offlineReply) && st.host.kv.get(`shared/tasks.${offlineReply}.text`) === "written offline", `reply ${offlineReply}; carol on v${carol.host.version}`);

// ---------- offline queue, exactly once ----------
const n0 = st.host.kv.get("shared/tasks.n");
bob.link.drop();
await until(() => !bob.link.online);
for (const t of ["one", "two", "three"]) { bob.host.setBound("draft", `queued ${t}`); await bob.host.dispatch("main", "add"); }
const queued = bob.link.outbox.size;
ok = await until(() => st.host.kv.get("shared/tasks.n") === n0 + 3 && bob.link.outbox.size === 0, 4000);
await sleep(100);
const texts = [0, 1, 2].map((i) => st.host.kv.get(`shared/tasks.${n0 + i}.text`));
check("H18 offline calls queue and run once each, in order, on reconnect", queued === 3 && ok && texts.join() === "queued one,queued two,queued three" && st.host.kv.get("shared/tasks.n") === n0 + 3, texts.join(", "));

// The reply is lost after the server ran the call: the resend must not run it twice.
const n1 = st.host.kv.get("shared/tasks.n");
const lost = bob.host.capabilities.remote("sync:add once only");
bob.link.drop(); // the call went out; the connection dies before the reply comes back
const lostReply = await lost;
await sleep(100);
check("H19 a call whose reply was lost runs exactly once (same call id on resend)", st.host.kv.get("shared/tasks.n") === n1 + 1 && lostReply === String(n1), `tasks ${n1} → ${st.host.kv.get("shared/tasks.n")}`);

// ---------- a version no client can run, and rolling back by publishing forward ----------
const v4 = await publish(APP, { main: L.broken, sync: L.sync2, pay: L.pay }, { main: "client", sync: "server", pay: "server" });
await serverAck(v4);
await until(() => acks.filter((a) => a.version === v4 && a.t === "nack").length >= 1 && alice.host.history.some((h) => h.kind === "reject" && h.version === v4));
await sleep(450);
let stuck = await alice.host.capabilities.remote("sync:count").catch((e) => e.message);
check("H20 a client that refuses vN keeps its old version, and after the window it gets a clear error", alice.host.version === v3 && /can't run v\d+ and the server no longer serves v\d+/.test(stuck), stuck);
const v5 = await publish(APP, { main: L.shared2, sync: L.sync2, pay: L.pay }, { main: "client", sync: "server", pay: "server" });
await until(() => alice.host.version === v5);
const unstuck = await alice.host.capabilities.remote("sync:count").catch((e) => e.message);
check("H21 rollback for everyone = publish N+1 with the old hashes; the stuck client recovers", alice.host.version === v5 && /^\d+$/.test(unstuck), `alice on v${alice.host.version}, count ${unstuck}`);

// ---------- a server version that fails verification is never relayed ----------
const before = alice.host.version;
const v6 = await publish(APP, { main: L.shared2, sync: L.bad, pay: L.pay }, { main: "client", sync: "server", pay: "server" }); // schema 2 → 0 without migrate
await until(() => acks.some((a) => a.version === v6 && a.host === "server"));
await sleep(150);
const srvNack = acks.find((a) => a.version === v6 && a.host === "server");
r = await alice.host.capabilities.remote("sync:count").catch((e) => e.message);
check("H22 a manifest the server refuses is never relayed; clients keep working on the last good version", srvNack?.t === "nack" && st.host.version === v5 && alice.host.version === before && /^\d+$/.test(r), srvNack?.reason);

// ---------- tenants ----------
const B = "tenant.b";
const vb = await publish(B, { sync: L.sync, bad: L.bad }, { sync: "server", bad: "server" }, []);
server.subscribe(pubUrl, B);
await serverAck(vb);
const tb = await raw(auth.issue("eve", B), B);
await tb.call("sync", "add", "tenant B secret plan", vb);
const spin = tb.call("bad", "spin", "", vb);
const lat = [];
for (let i = 0; i < 10; i++) { const t = performance.now(); await alice.host.capabilities.remote("sync:count"); lat.push(performance.now() - t); }
const spun = await spin;
check("H23 a tenant's runaway layer is killed at its limit and doesn't stall other tenants", spun.error?.code === "layer_failed" && /time limit/.test(spun.error.message) && Math.max(...lat) < 100,
  `B: ${spun.error?.message}; A's calls during it: max ${Math.max(...lat).toFixed(1)} ms`);
r = await tb.call("bad", "ping", "", vb);
check("H24 the tenant's layer is restarted and answers again", r.ok && r.value === "pong");
check("H25 tenants don't see each other's shared data", !allToClients().includes("tenant B secret plan") && server.tenant(APP).host.kv.get("shared/tasks.0.text") !== "tenant B secret plan" && !tb.inbox.some((m) => JSON.stringify(m).includes("Ship the server host")));

// ---------- heavy compute and back-pressure ----------
let t0 = performance.now();
r = await tb.call("sync", "work", "5000000", vb);
const workMs = performance.now() - t0;
check("H26 heavy compute runs on the server host under its own (larger) limit", r.ok && r.value === "348513", `primes below 5M = ${r.value} in ${workMs.toFixed(0)} ms (a client's call limit is 100 ms)`);
const flood = await Promise.all(Array.from({ length: 8 }, () => tb.call("sync", "work", "3000000", vb)));
const shed = flood.filter((x) => x.error?.code === "overloaded").length;
check("H27 an app with too many queued calls gets 'overloaded' instead of piling up", shed > 0 && flood.some((x) => x.ok), `${shed} of 8 refused (limit 4 queued)`);

// ---------- idle tenants give their workers back ----------
const nBefore = st.host.kv.get("shared/tasks.n");
const evicted = st.host.evictIdle(Date.now() + 1e9);
t0 = performance.now();
r = await alice.host.capabilities.remote("sync:count").catch((e) => e.message);
const coldMs = performance.now() - t0;
check("H30 idle layer workers are stopped and restarted on the next call, state intact", evicted === 2 && r === String(nBefore) && st.host.history.some((h) => h.kind === "wake"),
  `${evicted} workers stopped; next call ${coldMs.toFixed(0)} ms (cold start)`);

// ---------- narrowing the mirror ----------
const dave = client("dave", { watch: ["shared/orders."] });
await until(() => dave.host.version === st.host.version);
const bought = await evil.call("pay", "checkout", "500", st.host.version);
const gotOrder = await until(() => dave.host.kv.get("shared/orders.1") !== undefined);
const daveKeys = [...dave.host.kv.keys()].filter((k) => k.startsWith("shared/"));
check("H29 a client can mirror only the shared/ prefixes it watches", bought.ok && gotOrder && daveKeys.every((k) => k.startsWith("shared/orders.")), daveKeys.join(", "));

// ---------- a rogue relay can't push code ----------
const rogue = new WebSocketServer({ port: 0 });
await new Promise((r) => rogue.on("listening", r));
rogue.on("connection", (ws) => ws.on("message", (raw) => {
  const m = JSON.parse(raw);
  if (m.t === "hello") { const real = latest.get(APP); ws.send(JSON.stringify({ t: "manifest", manifest: { ...real.manifest, version: real.manifest.version + 1, layers: { ...real.manifest.layers, main: L.broken } }, sig: real.sig })); }
}));
const victim = new LiveHost({ trustedKeys: [key.publicJwk] });
const vl = connectServer(victim, `ws://127.0.0.1:${rogue.address().port}`, { app: APP, token: "x" });
await until(() => victim.history.some((h) => h.kind === "reject"));
check("H28 a compromised server host can't alter code: clients verify the publisher's signature", victim.version === 0 && /signature not trusted/.test(victim.history.at(-1).msg));

vl.close(); rogue.close();
for (const c of [alice, bob, carol, dave]) { c.link.close(); c.host.close(); }
for (const x of [evil, tb]) x.ws.close();
server.close(); pubWss.close(); payApi.close();
const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
