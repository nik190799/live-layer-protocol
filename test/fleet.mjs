// Fleet proofs: channels, percentage rollouts, convergence tracking, health-gated rollouts and key
// rotation, on a simulated fleet of real Live Hosts (each with its own state, blob store and trust
// store), talking to the controller only through JSON messages with random latency.
// Part 2 repeats the core flows over real WebSockets with separate host processes.
// Usage: node test/fleet.mjs        (FLEET_HOSTS=n to change the simulated fleet size, default 48)
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiveHost, signManifest, generatePublisherKey } from "../host/llp-core.js";
import { FleetAgent, TrustStore, bucketOf, signDoc } from "../host/fleet.js";
import { FleetController, serve } from "../tools/fleet.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const read = (f) => new Uint8Array(readFileSync(join(ROOT, "build", f)));
const results = [];
const check = (name, cond, detail = "") => { results.push(!!cond); console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const textOf = (n) => !n ? "" : n.k === "text" ? n.t : (n.c || []).map(textOf).join(" ");

// ---------- F1: bucketing math (no hosts needed) ----------
{
  const ids = Array.from({ length: 10000 }, (_, i) => `host-${i}`);
  const b = await Promise.all(ids.map((id) => bucketOf(id, "demo.tasks/stable")));
  const share = (p) => b.filter((x) => x < p * 100).length / ids.length * 100;
  const shares = [1, 10, 25, 50].map((p) => [p, share(p)]);
  const again = await bucketOf("host-42", "demo.tasks/stable");
  const other = await Promise.all(ids.slice(0, 1000).map((id) => bucketOf(id, "demo.tasks/beta")));
  const overlap = b.slice(0, 1000).filter((x, i) => x < 1000 && other[i] < 1000).length; // ~1% if independent
  check("F1 rollout share matches the percentage within 1 point over 10,000 host ids, and is stable per host",
    shares.every(([p, s]) => Math.abs(s - p) < 1) && again === b[42],
    shares.map(([p, s]) => `${p}%→${s.toFixed(2)}%`).join(" ") + `; 10% cohorts of two seeds overlap ${overlap / 10}%`);
}

// ---------- simulated fleet ----------
const N = +(process.env.FLEET_HOSTS || 48);
const fleet = await FleetController.create({ app: "demo.tasks", roots: 3, threshold: 2, version: 100 });
const H = {
  v1: await fleet.addBlob(read("tasks.wasm")), v2: await fleet.addBlob(read("tasks_v2.wasm")),
  broken: await fleet.addBlob(read("tasks_broken.wasm")), trap: await fleet.addBlob(read("tasks_trap.wasm")),
  stats: await fleet.addBlob(read("stats.wasm")),
};
const pinned = structuredClone(fleet.keyring); // what every host is installed with

const jitter = () => Math.random() * 8;
const sim = [];
// One process stands in for N devices, so with per-layer workers (sandbox) every host's first calls
// compete for the same few cores. The default 100 ms call limit is for one device; the simulation
// widens it so CPU contention between simulated devices isn't mistaken for a hung layer.
const SIM_LIMITS = { callMs: 2000, loadMs: 10000 };
function addHost(id, channel) {
  const host = new LiveHost({ limits: SIM_LIMITS });
  const agent = new FleetAgent({ host, id, channel, trust: new TrustStore(structuredClone(pinned)) });
  const node = { id, channel, host, agent, up: false, conn: null };
  node.connect = () => {
    // Like a WebSocket: random latency, but each direction stays in order.
    const link = { open: true, down: Promise.resolve(), up: Promise.resolve() };
    const later = (dir, f) => { link[dir] = link[dir].then(() => sleep(jitter())).then(() => { if (link.open) f(); }); };
    node.link = link;
    node.conn = fleet.attach((m) => { const c = JSON.parse(JSON.stringify(m)); if (link.open) later("down", () => agent.receive(c)); });
    agent.send = (m) => { const c = JSON.parse(JSON.stringify(m)); if (link.open) later("up", () => node.conn.message(c)); };
    node.up = true;
    agent.connected(); // the controller's challenge, already on its way, triggers the signed hello
  };
  node.disconnect = () => { node.link.open = false; node.up = false; node.conn.close(); };
  sim.push(node);
  return node;
}
for (let i = 0; i < N; i++) addHost(`h${String(i).padStart(3, "0")}`, i < N * 2 / 3 ? "stable" : "beta");
const stable = sim.filter((n) => n.channel === "stable"), beta = sim.filter((n) => n.channel === "beta");
const onLayer = (nodes, hash) => nodes.filter((n) => n.host.slots.get("main")?.hash === hash);
const fmt = (c) => `live ${c.live}, held back ${c.skipped}, rejected ${c.rejected}, reverted ${c.reverted}, pending ${c.pending}, offline ${c.offline}`;

// Baseline: both channels on v1 everywhere.
await fleet.publish("stable", { main: H.v1, footer: H.stats });
await fleet.publish("beta", { main: H.v1, footer: H.stats });
for (const n of sim) n.connect();
let t0 = performance.now();
let ok = await fleet.waitForConvergence("stable") && await fleet.waitForConvergence("beta");
check(`F2 ${N} hosts on 2 channels connect and converge on their channel's release`, ok && onLayer(sim, H.v1).length === N,
  `${(performance.now() - t0).toFixed(0)} ms; stable: ${fmt(fleet.convergence("stable"))}`);

// Some user state on every stable host, so later swaps carry real data.
for (const n of stable) { n.host.setBound("draft", `task of ${n.id}`); await n.host.dispatch("main", "add"); }

// ---------- channels ----------
await fleet.publish("beta", { main: H.v2, footer: H.stats });
ok = await fleet.waitForConvergence("beta");
check("F3 a beta release reaches every beta host and no stable host", ok && onLayer(beta, H.v2).length === beta.length && onLayer(stable, H.v2).length === 0,
  `beta on v2: ${onLayer(beta, H.v2).length}/${beta.length}, stable on v2: ${onLayer(stable, H.v2).length}`);

{ // Replay the (validly signed) beta manifest straight at a stable host.
  const cur = fleet.channel("beta").current;
  const r = await stable[0].agent.onMessage({ t: "manifest", ...cur }, async (h) => fleet.blobs.get(h));
  check("F4 a signed beta manifest replayed onto a stable host is refused (channel is inside the signature)", r.state === "rejected" && /channel beta/.test(r.reason) && stable[0].host.slots.get("main").hash === H.v1, r.reason);
  // And a stable host can't be fooled by stripping the channel or editing it: the signature breaks.
  const forged = { ...cur.manifest, channel: "stable" };
  const r2 = await stable[0].agent.onMessage({ t: "manifest", manifest: forged, sig: cur.sig }, async (h) => fleet.blobs.get(h));
  check("F5 editing the channel field of a signed manifest breaks the signature", r2.state === "rejected" && /signature/.test(r2.reason), r2.reason);
}

// ---------- percentage rollout ----------
await fleet.publish("stable", { main: H.v2, footer: H.stats }, { percent: 25 });
await fleet.waitFor(() => fleet.convergence("stable").pending === 0);
{
  const c = fleet.convergence("stable");
  const expected = new Set(await fleet.expectedShare("stable"));
  const live = new Set(onLayer(stable, H.v2).map((n) => n.id));
  const same = expected.size === live.size && [...expected].every((id) => live.has(id));
  const kept = onLayer(stable, H.v1).every((n) => n.host.version < c.version && n.host.kv.get("tasks.n") === 1);
  check("F6 a 25% rollout reaches exactly the hosts whose bucket is in the share; the rest keep running the old release",
    same && live.size > 0 && live.size < stable.length && kept && c.converged, `${live.size}/${stable.length} hosts on v2 (expected ${expected.size}); ${fmt(c)}`);
  const firstCohort = live;
  await fleet.setPercent("stable", 60);
  await fleet.waitFor(() => fleet.convergence("stable").pending === 0);
  const live60 = new Set(onLayer(stable, H.v2).map((n) => n.id));
  check("F7 widening the share to 60% only adds hosts: everyone from the 25% cohort stays on v2", [...firstCohort].every((id) => live60.has(id)) && live60.size > firstCohort.size,
    `${firstCohort.size} → ${live60.size} hosts`);
  t0 = performance.now();
  await fleet.setPercent("stable", 100);
  ok = await fleet.waitForConvergence("stable");
  const stateKept = stable.every((n) => n.host.kv.get("tasks.n") === 1 && n.host.kv.get("tasks.0.text") === `task of ${n.id}`);
  check("F8 at 100% the channel converges and every host kept its own user state", ok && onLayer(stable, H.v2).length === stable.length && stateKept,
    `${(performance.now() - t0).toFixed(0)} ms to converge; ${fmt(fleet.convergence("stable"))}`);
}

// ---------- convergence with offline hosts ----------
{
  const away = stable.slice(0, 3);
  for (const n of away) n.disconnect();
  await fleet.publish("stable", { main: H.v1, footer: H.stats });
  await fleet.waitForConvergence("stable");
  const c = fleet.convergence("stable");
  check("F9 convergence report counts offline hosts separately and converges among the online ones, but is not complete", c.converged && !c.complete && c.offline === 3 && c.live === stable.length - 3, fmt(c));
  for (const n of away) n.connect();
  ok = await fleet.waitFor(() => { const c = fleet.convergence("stable"); return c.offline === 0 && c.converged; });
  const c2 = fleet.convergence("stable");
  check("F10 hosts that were offline catch up on reconnect, and the report shows the whole channel live and complete", ok && c2.complete && c2.offline === 0 && c2.live === stable.length && away.every((n) => n.host.slots.get("main").hash === H.v1), fmt(c2));
}

// ---------- health-gated rollouts ----------
{
  const before = fleet.convergence("stable").version;
  const tried = new Set();
  const r = await fleet.rollout("stable", { main: H.broken, footer: H.stats }, { steps: [10, 50, 100], onStep: (p, c) => { for (const n of stable) if (n.agent.state === "rejected" && n.agent.target === fleet.convergence("stable").version) tried.add(n.id); } });
  const share10 = (await Promise.all(stable.map((n) => bucketOf(n.id, "demo.tasks/stable")))).filter((b) => b < 1000).length;
  const allBack = stable.every((n) => n.host.slots.get("main").hash === H.v1 && n.host.version > before);
  check("F11 a release that fails verification stops at the first step (10%) and the channel is rolled back automatically",
    !r.ok && r.haltedAt === 10 && r.recovered && allBack && tried.size === share10, `${r.reason}; ${tried.size} hosts tried it (10% share = ${share10}); rolled back as v${r.rolledBackTo}`);
}
{
  // Passes verification, but crashes on the first "add". Real user traffic during the soak finds it.
  let hit = 0;
  const r = await fleet.rollout("stable", { main: H.trap, footer: H.stats }, {
    steps: [20, 100], soakMs: 50,
    onStep: async () => { for (const n of stable) if (n.host.slots.get("main")?.hash === H.trap) { hit++; n.host.setBound("draft", "boom"); await n.host.dispatch("main", "add"); } },
  });
  const tasksKept = stable.every((n) => n.host.kv.get("tasks.n") === 1);
  check("F12 a release that crashes at runtime is caught by host revert reports during the soak, halted at 20%, and rolled back",
    !r.ok && r.haltedAt === 20 && r.recovered && hit > 0 && hit < stable.length && tasksKept && onLayer(stable, H.v1).length === stable.length,
    `${r.reason}; ${hit} of ${stable.length} hosts ever ran it`);
  const good = await fleet.rollout("stable", { main: H.v2, footer: H.stats }, { steps: [10, 50, 100] });
  check("F13 a healthy staged rollout (10 → 50 → 100%) completes and converges", good.ok && good.converged && onLayer(stable, H.v2).length === stable.length,
    good.steps.map((s) => `${s.percent}%: ${s.live} live`).join(", "));
}

// ---------- key rotation ----------
{
  const oldKey = fleet.releaseKey;
  const away = beta[0];
  away.disconnect();
  const kr = await fleet.rotateReleaseKey();
  ok = await fleet.waitForConvergence("stable") && await fleet.waitFor(() => beta.filter((n) => n.up).every((n) => n.agent.trust.version === kr));
  check("F14 rotating the release key delivers keyring 2 to every online host and current releases are re-signed with the new key",
    ok && sim.filter((n) => n.up).every((n) => n.agent.trust.version === kr), `keyring ${kr}; ${fmt(fleet.convergence("stable"))}`);

  await fleet.publish("stable", { main: H.v1, footer: H.stats });
  ok = await fleet.waitForConvergence("stable");
  check("F15 releases signed with the new key go live fleet-wide", ok && onLayer(stable, H.v1).length === stable.length, fmt(fleet.convergence("stable")));

  // The old key leaked: an attacker signs a higher version with it.
  const evil = { app: "demo.tasks", channel: "stable", version: fleet.version + 50, layers: { main: H.trap, footer: H.stats }, order: ["main", "footer"] };
  const r = await stable[1].agent.onMessage({ t: "manifest", manifest: evil, sig: await signManifest(evil, oldKey.privateKey) }, async (h) => fleet.blobs.get(h));
  check("F16 a manifest signed with the rotated-out key is refused", r.state === "rejected" && stable[1].host.slots.get("main").hash === H.v1, r.reason);

  // With the leaked release key the attacker tries to issue a keyring that trusts it again.
  const bad = { ...fleet.keyring, keyring: fleet.keyring.keyring + 1, release: { keys: [oldKey.publicJwk] } };
  const r2 = await stable[1].agent.onMessage({ t: "keyring", doc: bad, sigs: [await signDoc(bad, oldKey.privateKey, oldKey.publicJwk)] });
  const replay = fleet.keyrings[0];
  const r3 = await stable[1].agent.onMessage({ t: "keyring", ...replay });
  check("F17 a keyring not signed by the root is refused, and replaying the old keyring is refused", !r2.ok && !r3.ok && stable[1].agent.trust.version === kr, `${r2.reason}; ${r3.reason}`);

  away.connect();
  ok = await fleet.waitFor(() => fleet.hosts.get(away.id).online && fleet.convergence("beta").converged && away.agent.trust.version === kr && away.host.slots.get("main")?.hash === fleet.channel("beta").current.manifest.layers.main && away.host.version === fleet.convergence("beta").version);
  check("F18 a host that was offline during the rotation gets the keyring chain, then the release signed by the new key", ok && fleet.convergence("beta").converged, `keyring ${away.agent.trust.version}; ${fmt(fleet.convergence("beta"))}`);
}
{
  // Root rotation, 2-of-3 threshold.
  const one = { ...fleet.keyring, keyring: fleet.keyring.keyring + 1, release: { keys: [(await generatePublisherKey()).publicJwk] } };
  const r1 = await stable[2].agent.onMessage({ t: "keyring", doc: one, sigs: await fleet.signKeyring(one, fleet.rootKeys.slice(0, 1)) });
  check("F19 with a 2-of-3 root, a keyring signed by only one root key is refused", !r1.ok, r1.reason);

  const newRoot = [await generatePublisherKey(), await generatePublisherKey()];
  const oldRoot = fleet.rootKeys;
  const kr = await fleet.rotateRoot(newRoot, 1);
  ok = await fleet.waitFor(() => sim.every((n) => n.agent.trust.version === kr));
  const after = { ...fleet.keyring, keyring: kr + 1, release: { keys: [(await generatePublisherKey()).publicJwk] } };
  const r2 = await stable[2].agent.onMessage({ t: "keyring", doc: after, sigs: await fleet.signKeyring(after, oldRoot) });
  check("F20 the root itself rotates (signed by old and new root); afterwards the old root keys can't issue keyrings", ok && !r2.ok, `keyring ${kr} on all ${N} hosts; old root: ${r2.reason}`);
  const kr2 = await fleet.rotateReleaseKey();
  await fleet.publish("stable", { main: H.v2, footer: H.stats });
  ok = await fleet.waitForConvergence("stable") && await fleet.waitFor(() => sim.every((n) => n.agent.trust.version === kr2));
  check("F21 the new root can rotate the release key and the fleet keeps shipping", ok && onLayer(stable, H.v2).length === stable.length, `keyring ${kr2}; ${fmt(fleet.convergence("stable"))}`);
}
{
  const bigChain = fleet.keyrings.length;
  const late = addHost("late-joiner", "stable"); // installed with keyring 1 from day one
  late.connect();
  ok = await fleet.waitFor(() => fleet.hosts.has("late-joiner") && fleet.convergence("stable").converged);
  check("F22 a host installed with keyring 1 walks the whole chain (release + root rotations) and goes live", ok && late.agent.trust.version === bigChain && late.host.slots.get("main").hash === H.v2,
    `walked ${bigChain - 1} keyring updates`);
}
for (const n of sim) n.disconnect();

// ---------- Part 2: over real WebSockets, separate host processes ----------
{
  const work = mkdtempSync(join(tmpdir(), "llp-fleet-"));
  const wire = await FleetController.create({ app: "demo.tasks", version: 1000 });
  const blobs = { v1: await wire.addBlob(read("tasks.wasm")), v2: await wire.addBlob(read("tasks_v2.wasm")), stats: await wire.addBlob(read("stats.wasm")) };
  await wire.save(work);
  const wss = await serve(wire, { port: 7792 });
  await wire.publish("stable", { main: blobs.v1, footer: blobs.stats });
  const procs = [0, 1, 2, 3].map((i) => {
    const p = spawn(process.execPath, [join(ROOT, "host/fleet-host.mjs"), "ws://localhost:7792", join(work, "keyring.pinned.json"), "--id", `proc${i}`, "--channel", "stable", "--count", "5", "--trust-dir", join(work, "trust")], { stdio: ["pipe", "pipe", "pipe"] });
    p.out = ""; p.stdout.on("data", (d) => (p.out += d)); p.stderr.on("data", (d) => (p.out += d));
    return p;
  });
  ok = await wire.waitFor(() => { const c = wire.convergence("stable"); return c.hosts === 20 && c.converged; }, 15000);
  check("W1 4 host processes × 5 hosts join over WebSocket and converge", ok, fmt(wire.convergence("stable")));

  await wire.publish("stable", { main: blobs.v2, footer: blobs.stats }, { percent: 30 });
  await wire.waitFor(() => wire.convergence("stable").pending === 0, 10000);
  const c30 = wire.convergence("stable"), want = (await wire.expectedShare("stable")).length;
  check("W2 a 30% rollout over the wire reaches exactly the expected share", c30.live === want && c30.skipped === 20 - want && want > 0, `${c30.live} live (expected ${want}), ${c30.skipped} held back`);

  procs[3].kill(); // 5 hosts drop off mid-rollout
  await wire.waitFor(() => wire.convergence("stable").offline === 5, 5000);
  t0 = performance.now();
  await wire.setPercent("stable", 100);
  ok = await wire.waitForConvergence("stable", 10000);
  check("W3 widening to 100% converges the online hosts; the dead process shows as 5 offline", ok && wire.convergence("stable").offline === 5, `${(performance.now() - t0).toFixed(0)} ms; ${fmt(wire.convergence("stable"))}`);

  t0 = performance.now();
  const oldRelease = wire.releaseKey;
  const kr = await wire.rotateReleaseKey();
  ok = await wire.waitForConvergence("stable", 10000);
  const lines = procs.slice(0, 3).flatMap((p) => p.out.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l)));
  check("W4 key rotation over the wire: every online host accepts keyring 2", ok && lines.filter((l) => l.state === "keyring" && l.keyring === kr).length === 15, `${(performance.now() - t0).toFixed(0)} ms`);

  const p4 = spawn(process.execPath, [join(ROOT, "host/fleet-host.mjs"), "ws://localhost:7792", join(work, "keyring.pinned.json"), "--id", "proc3", "--channel", "stable", "--count", "5", "--trust-dir", join(work, "trust")], { stdio: ["pipe", "pipe", "pipe"] });
  procs.push(p4);
  ok = await wire.waitFor(() => { const c = wire.convergence("stable"); return c.offline === 0 && c.converged; }, 15000);
  check("W5 the restarted process (same ids, keyring 1 on disk) catches up on keyring and release", ok, fmt(wire.convergence("stable")));
  for (const p of procs) p.kill();
  wss.close();

  // A rogue stream serves a high-version manifest signed with the rotated-out key to restarted hosts.
  const { WebSocketServer } = await import("ws");
  const rogue = new WebSocketServer({ port: 7793 });
  const evil = { app: "demo.tasks", channel: "stable", version: wire.version + 100, layers: { main: blobs.v1, footer: blobs.stats }, order: ["main", "footer"] };
  const evilSig = await signManifest(evil, oldRelease.privateKey);
  rogue.on("connection", (ws) => { ws.send(JSON.stringify({ t: "challenge", nonce: "rogue" })); ws.on("message", (raw) => {
    const m = JSON.parse(raw);
    if (m.t === "hello") ws.send(JSON.stringify({ t: "manifest", manifest: evil, sig: evilSig }));
    if (m.t === "want") for (const h of m.hashes) ws.send(JSON.stringify({ t: "blob", hash: h, data: Buffer.from(wire.blobs.get(h)).toString("base64") }));
  }); });
  const run = (extra) => { const p = spawn(process.execPath, [join(ROOT, "host/fleet-host.mjs"), "ws://localhost:7793", join(work, "keyring.pinned.json"), "--id", "proc0-0", "--channel", "stable", ...extra], { stdio: ["pipe", "pipe", "pipe"] }); p.out = ""; p.stdout.on("data", (d) => (p.out += d)); return p; };
  const until = async (p, re) => { const t = Date.now(); while (!re.test(p.out) && Date.now() - t < 5000) await sleep(20); return p.out.match(re)?.[0]; };
  const kept = run(["--trust-dir", join(work, "trust")]), fresh = run([]);
  const a = await until(kept, /"state":"(live|rejected)"[^}]*/), b = await until(fresh, /"state":"(live|rejected)"[^}]*/);
  kept.kill(); fresh.kill(); rogue.close();
  check("W6 a restarted host that keeps its keyring on disk refuses the revoked key; one that only has the pinned keyring would accept it",
    /rejected/.test(a ?? "") && /signature not trusted/.test(a) && /live/.test(b ?? ""), `with --trust-dir: ${a?.match(/"reason":"[^"]*"/)?.[0]}; without: ${b?.match(/"state":"\w+"/)?.[0]}`);
}

const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
