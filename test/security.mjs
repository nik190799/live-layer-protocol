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

const failed = results.filter((x) => !x.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
