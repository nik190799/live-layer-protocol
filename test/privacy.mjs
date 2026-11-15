// Proof for SPEC section 14 (red-team PR-02 and PR-03): finding, exporting and erasing one person's
// data across the server host and their device, with an audit log; and encryption at rest.
import { readFileSync, writeFileSync, appendFileSync, mkdtempSync, readdirSync, statSync, cpSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiveHost, sha256, generatePublisherKey, signManifest } from "../host/llp-core.js";
import { ServerHost } from "../host/server-host.mjs";
import { connectServer } from "../host/remote-client.mjs";
import { generateDataKey, dataKeyFrom } from "../host/at-rest.mjs";

const read = (f) => new Uint8Array(readFileSync(new URL(`../build/${f}`, import.meta.url)));
const results = [];
const check = (name, cond, detail = "") => { results.push(!!cond); console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, ms = 5000) { const t = performance.now(); while (!(await cond())) { if (performance.now() - t > ms) return false; await sleep(5); } return true; }
const files = (dir) => { const out = []; const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); statSync(p).isDirectory() ? walk(p) : out.push(p); } }; walk(dir); return out; };
const grepDir = (dir, s) => files(dir).filter((f) => !f.includes("/blobs/") && readFileSync(f, "utf8").includes(s));

const key = await generatePublisherKey();
const blobs = new Map();
const put = async (f) => { const b = read(f); const h = await sha256(b); blobs.set(h, b); return h; };
const H = { main: await put("tasks_shared.wasm"), profile: await put("profile.wasm"), pay: await put("pay.wasm") };
const fetchBlob = async (h) => blobs.get(h);
const APP = "demo.privacy";
const manifest = {
  app: APP, version: 1, layers: { main: H.main, profile: H.profile, pay: H.pay }, order: ["main"],
  hosts: { main: "client", profile: "server", pay: "server" },
  private: ["shared/users/"],       // readable only by the user it names, and personal
  personal: ["server/profiles/"],   // never leaves the server, and personal
};
const sig = await signManifest(manifest, key.privateKey);

// Tokens are "user" in these tests; the server's authenticate hook decides who a caller is.
const authenticate = (token) => (typeof token === "string" && /^[a-z]+$/.test(token) ? token : null);
let charges = 0;
const capabilities = { charge: async (arg, ctx) => `ok ch_${++charges} ${arg} (${ctx.callId})` };

// ---------- P: one person's data ----------
const dir = mkdtempSync(join(tmpdir(), "llp-privacy-"));
const make = (opts = {}) => new ServerHost({ trustedKeys: [key.publicJwk], authenticate, capabilities, dataDir: dir, idleMs: 0, ...opts });
let srv = make();
await srv.ready;
const off = await srv.offer(manifest, sig, fetchBlob);
let port = await srv.listen(0);
let t = srv.tenant(APP);
const call = (user, slot, op, args, idem) => srv.call(t, user, { id: 1, slot, op, args, version: 1, idem });

function client(user, opts = {}) {
  const c = { host: new LiveHost({ app: APP, trustedKeys: [key.publicJwk] }) };
  c.link = connectServer(c.host, `ws://127.0.0.1:${port}`, { app: APP, token: user, retryMs: 100, ...opts });
  return c;
}
const alice = client("alice"), bob = client("bob");
await until(() => alice.host.version === 1 && bob.host.version === 1);
await call("alice", "profile", "setname", "Alice Example", "a1");
await call("alice", "profile", "setemail", "alice@example.test", "a2");
await call("alice", "profile", "post", "hello from alice", "a3");
const paid = await call("alice", "pay", "checkout", "500", "order-1");
await call("bob", "profile", "setname", "Bob Example", "b1");
await call("bob", "profile", "setemail", "bob@example.test", "b2");
alice.host.setBound("draft", "alice's unsent draft"); // state that lives only on alice's device
await until(() => alice.host.kv.get("shared/users/alice/name") === "Alice Example");
check("P0 setup: alice's data is spread over shared, server-only and call records; only alice's device mirrors her private key",
  off.ok && paid.ok && alice.host.kv.get("shared/users/alice/name") === "Alice Example" && !bob.host.kv.has("shared/users/alice/name") && !alice.host.kv.has("server/profiles/alice/email"));

