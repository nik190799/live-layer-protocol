// Proof for SPEC 10.5 (red-team FL-01): release channels on the server host. A real fleet controller
// over WebSockets, a server host that joins it on two channels (stable and beta), and client hosts
// behind the server on each channel. The server's data dir is encrypted at rest throughout.
import { readFileSync, mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { LiveHost } from "../host/llp-core.js";
import { ServerHost, tokenAuth } from "../host/server-host.mjs";
import { connectServer } from "../host/remote-client.mjs";
import { TrustStore, bucketOf } from "../host/fleet.js";
import { FleetController, serve } from "../tools/fleet.mjs";
import { generateDataKey, dataKeyFrom } from "../host/at-rest.mjs";

const read = (f) => new Uint8Array(readFileSync(new URL(`../build/${f}`, import.meta.url)));
const results = [];
const check = (name, cond, detail = "") => { results.push(!!cond); console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, ms = 5000) { const t = performance.now(); while (!(await cond())) { if (performance.now() - t > ms) return false; await sleep(5); } return true; }

const APP = "demo.channels";
const WINDOW = 300;
const fleet = await FleetController.create({ app: APP, version: 100 });
const wss = await serve(fleet, { port: 0, host: "127.0.0.1" });
const fleetUrl = `ws://127.0.0.1:${wss.address().port}`;
const H = { shared: await fleet.addBlob(read("tasks_shared.wasm")), shared2: await fleet.addBlob(read("tasks_shared_v2.wasm")), sync: await fleet.addBlob(read("tasks_sync.wasm")), sync2: await fleet.addBlob(read("tasks_sync_v2.wasm")) };
const fields = { hosts: { main: "client", sync: "server" } };
const pinned = structuredClone(fleet.keyring);

const vS1 = await fleet.publish("stable", { main: H.shared, sync: H.sync }, { order: ["main"], fields });
const vB1 = await fleet.publish("beta", { main: H.shared, sync: H.sync }, { order: ["main"], fields });

// ---------- the server host: joins the fleet on both channels ----------
const dir = mkdtempSync(join(tmpdir(), "llp-channels-"));
const KEY = dataKeyFrom(generateDataKey());
const auth = tokenAuth("channels-secret");
const logs = [];
const makeServer = () => new ServerHost({ authenticate: auth.authenticate, windowMs: WINDOW, idleMs: 0, dataDir: dir, dataKey: KEY, fleet: { keyring: pinned, id: "srv" }, onLog: (e) => logs.push(e) });
let srv = makeServer();
await srv.joinFleet(fleetUrl, ["stable", "beta"], { retryMs: 100 });
let port = await srv.listen(0);
let url = `ws://127.0.0.1:${port}`;
const lane = (ch) => srv.tenant(APP).lanes.get(ch);
await until(() => lane("stable")?.version === vS1 && lane("beta")?.version === vB1);

// Client hosts behind the server, each on a channel with a device id and the app's pinned keyring.
function client(user, channel, id) {
  const c = { user, channel, id };
  c.host = new LiveHost({ app: APP });
  c.trust = new TrustStore(structuredClone(pinned));
  c.link = connectServer(c.host, url, { app: APP, token: auth.issue(user, APP), channel, id, trust: c.trust, upgradeWaitMs: 1500, retryMs: 100 });
  return c;
}
// A raw client speaking the wire protocol, to make calls at a chosen version.
async function raw(user, channel) {
  const ws = new WebSocket(url); const inbox = [];
  ws.onmessage = (e) => inbox.push(JSON.parse(e.data));
  await new Promise((r) => ws.onopen = r);
  ws.send(JSON.stringify({ t: "hello", llp: 1, app: APP, channel, version: 0, have: [], token: auth.issue(user, APP) }));
  let n = 0;
  const call = async (op, args, version, slot = "sync") => {
    const id = "r" + ++n; ws.send(JSON.stringify({ t: "call", id, slot, op, args, version }));
    await until(() => inbox.some((m) => m.id === id), 5000);
    return inbox.find((m) => m.id === id) ?? { timeout: true };
  };
  await until(() => inbox.some((m) => m.t === "shared"));
  return { ws, inbox, call, close: () => ws.close() };
}

const s1 = client("sam", "stable", "dev-sam"), b1 = client("bea", "beta", "dev-bea");
await until(() => s1.host.version === vS1 && b1.host.version === vB1);
check("C1 the server host follows both channels, each with its own release, and its clients get their channel's",
  lane("stable").version === vS1 && lane("beta").version === vB1 && s1.host.version === vS1 && b1.host.version === vB1,
  `stable lane v${lane("stable").version}, beta lane v${lane("beta").version}`);

// Beta gets a new server half with a schema migration; stable stays on v1 code.
const vB2 = await fleet.publish("beta", { main: H.shared2, sync: H.sync2 }, { order: ["main"], fields });
await until(() => b1.host.version === vB2);
await sleep(WINDOW + 150); // the old overlap window has long closed
const rs = await raw("sam", "stable"), rb = await raw("bea", "beta");
const stableAdd = await rs.call("add", "written on stable", vS1);
const betaAdd = await rb.call("add", "written on beta", vB2);
const t = srv.tenant(APP);
check("C2 after the overlap window, stable clients' calls still work while beta runs newer server code (FL-01)",
  stableAdd.ok && betaAdd.ok && lane("stable").version === vS1 && t.kv.get(`shared/tasks.${stableAdd.value}.pri`) === undefined && t.kv.get(`shared/tasks.${betaAdd.value}.pri`) !== undefined,
  `stable add → ${JSON.stringify(stableAdd.value ?? stableAdd.error)} (v1 code, no .pri); beta add → ${betaAdd.value} (v2 code)`);
check("C3 the stable client never received the beta release", s1.host.version === vS1 && !s1.link.received.some((m) => m.includes('"channel":"beta"')));
await until(() => b1.host.kv.get(`shared/tasks.${stableAdd.value}.text`) === "written on stable");
check("C4 both channels share one store: a stable write reaches the beta client's mirror", b1.host.kv.get(`shared/tasks.${stableAdd.value}.text`) === "written on stable");
check("C5 beta's migration ran once, on the shared data, and stable's v1 code reads the migrated data",
  t.kv.get("__schema.sync") === 2 && t.kv.get("server/migrated.from") === 1 && (await rs.call("count", "", vS1)).value === String(t.kv.get("shared/tasks.n")));

// ---------- restart: both lanes come back; stable's older code joins the migrated data ----------
for (const x of [rs, rb]) x.close();
srv.close();
srv = makeServer();
const restored = await srv.ready;
await srv.joinFleet(fleetUrl, ["stable", "beta"], { retryMs: 100 });
port = await srv.listen(port);
const rs2 = await raw("sam", "stable");
const afterRestart = await rs2.call("count", "", vS1);
check("C6 after a restart both channels are restored (beta, which migrated, first) and stable's v1 code still answers",
  restored.length === 2 && restored.every((r) => r.ok) && restored[0].channel === "beta" && afterRestart.ok && lane("stable").version === vS1 && srv.tenant(APP).kv.get("__schema.sync") === 2,
  restored.map((r) => `${r.channel}: ${r.ok ? "ok" : r.reason}`).join(", ") + `; count ${afterRestart.value}`);

// ---------- a partial rollout on stable: clients outside the share keep their release ----------
const seed = `${APP}/stable`;
const ids = []; for (let i = 0; ids.length < 2 || !ids.some((x) => x.b < 5000) || !ids.some((x) => x.b >= 5000); i++) { const id = `dev-${i}`; ids.push({ id, b: await bucketOf(id, seed) }); }
const inId = ids.find((x) => x.b < 5000).id, outId = ids.find((x) => x.b >= 5000).id;
const sIn = client("ivy", "stable", inId), sOut = client("otto", "stable", outId), sNoId = client("nora", "stable", undefined);
await until(() => [sIn, sOut, sNoId].every((c) => c.host.version === vS1));
const vS2 = await fleet.publish("stable", { main: H.shared2, sync: H.sync2 }, { order: ["main"], fields, percent: 50 });
await until(() => sIn.host.version === vS2 && lane("stable").version === vS2);
await until(() => srv.clientStatus(APP).stable?.skipped >= 2);
await sleep(WINDOW + 150);
const outCall = await rs2.call("add", "from outside the share", vS1);
check("C7 at 50%, a client in the share takes the release; one outside it (and one with no device id) stays and says so",
  sIn.host.version === vS2 && sOut.host.version === vS1 && sNoId.host.version === vS1 && srv.clientStatus(APP).stable.skipped >= 2,
  JSON.stringify(srv.clientStatus(APP).stable));
check("C8 the release clients outside the share run stays served past the window, on its own code",
  outCall.ok && t.kv.get(`shared/tasks.${outCall.value}.pri`) === undefined && srv.tenant(APP).lanes.get("stable").served.get(vS1)?.until === Infinity, `v${vS1} call → ${outCall.value ?? outCall.error?.code}`);
const conv = fleet.convergence("stable");
check("C9 the controller sees the server host on each channel (it applies every share; its clients decide)",
  fleet.hosts.get("srv/stable")?.version === vS2 && fleet.hosts.get("srv/stable")?.state === "live" && fleet.hosts.get("srv/beta")?.version === vB2, `stable: ${conv.live} live, ${conv.skipped} skipped`);

// Restart again with the share still partial: the pinned release is restored and still served.
rs2.close(); srv.close();
srv = makeServer();
await srv.ready;
await srv.joinFleet(fleetUrl, ["stable", "beta"], { retryMs: 100 });
port = await srv.listen(port);
const rs3 = await raw("otto", "stable");
const pinnedCall = await rs3.call("count", "", vS1);
check("C10 a release pinned by a partial rollout is restored after a restart (its signature re-checked)", pinnedCall.ok && lane("stable").served.get(vS1)?.until === Infinity, `v${vS1} count → ${pinnedCall.value ?? pinnedCall.error?.code}`);

// Widen to 100%: the remaining clients move, and the old release closes after the window.
await until(() => [sIn, sOut, sNoId].every((c) => c.link.online));
await fleet.setPercent("stable", 100);
await until(() => sOut.host.version === vS2 && sNoId.host.version === vS2);
await sleep(WINDOW + 150);
const late = await rs3.call("count", "", vS1);
check("C11 widening to 100% moves everyone; then the older release closes after the window",
  sOut.host.version === vS2 && sNoId.host.version === vS2 && late.error?.code === "version_mismatch" && late.error.serverVersion === vS2, late.error?.message);

// ---------- key rotation reaches clients behind the server ----------
await fleet.rotateReleaseKey();
await until(() => srv.trust.version === 2 && [s1, sIn, sOut, b1].every((c) => c.trust.version === 2 && c.host.epoch === 2), 8000);
const rotated = await rs3.call("count", "", vS2);
check("C12 a release key rotation reaches the server and the clients behind it; re-signed releases (epoch 2) apply",
  srv.trust.version === 2 && [s1, sIn, sOut, b1].every((c) => c.trust.version === 2 && c.host.epoch === 2) && lane("stable").epoch === 2 && rotated.ok,
  `server keyring ${srv.trust.version}; clients: ${[s1, sIn, sOut, b1].map((c) => `${c.trust.version}/e${c.host.epoch}`).join(" ")}`);
rs3.close(); srv.close();
srv = makeServer();
await srv.ready;
check("C13 a restarted server host keeps the accepted keyring (it doesn't fall back to the revoked key)", srv.trust.version === 2 && srv.trustedKeys.length === 1 && srv.trustedKeys[0].x === fleet.keyring.release.keys[0].x);
srv.close();

// ---------- a client refuses a release for another channel, even from its own server ----------
{
  const fake = new WebSocketServer({ port: 0 });
  await new Promise((r) => fake.on("listening", r));
  const beta = fleet.channels.get("beta").current;
  const got = [];
  fake.on("connection", (ws) => { ws.on("message", (m) => got.push(JSON.parse(m))); ws.send(JSON.stringify({ t: "manifest", ...beta })); });
  const h = new LiveHost({ app: APP });
  const trust = new TrustStore(structuredClone(fleet.keyring));
  const link = connectServer(h, `ws://127.0.0.1:${fake.address().port}`, { app: APP, token: "x", channel: "stable", id: "dev-x", trust });
  await until(() => got.some((m) => m.t === "nack"));
  const nack = got.find((m) => m.t === "nack");
  check("C14 a client on stable refuses a beta release relayed to it", h.version === 0 && /channel beta/.test(nack?.reason ?? ""), nack?.reason);
  link.close(); fake.close();
}

// ---------- encryption at rest held all along ----------
{
  const files = [];
  const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); statSync(p).isDirectory() ? walk(p) : files.push(p); } };
  walk(dir);
  const notBlobs = files.filter((f) => !f.includes(`${join(dir, "blobs")}`) && !f.endsWith("app.txt"));
  const leaks = notBlobs.filter((f) => { const s = readFileSync(f, "utf8"); return s.includes("written on stable") || s.includes('"manifest"') || s.includes("private"); });
  const sealed = notBlobs.filter((f) => readFileSync(f, "utf8").split("\n").filter(Boolean).every((l) => l.startsWith("LLPE1.")));
  check("C15 every state, release, keyring and device-key file in the server's data dir is sealed (only blobs and app names are plain)",
    notBlobs.length >= 6 && !leaks.length && sealed.length === notBlobs.length, `${notBlobs.length} files sealed: ${notBlobs.map((f) => f.slice(dir.length + 1)).join(", ")}`);
}

for (const c of [s1, b1, sIn, sOut, sNoId]) { c.link.close(); c.host.close(); }
wss.close();
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
