// Security regression tests: each red-team finding (docs/RED-TEAM.md) that has been fixed gets a
// check here that asserts the SAFE behaviour, so a regression fails the build.
import { readFileSync } from "node:fs";
import { LiveHost, sha256, generatePublisherKey, signManifest, MAX_VERSION_AHEAD_MS } from "../host/llp-core.js";
import { FleetAgent, TrustStore } from "../host/fleet.js";
import { FleetController } from "../tools/fleet.mjs";

const results = [];
const check = (name, pass, detail = "") => { results.push({ name, pass }); console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };
const read = (f) => new Uint8Array(readFileSync(new URL(`../build/${f}`, import.meta.url)));
const tasks = read("tasks.wasm"), stats = read("stats.wasm");
const ht = await sha256(tasks), hs = await sha256(stats);
const blobs = new Map([[ht, tasks], [hs, stats]]);
const fetchBlob = async (h) => blobs.get(h);
const INLINE = { isolation: "inline" };
const key = await generatePublisherKey();
const signed = async (host, m) => host.apply(m, await signManifest(m, key.privateKey), fetchBlob);
const M = (version, extra = {}) => ({ app: "demo.tasks", version, layers: { main: ht }, order: ["main"], ...extra });

// ---------- RT-01: fail closed without trusted keys ----------
{
  const host = new LiveHost({ app: "demo.tasks", limits: INLINE });
  const a = await host.apply(M(1), "not-a-signature", fetchBlob);
  const b = await signed(host, M(2)); // even a real signature: there's nothing to check it against
  check("SEC1 a host with no trusted keys refuses unsigned and signed manifests", !a.ok && !b.ok && host.version === 0, a.reason);
  host.close();
  const logs = [];
  const dev = new LiveHost({ allowUnsigned: true, limits: INLINE, onLog: (e) => logs.push(e) });
  const c = await dev.apply(M(1), "", fetchBlob);
  check("SEC2 unsigned code runs only in the explicit allowUnsigned mode, which logs a warning", c.ok && logs.some((e) => e.kind === "security" && /NOT signature-checked/.test(e.msg)));
  dev.close();
  const strict = new LiveHost({ app: "demo.tasks", trustedKeys: [key.publicJwk], allowUnsigned: "yes", limits: INLINE });
  const d = await strict.apply(M(1), "", fetchBlob);
  check("SEC3 allowUnsigned must be exactly true (a truthy string doesn't switch checks off)", !d.ok && /signature/.test(d.reason), d.reason);
  strict.close();
}

// ---------- RT-05: a host is pinned to its app ----------
{
  const host = new LiveHost({ trustedKeys: [key.publicJwk], limits: INLINE });
  const a = await signed(host, M(1));
  check("SEC4 a signature-checking host with no app pinned refuses to run anything", !a.ok && /no app pinned/.test(a.reason), a.reason);
  host.close();
  const pinned = new LiveHost({ app: "demo.tasks", trustedKeys: [key.publicJwk], limits: INLINE });
  const b = await signed(pinned, { ...M(1), app: "some.other.app" });
  const c = await signed(pinned, M(2));
  check("SEC5 a fresh host refuses a correctly signed release for another app, and runs its own", !b.ok && b.reason === "different app" && c.ok, b.reason);
  pinned.close();
}

// ---------- RT-02: versions are range-checked ----------
{
  const host = new LiveHost({ app: "demo.tasks", trustedKeys: [key.publicJwk], limits: INLINE });
  const bad = [Number.MAX_VALUE, Number.MAX_SAFE_INTEGER, 1.5, -3, "9", Infinity, Date.now() + MAX_VERSION_AHEAD_MS + 60_000];
  const refused = [];
  for (const v of bad) { const r = await signed(host, M(v)); if (!r.ok) refused.push(v); }
  const now = Date.now();
  const ok1 = await signed(host, M(now));
  const ok2 = await signed(host, M(now + 1));
  check("SEC6 huge, fractional, negative, non-number and far-future versions are refused", refused.length === bad.length && host.version === now + 1, `${refused.length}/${bad.length} refused`);
  check("SEC7 normal timestamp and counter versions keep working after those were refused", ok1.ok && ok2.ok);
  const e = await signed(host, M(now + 2, { epoch: 1 }));
  check("SEC8 a plain host refuses epochs (only a fleet keyring can open one)", !e.ok && /epoch 1 is beyond/.test(e.reason), e.reason);
  host.close();
}