const ex = await srv.exportUser(APP, "alice", { by: "dpo@operator" });
const exText = JSON.stringify(ex);
check("P1 export finds alice's keys by the manifest's personal and private prefixes, her call results and her payment's effect",
  ex.keys["shared/users/alice/name"] === "Alice Example" && ex.keys["server/profiles/alice/email"] === "alice@example.test" && Object.keys(ex.keys).length === 2 &&
  ex.calls.some((c) => c.id === "order-1" && /ch_1/.test(c.result.value)) && ex.effects.some((e) => e.callId === "alice:order-1#1.0" || e.callId.startsWith("alice:order-1#")),
  `${Object.keys(ex.keys).length} keys, ${ex.calls.length} call records, ${ex.effects.length} effects`);
check("P2 export holds nothing of bob's", !exText.includes("bob@example.test") && !exText.includes("Bob Example") && !exText.includes("bob:"));
check("P3 export says what it can't see: a layer's own copies outside personal prefixes (alice's id in the shared feed)",
  /not included/.test(ex.notice) && t.kv.get("shared/feed.0.by") === "alice" && !("shared/feed.0.by" in ex.keys));

const erased = await srv.eraseUser(APP, "alice", { by: "dpo@operator" });
await until(() => !alice.host.kv.has("shared/users/alice/name") && !alice.host.kv.has("draft"));
check("P4 erase removes alice's keys, call records and effects on the server; bob's are untouched",
  erased.keys === 2 && erased.calls >= 4 && erased.effects >= 1 && !t.kv.has("shared/users/alice/name") && !t.kv.has("server/profiles/alice/email") &&
  t.kv.get("server/profiles/bob/email") === "bob@example.test" && ![...t.effects.keys()].some((k) => k.startsWith("alice:")),
  JSON.stringify({ keys: erased.keys, calls: erased.calls, effects: erased.effects }));
check("P5 alice's device drops her mirrored key and clears its own copy of her app state; bob's device is untouched",
  !alice.host.kv.has("shared/users/alice/name") && !alice.host.kv.has("draft") && alice.host.history.some((h) => h.kind === "privacy") && !bob.host.history.some((h) => h.kind === "privacy"));
const again = await call("alice", "pay", "checkout", "500", "order-1");
check("P6 a retry of an erased call isn't run again (no second charge): it gets 'erased'", again.ok === false && again.error.code === "erased" && charges === 1, again.error?.message);
check("P7 no erased value is left in any file of the data dir (the log was replaced by a snapshot); bob's still is",
  !grepDir(dir, "alice@example.test").length && !grepDir(dir, "Alice Example").length && grepDir(dir, "bob@example.test").length > 0);

alice.link.close(); bob.link.close(); alice.host.close(); bob.host.close();
srv.close();
srv = make();
await srv.ready;
t = srv.tenant(APP);
const retry2 = await call("alice", "pay", "checkout", "500", "order-1");
check("P8 after a restart alice's data stays gone, bob's is back, and the erased call still won't run",
  !t.kv.has("server/profiles/alice/email") && t.kv.get("server/profiles/bob/email") === "bob@example.test" && retry2.error?.code === "erased" && charges === 1);

const audit = srv.auditLog(APP);
check("P9 the audit log records the export and the erase (who, when, how much) without any of the data, and its chain verifies",
  audit.ok && audit.entries.map((e) => e.op).join() === "export,erase" && audit.entries.every((e) => e.by === "dpo@operator" && e.user === "alice") && !JSON.stringify(audit.entries).includes("example.test"),
  JSON.stringify(audit.entries.map(({ op, keys, calls, effects }) => ({ op, keys, calls, effects }))));
{
  const f = files(dir).find((x) => x.endsWith("audit.jsonl"));
  const lines = readFileSync(f, "utf8").split("\n").filter(Boolean);
  writeFileSync(f, lines.slice(1).join("\n") + "\n"); // someone removes the export entry
  srv.close();
  srv = make(); await srv.ready;
  const tampered = srv.auditLog(APP);
  check("P10 removing an audit line breaks the chain, and the check says where", !tampered.ok && tampered.brokenAt === 0);
  srv.close();
}

