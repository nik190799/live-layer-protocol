// Red-team findings checks (docs/RED-TEAM.md). Each check runs the real code and reports whether a
// finding still holds. "CONFIRMED" means the weakness is still there; a fix should flip the check.
// This script always exits 0: it tracks findings, it doesn't gate the build.
import { readFileSync } from "node:fs";
import { LiveHost, sha256, generatePublisherKey, signManifest } from "../host/llp-core.js";
import { FleetController } from "../tools/fleet.mjs";
import { generateDeviceKey, signDoc } from "../host/fleet.js";

// A raw controller connection that answers the challenge with a hello signed by `dev`.
async function join(fleet, sink, id, dev) {
  let nonce = null;
  const c = fleet.attach((m) => { if (m.t === "challenge") nonce = m.nonce; sink.push(m); });
  const body = { t: "hello", host: id, channel: "stable", version: 0, keyring: 1 };
  const { sig } = await signDoc({ ...body, nonce }, dev.privateKey, dev.publicJwk);
  await c.message({ ...body, auth: { key: dev.publicJwk, sig } });
  return c;
}

const read = (f) => new Uint8Array(readFileSync(new URL(`../build/${f}`, import.meta.url)));
const out = [];
const report = (id, confirmed, detail) => { out.push({ id, confirmed, detail }); console.log(`${confirmed ? "CONFIRMED" : "FIXED    "}  ${id}  — ${detail}`); };

const tasks = read("tasks.wasm"), h = await sha256(tasks);
const fetchBlob = async () => tasks;

// RT-01: a host built without trusted keys accepts any manifest, signed or not (fails open).
{
  const host = new LiveHost({ limits: { isolation: "inline" } });
  const r = await host.apply({ app: "demo.tasks", version: 1, layers: { main: h }, order: ["main"] }, "not-a-signature", fetchBlob);
  report("RT-01 no trusted keys = no signature check", r.ok, r.ok ? "unsigned manifest went live" : r.reason);
  host.close();
}

// RT-02: version is not type- or range-checked, so one signed manifest with a huge version leaves
// no higher version to publish; the host then refuses every later release.
{
  const key = await generatePublisherKey();
  const host = new LiveHost({ app: "demo.tasks", trustedKeys: [key.publicJwk], limits: { isolation: "inline" } });
  const m1 = { app: "demo.tasks", version: Number.MAX_VALUE, layers: { main: h }, order: ["main"] };
  const a = await host.apply(m1, await signManifest(m1, key.privateKey), fetchBlob);
  const m2 = { app: "demo.tasks", version: Date.now(), layers: { main: h }, order: ["main"] };
  const b = await host.apply(m2, await signManifest(m2, key.privateKey), fetchBlob);
  report("RT-02 unbounded version freezes updates", a.ok || !b.ok, `huge version accepted: ${a.ok}; normal next release accepted: ${b.ok}`);
  host.close();
}

// RT-03: the fleet controller trusted whoever said hello with a host id; a second connection using
// the same id took over that host's record, so the real host stopped getting releases.
{
  const fleet = await FleetController.create({ app: "demo.tasks" });
  const real = [], other = [];
  await join(fleet, real, "h1", await generateDeviceKey());
  await join(fleet, other, "h1", await generateDeviceKey()); // same id, different device
  const hb = await fleet.addBlob(tasks);
  await fleet.publish("stable", { main: hb });
  const realGot = real.some((m) => m.t === "manifest");
  report("RT-03 host identity not authenticated", !realGot || other.some((m) => m.t === "manifest"), `original connection received the release: ${realGot}; impostor received it: ${other.some((m) => m.t === "manifest")}`);
}

// RT-04: all layers on a host share one key space. The footer (stats.wasm) reads the main layer's
// tasks.* keys by design; nothing stops any layer reading or writing any other layer's keys,
// including the host's own __schema.<slot> markers.
{
  const stats = read("stats.wasm"), hs = await sha256(stats);
  const host = new LiveHost({ allowUnsigned: true, limits: { isolation: "inline" } });
  host.kv.set("tasks.n", 1); host.kv.set("tasks.0.text", "private note"); host.kv.set("tasks.0.done", 1);
  // With per-slot keys declared and no read share, the footer must not see main's tasks.* keys.
  const keys = { main: { own: ["tasks.", "draft"] }, footer: { own: ["geo"] } };
  const r = await host.apply({ app: "demo.tasks", version: 1, layers: { main: h, footer: hs }, order: ["main", "footer"], keys }, "", async (x) => x === hs ? stats : tasks);
  const views = await host.render();
  const footer = JSON.stringify(views.find((v) => v.slot === "footer")?.tree ?? {});
  report("RT-04 no per-layer state isolation", !r.ok || footer.includes("100%"), r.ok ? (footer.includes("100%") ? "footer computed its output from main's keys" : "with declared keys the footer can't read main's keys (opt-in: manifests without keys still share)") : r.reason);
  host.close();
}

// RT-05: a fresh host isn't tied to one app, so a release signed for any app by a trusted key
// installs on it. The host should be pinned to its app name from the start.
{
  const key = await generatePublisherKey();
  const host = new LiveHost({ trustedKeys: [key.publicJwk], limits: { isolation: "inline" } });
  const m = { app: "some.other.app", version: 1, layers: { main: h }, order: ["main"] };
  const r = await host.apply(m, await signManifest(m, key.privateKey), fetchBlob);
  report("RT-05 host not pinned to an app", r.ok, r.ok ? "a release for another app installed" : r.reason);
  host.close();
}

// RT-06: while a rollout waits, every status message rescanned every host, so a round of reports
// cost O(hosts^2). Linear would be 4x for 4x the hosts; this measures the real ratio.
{
  const dev = await generateDeviceKey();
  const round = async (N) => {
    const f = await FleetController.create({ app: "demo.tasks" });
    const v = await f.publish("stable", { main: await f.addBlob(tasks) });
    const conns = [];
    for (let i = 0; i < N; i++) conns.push(await join(f, [], "h" + i, dev));
    f.waitForConvergence("stable", 60000);
    const t = performance.now();
    for (let i = 0; i < N; i++) await conns[i].message({ t: "status", host: "h" + i, channel: "stable", version: v, keyring: 1, target: v, state: "live" });
    return performance.now() - t;
  };
  const a = await round(2000), b = await round(8000);
  report("RT-06 fleet controller cost grows with hosts squared", b / a > 8, `2,000 hosts ${a.toFixed(0)} ms, 8,000 hosts ${b.toFixed(0)} ms (x${(b / a).toFixed(1)} for x4 hosts)`);
}

console.log(`\n${out.filter((x) => x.confirmed).length} of ${out.length} findings still hold`);
process.exit(0);