// RT-02 recovery: a leaked release key signs a far-but-allowed version. Rotating the key starts a new
// epoch, so the real release outranks it and the host comes back.
{
  const fleet = await FleetController.create({ app: "demo.tasks" });
  const h1 = await fleet.addBlob(tasks), h2 = await fleet.addBlob(stats);
  const host = new LiveHost({ limits: INLINE });
  const agent = new FleetAgent({ host, id: "h1", channel: "stable", trust: new TrustStore(structuredClone(fleet.keyring)) });
  const leaked = fleet.releaseKey;
  const evil = { app: "demo.tasks", channel: "stable", epoch: 1, version: Date.now() + MAX_VERSION_AHEAD_MS - 60_000, layers: { main: h2 }, order: ["main"] };
  await agent.handle({ t: "manifest", manifest: evil, sig: await signManifest(evil, leaked.privateKey) }, async (h) => fleet.blobs.get(h));
  const poisoned = host.version === evil.version;
  // the controller's real release is lower, so before rotation it can't land
  await fleet.publish("stable", { main: h1 });
  const before = await agent.handle({ t: "manifest", ...fleet.channel("stable").current }, async (h) => fleet.blobs.get(h));
  const kr = { doc: null };
  fleet.hosts.set("h1", { id: "h1", online: true, channel: "stable", send: (m) => { if (m.t === "keyring") kr.doc = m; } });
  await fleet.rotateReleaseKey();
  await agent.handle(kr.doc, async (h) => fleet.blobs.get(h));
  const after = await agent.handle({ t: "manifest", ...fleet.channel("stable").current }, async (h) => fleet.blobs.get(h));
  check("SEC9 after a leaked key pushes a high version, rotating the key lets the real release replace it",
    poisoned && before.state === "stale" && after.state === "live" && host.slots.get("main").hash === h1 && host.epoch === 2,
    `before rotation: ${before.state}; after: ${after.state}, epoch ${host.epoch}`);
  const replay = await agent.handle({ t: "manifest", manifest: evil, sig: await signManifest(evil, leaked.privateKey) }, async (h) => fleet.blobs.get(h));
  check("SEC10 the leaked key's release can't come back after the rotation", replay.state === "rejected" && host.slots.get("main").hash === h1, replay.reason);
  host.close();
}