// Self-service over the client link: off by default; when on, a user can export and erase only their own data.
{
  srv = make();
  await srv.ready;
  port = await srv.listen(0);
  const carol = client("carol");
  await until(() => carol.host.version === 1);
  let refused;
  try { await carol.link.exportMine(); } catch (e) { refused = e.message; }
  check("P11 self-service export is off unless the operator turns it on", /unavailable/.test(refused ?? ""), refused);
  carol.link.close(); carol.host.close(); srv.close();

  srv = make({ selfService: true });
  await srv.ready;
  port = await srv.listen(0);
  t = srv.tenant(APP);
  const dave = client("dave");
  await until(() => dave.host.version === 1 && dave.link.online);
  await call("dave", "profile", "setemail", "dave@example.test", "d1");
  dave.host.setBound("draft", "dave's draft");
  // Dave asks for "bob": the server ignores any user field and uses the signed-in user.
  const sent = dave.link.sent.length;
  const mine = await dave.link.exportMine();
  check("P12 a user's self-service export covers the server and the device, and only their own data",
    mine.server.user === "dave" && mine.server.keys["server/profiles/dave/email"] === "dave@example.test" && mine.device.keys.draft === "dave's draft" && !JSON.stringify(mine).includes("bob@example.test") && dave.link.sent.length > sent);
  const gone = await dave.link.eraseMine();
  check("P13 a user's self-service erase clears the server and the device", gone.server.keys === 1 && !t.kv.has("server/profiles/dave/email") && !dave.host.kv.has("draft") && srv.auditLog(APP).entries.at(-1).by === "self:dave");
  dave.link.close(); dave.host.close(); srv.close();
}

// The personal field is signed manifest data: checked like the others, and allowed in strict LLP 1.
{
  const h = new LiveHost({ app: APP, allowUnsigned: true, role: "server" });
  const bad1 = await h.apply({ ...manifest, version: 2, personal: ["__schema."] });
  const bad2 = await h.apply({ ...manifest, version: 3, personal: ["noslash"] });
  const strict = { llp: 1, app: APP, version: 4, layers: { profile: H.profile }, order: [], hosts: { profile: "server" }, keys: { profile: { own: ["shared/users/", "server/profiles/", "shared/feed."] } }, caps: {}, personal: ["server/profiles/", "shared/users/"] };
  h.blobs.set(H.profile, blobs.get(H.profile));
  const ok = await h.apply(strict, null, fetchBlob);
  check("P14 personal prefixes are validated (no __ keys, must end in /) and accepted in a strict LLP 1 manifest", !bad1.ok && !bad2.ok && ok.ok, `${bad1.reason} / ${ok.reason ?? "ok"}`);
  h.close();
}

// ---------- E: encryption at rest ----------
const K1 = generateDataKey(), K2 = generateDataKey();
{
  process.env.LLP_TEST_KEY = K1;
  const kf = join(mkdtempSync(join(tmpdir(), "llp-key-")), "data.key");
  writeFileSync(kf, K1, { mode: 0o600 });
  const fromEnv = dataKeyFrom({ env: "LLP_TEST_KEY" }), fromFile = dataKeyFrom({ file: kf });
  const fromCmd = dataKeyFrom({ command: `node -e "process.stdout.write(process.env.LLP_TEST_KEY)"` });
  chmodSync(kf, 0o644);
  let open = null, short = null;
  try { dataKeyFrom({ file: kf }); } catch (e) { open = e.message; }
  try { dataKeyFrom({ key: "c2hvcnQ=" }); } catch (e) { short = e.message; }
  check("E1 a data key comes from an env var, a 0600 file or a keystore command; a file others can read, or a short key, is refused",
    fromEnv.equals(fromFile) && fromFile.equals(fromCmd) && /other users/.test(open ?? "") && /32 bytes/.test(short ?? ""), open);
}
{
  // The plaintext data dir from the P tests (bob's data is still there) is encrypted in place.
  const logs = [];
  srv = make({ dataKey: dataKeyFrom(K1), onLog: (e) => logs.push(e) });
  await srv.ready;
  t = srv.tenant(APP);
  const plainLeft = grepDir(dir, "bob@example.test");
  check("E2 starting with a key on a plaintext data dir encrypts it; the data is intact",
    logs.some((e) => /encrypted at rest/.test(e.msg)) && !plainLeft.length && t.kv.get("server/profiles/bob/email") === "bob@example.test" && t.host.version === 1, plainLeft.join(", "));
  await call("bob", "profile", "setname", "Bob Renamed", "b3");
  srv.close();
  const sealed = files(dir).filter((f) => !f.includes("/blobs/") && !f.endsWith("app.txt")).every((f) => readFileSync(f, "utf8").split("\n").filter(Boolean).every((l) => l.startsWith("LLPE1.")));
  check("E3 with a key, every file but blobs and app names is sealed, each log line on its own", sealed && !grepDir(dir, "Bob Renamed").length);

  srv = make({ dataKey: dataKeyFrom(K1) }); await srv.ready;
  check("E4 a restart with the key restores everything", srv.tenant(APP).kv.get("shared/users/bob/name") === "Bob Renamed" && srv.tenant(APP).host.version === 1);
  srv.close();
  let noKey, wrongKey;
  try { make(); } catch (e) { noKey = e.message; }
  try { make({ dataKey: dataKeyFrom(K2) }); } catch (e) { wrongKey = e.message; }
  check("E5 without the key, or with another key, the server host refuses to start (it never reads sealed data as plain)", /encrypted at rest/.test(noKey ?? "") && /doesn't match/.test(wrongKey ?? ""), `${noKey} / ${wrongKey}`);

  const logs2 = [];
  srv = make({ dataKey: dataKeyFrom(K2), previousDataKeys: [dataKeyFrom(K1)], onLog: (e) => logs2.push(e) }); await srv.ready;
  const kept = srv.tenant(APP).kv.get("shared/users/bob/name");
  srv.close();
  let oldRefused;
  try { make({ dataKey: dataKeyFrom(K1) }); } catch (e) { oldRefused = e.message; }
  check("E6 a new key with previousDataKeys re-encrypts the data dir; afterwards the old key is refused", logs2.some((e) => /rekeyed/.test(e.msg)) && kept === "Bob Renamed" && /doesn't match/.test(oldRefused ?? ""));

  // Tampering: a changed byte in a middle log line stops the start; a torn last line is ignored.
  srv = make({ dataKey: dataKeyFrom(K2), compactEvery: 100 }); await srv.ready; t = srv.tenant(APP);
  for (let i = 0; i < 3; i++) await call("bob", "profile", "post", "post " + i, "p" + i);
  srv.close();
  const logf = files(dir).find((f) => f.endsWith("log.jsonl"));
  const good = readFileSync(logf, "utf8");
  appendFileSync(logf, "LLPE1.AAAA"); // a crash mid-append
  srv = make({ dataKey: dataKeyFrom(K2) }); await srv.ready;
  const tornOk = srv.tenant(APP).kv.get("shared/feed.n") === 4;
  srv.close();
  const rows = good.split("\n");
  rows[0] = rows[0].slice(0, 20) + (rows[0][20] === "A" ? "B" : "A") + rows[0].slice(21);
  writeFileSync(logf, rows.join("\n"));
  let tampered;
  try { const s = make({ dataKey: dataKeyFrom(K2) }); await s.ready; s.close(); } catch (e) { tampered = e.message; }
  check("E7 a torn last line is ignored, but a changed byte in an earlier sealed line stops the start (GCM tamper check)", tornOk && /corrupt log line 1/.test(tampered ?? ""), tampered);
  writeFileSync(logf, good);

  // A sealed record is bound to its tenant and file: copied into another tenant, it doesn't open.
  srv = make({ dataKey: dataKeyFrom(K2) }); await srv.ready;
  const m2 = { ...manifest, app: "demo.other", version: 1 };
  await srv.offer(m2, await signManifest(m2, key.privateKey), fetchBlob);
  srv.close();
  const tdirs = readdirSync(join(dir, "tenants")).map((d) => join(dir, "tenants", d));
  const [a, b] = tdirs.sort((x, y) => (readFileSync(join(x, "app.txt"), "utf8") === APP ? -1 : 1));
  cpSync(join(a, "log.jsonl"), join(b, "log.jsonl"));
  let moved;
  try { const s = make({ dataKey: dataKeyFrom(K2) }); await s.ready; s.close(); } catch (e) { moved = e.message; }
  check("E8 a sealed log copied from one tenant into another fails to open (records are bound to their tenant)", /demo.other.*corrupt log line 1/.test(moved ?? ""), moved);
}

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