// ---------- ST-02: server state survives a restart ----------
{
  const { mkdtempSync, appendFileSync, readdirSync, readFileSync: rf, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { ServerHost } = await import("../host/server-host.mjs");
  const sync = read("tasks_sync.wasm"), hsync = await sha256(sync); blobs.set(hsync, sync);
  const dir = mkdtempSync(join(tmpdir(), "llp-durable-"));
  const APP = "demo.durable";
  const auth = { authenticate: () => "alice" };
  const make = (opts = {}) => new ServerHost({ trustedKeys: [key.publicJwk], ...auth, dataDir: dir, idleMs: 0, ...opts });
  const man = { app: APP, version: 1, layers: { sync: hsync }, order: [], hosts: { sync: "server" } };
  const sig = await signManifest(man, key.privateKey);
  const call = (srv, op, args, idem) => srv.call(srv.tenant(APP), "alice", { id: 1, slot: "sync", op, args, version: 1, idem });

  let a = make();
  await a.ready;
  const off = await a.offer(man, sig, fetchBlob);
  const r1 = await call(a, "add", "pay rent", "c1"), r2 = await call(a, "add", "buy milk", "c2");
  const callsBefore = a.tenant(APP).host.kv.get("server/calls");
  a.close();

  let b = make();
  const restored = await b.ready;
  const tb = b.tenant(APP);
  check("SEC11 after a restart the tenant is back on its release with its shared data",
    off.ok && restored[0]?.ok && tb.host.version === 1 && tb.host.kv.get("shared/tasks.n") === 2 && tb.host.kv.get("shared/tasks.1.text") === "buy milk",
    `version ${tb.host.version}, tasks ${tb.host.kv.get("shared/tasks.n")}`);
  const retry = await call(b, "add", "buy milk", "c2");
  check("SEC12 a call retried after the restart with the same id is answered from the record, not run again",
    retry.ok && retry.value === r2.value && tb.host.kv.get("shared/tasks.n") === 2 && tb.host.kv.get("server/calls") === callsBefore, `reply ${retry.value}, tasks still ${tb.host.kv.get("shared/tasks.n")}`);
  const r3 = await call(b, "add", "new after restart", "c3");
  check("SEC13 new calls after the restart keep working", r1.ok && r3.ok && r3.value === "2" && tb.host.kv.get("shared/tasks.n") === 3);
  b.close();

  // A crash mid-write leaves a torn last line; it is ignored, everything before it is kept.
  const tdir = join(dir, "tenants", readdirSync(join(dir, "tenants"))[0]);
  appendFileSync(join(tdir, "log.jsonl"), '{"set":[["shared/tasks.n",99');
  let c0 = make();
  await c0.ready;
  await call(c0, "add", "after the torn line", "t1");
  c0.close();
  let c1 = make();
  await c1.ready;
  const afterTorn = c1.tenant(APP).host.kv.get("shared/tasks.n");
  c1.close();
  check("SEC14b writes appended after a torn line are kept across the next restart", afterTorn === 4, `tasks ${afterTorn}`);
  let c = make({ compactEvery: 4 });
  await c.ready;
  const n = c.tenant(APP).host.kv.get("shared/tasks.n");
  for (let i = 0; i < 9; i++) await call(c, "add", "bulk " + i, "bulk" + i);
  c.close();
  check("SEC14 a torn last log line from a crash is ignored", n === 4, `tasks ${n}`);
  let d = make();
  await d.ready;
  const td = d.tenant(APP);
  const again = await call(d, "add", "bulk 0", "bulk0");
  check("SEC15 after log compaction (snapshot + truncated log) state and call records still survive a restart",
    td.host.kv.get("shared/tasks.n") === 13 && again.value === "4" && td.host.kv.get("shared/tasks.n") === 13 && existsSnapshot(tdir), `tasks ${td.host.kv.get("shared/tasks.n")}`);
  d.close();

  // The stored release is re-verified on restart: an edited file on disk doesn't run.
  const cur = JSON.parse(rf(join(tdir, "current.json"), "utf8"));
  cur.manifest.layers.sync = ht;
  writeFileSync(join(tdir, "current.json"), JSON.stringify(cur));
  let e = make();
  const back = await e.ready;
  check("SEC16 a release edited on disk is refused at restart (signature re-checked)", !back[0].ok && /signature/.test(back[0].reason) && e.tenant(APP).host.version === 0, back[0].reason);
  e.close();

  const warned = [];
  new ServerHost({ trustedKeys: [key.publicJwk], ...auth, onLog: (x) => warned.push(x) }).close();
  check("SEC17 a server host without a dataDir warns that its state is memory-only", warned.some((x) => /memory only/.test(x.msg)));
  rmSync(dir, { recursive: true, force: true });
  function existsSnapshot(d) { return readdirSync(d).includes("snapshot.json"); }
}

const failed = results.filter((x) => !x.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
