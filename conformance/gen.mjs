// Generates the LLP conformance vectors in conformance/vectors/. Run: node conformance/gen.mjs
//
// The vectors are language-neutral JSON. Expected results are written by hand from SPEC.md, except
// UI trees marked "recorded" (taken from the reference host, then checked against the Go host).
// Keys in conformance/keys.json are test-only keys; never trust them anywhere.
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { canonical, sha256, b64 } from "../host/llp-core.js";
import { signDoc, keyId } from "../host/fleet.js";

const dir = new URL(".", import.meta.url);
const keysFile = JSON.parse(readFileSync(new URL("keys.json", dir), "utf8"));
const ECDSA = { name: "ECDSA", namedCurve: "P-256" };
const keys = {};
for (const [n, k] of Object.entries(keysFile)) keys[n] = { priv: await crypto.subtle.importKey("jwk", k.private, ECDSA, false, ["sign"]), pub: k.public };
const te = new TextEncoder();
const rawSign = async (doc, name) => new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys[name].priv, te.encode(canonical(doc))));
const sign = async (doc, name = "publisher") => b64.enc(await rawSign(doc, name));
const pubOf = (name) => keys[name].pub;

const build = new URL("../build/", dir);
const H = {};
for (const f of readdirSync(build)) if (f.endsWith(".wasm")) H[f.replace(/\.wasm$/, "")] = await sha256(readFileSync(new URL(f, build)));
const write = (name, v) => writeFileSync(new URL(`vectors/${name}.json`, dir), JSON.stringify(v, null, 1) + "\n");
const NOW = 1767225600000; // 2026-01-01T00:00:00Z: every vector runs with this clock

// ---------- 1. canonical JSON (SPEC section 4) ----------
const canon = [
  ["sorted keys, no whitespace", `{ "b": 1, "a": [ 1, 2 ], "c": { "z": null, "y": true } }`, `{"a":[1,2],"b":1,"c":{"y":true,"z":null}}`],
  ["keys sort by UTF-16 code units, not bytes or code points", `{"￿":1,"😀":2,"a":3,"Z":4}`, `{"Z":4,"a":3,"😀":2,"￿":1}`],
  ["integers lose a trailing .0", `{"v":1.0,"w":100e0,"x":-0}`, `{"v":1,"w":100,"x":0}`],
  ["number formatting follows ECMAScript Number::toString", `[1e21,1e20,123456789012345680000,0.000001,1e-7,1.5e-7,0.1,5e-324,1.7976931348623157e308,-2.5e-8]`, `[1e+21,100000000000000000000,123456789012345680000,0.000001,1e-7,1.5e-7,0.1,5e-324,1.7976931348623157e+308,-2.5e-8]`],
  ["safe-integer edge survives", `[9007199254740991,-9007199254740991,1794719346499]`, `[9007199254740991,-9007199254740991,1794719346499]`],
  ["string escapes match JSON.stringify", `["\\u0001\\u001f","\\b\\f\\n\\r\\t","\\"\\\\","\\/","\\u007f","\\u2028\\u2029","é","😀"]`, `["\\u0001\\u001f","\\b\\f\\n\\r\\t","\\"\\\\","/","\u007f","  ","é","😀"]`],
  ["duplicate keys: the last one wins", `{"a":1,"a":2}`, `{"a":2}`],
  ["empty containers", `{"a":{},"b":[],"c":""}`, `{"a":{},"b":[],"c":""}`],
].map(([name, json, out]) => ({ name, json, canonical: out }));
canon.push({ name: "a lone surrogate has no canonical form (I-JSON): refuse", json: `{"a":"\\ud800"}`, error: true });
canon.push({ name: "a lone low surrogate is refused too", json: `["x\\udc00y"]`, error: true });
write("canonical", canon);

// ---------- 2. crypto: hashes, key ids, signatures, buckets (SPEC 3.2, 4, 12.2, 12.4) ----------
const doc = { app: "demo.tasks", version: 7, layers: { main: H.tasks }, order: ["main"] };
const good = await rawSign(doc, "publisher");
const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const big = (u) => BigInt("0x" + [...u].map((b) => b.toString(16).padStart(2, "0")).join(""));
const bytes32 = (n) => { const h = n.toString(16).padStart(64, "0"); return Uint8Array.from(h.match(/../g).map((x) => parseInt(x, 16))); };
const r = good.slice(0, 32), s = good.slice(32);
const highS = new Uint8Array([...r, ...bytes32(N - big(s))]);
const derInt = (u) => { let i = 0; while (i < u.length - 1 && u[i] === 0) i++; let v = [...u.slice(i)]; if (v[0] & 0x80) v = [0, ...v]; return [2, v.length, ...v]; };
const der = (() => { const body = [...derInt(r), ...derInt(s)]; return new Uint8Array([0x30, body.length, ...body]); })();
const tampered = { ...doc, version: 8 };
const offCurve = { ...pubOf("publisher"), y: pubOf("attacker").y };
const crypto_ = {
  sha256: [
    { name: "empty input", hex: "", sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" },
    { name: "abc", hex: "616263", sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" },
    ...["tasks", "stats", "tasks_v2"].map((f) => ({ name: `build/${f}.wasm`, file: `${f}.wasm`, sha256: H[f] })),
  ],
  keyId: ["publisher", "root1"].map((n) => ({ name: n, jwk: pubOf(n) })),
  verify: [
    { name: "valid signature", doc, sig: b64.enc(good), jwk: pubOf("publisher"), valid: true },
    { name: "signature without base64 padding is still read", doc, sig: b64.enc(good).replace(/=+$/, ""), jwk: pubOf("publisher"), valid: true },
    { name: "high-S form of a valid signature is accepted (no low-S rule)", doc, sig: b64.enc(highS), jwk: pubOf("publisher"), valid: true },
    { name: "same signature, edited document", doc: tampered, sig: b64.enc(good), jwk: pubOf("publisher"), valid: false },
    { name: "same signature, other key", doc, sig: b64.enc(good), jwk: pubOf("attacker"), valid: false },
    { name: "DER-encoded signature is not the wire format", doc, sig: b64.enc(der), jwk: pubOf("publisher"), valid: false },
    { name: "truncated signature", doc, sig: b64.enc(good.slice(0, 63)), jwk: pubOf("publisher"), valid: false },
    { name: "r = 0", doc, sig: b64.enc(new Uint8Array([...new Uint8Array(32), ...s])), jwk: pubOf("publisher"), valid: false },
    { name: "key point not on the curve", doc, sig: b64.enc(good), jwk: offCurve, valid: false },
    { name: "signature is over canonical JSON, so key order on the wire doesn't matter", docJson: `{"order":["main"],"version":7,"layers":{"main":"${H.tasks}"},"app":"demo.tasks"}`, sig: b64.enc(good), jwk: pubOf("publisher"), valid: true },
  ],
  bucket: [["host-1", "demo.tasks/stable"], ["host-2", "demo.tasks/stable"], ["phone-ab12", "demo.tasks/beta"], ["", "x"], ["é😀", "seed"]].map(([host, seed]) => ({ host, seed })),
};
for (const k of crypto_.keyId) k.kid = await keyId(k.jwk);
const { bucketOf } = await import("../host/fleet.js");
for (const b of crypto_.bucket) b.bucket = await bucketOf(b.host, b.seed); // checked by hand for host-1 below
crypto_.bucket[0].note = "uint32 of the first 4 bytes of sha256('demo.tasks/stable\\nhost-1'), mod 10000";
write("crypto", crypto_);

// ---------- 3. scenarios: manifests, versions, swaps, migrations, rollback (SPEC 4-9) ----------
const M = (version, layers, extra = {}) => ({ app: "demo.tasks", version, layers, order: Object.keys(layers), ...extra });
const apply = async (manifest, expect, { signer = "publisher", serve } = {}) => ({ op: "apply", manifest, sig: signer ? await sign(manifest, signer) : "", ...(serve ? { serve } : {}), expect });
const host = (extra = {}) => ({ app: "demo.tasks", keys: ["publisher"], now: NOW, caps: { haptic: { none: true }, geo: { result: "41.88, -87.63 (fixture)" } }, ...extra });
const both = { main: H.tasks, footer: H.stats };
const scenarios = [];
const S = (name, hostCfg, steps) => scenarios.push({ name, host: hostCfg, steps });

S("two languages render side by side; events, bound inputs and capabilities", host(), [
  await apply(M(1, both), { ok: true }),
  { op: "expect", views: { main: "recorded", footer: "recorded" }, state: { "__schema.main": 1, "__schema.footer": 1 } },
  { op: "bind", key: "draft", value: "Write spec" }, { op: "event", slot: "main", id: "add" },
  { op: "bind", key: "draft", value: "Ship demo" }, { op: "event", slot: "main", id: "add" },
  { op: "event", slot: "main", id: "t:0" },
  { op: "expect", state: { "tasks.n": 2, "tasks.0.text": "Write spec", "tasks.0.done": 1, "tasks.1.done": 0, draft: "" }, text: { footer: "Progress (C layer)|50%|Where am I?|Buzz" }, capsCalled: [["haptic", "20"]] },
  { op: "event", slot: "footer", id: "where" },
  { op: "expect", state: { geo: "41.88, -87.63 (fixture)" }, capsCalled: [["haptic", "20"], ["geo", ""]] },
]);
S("live swap keeps state, fetches only new blobs, and runs the schema migration", host(), [
  await apply(M(1, both), { ok: true }),
  { op: "bind", key: "draft", value: "a" }, { op: "event", slot: "main", id: "add" },
  await apply(M(2, { main: H.tasks_v2, footer: H.stats }), { ok: true, swapped: ["main"], fetched: [H.tasks_v2] }),
  { op: "expect", version: 2, state: { "tasks.0.text": "a", "tasks.0.pri": 1, "migrated.from": 1, "__schema.main": 2 }, running: { main: H.tasks_v2, footer: H.stats } },
]);
S("a layer that fails its health check is refused; the running version is untouched", host(), [
  await apply(M(1, both), { ok: true }),
  await apply(M(2, { main: H.tasks_broken, footer: H.stats }), { ok: false, code: "layer_failed" }),
  { op: "expect", version: 1, running: { main: H.tasks } },
]);
S("a trap during an event drops the event's writes and reverts to the newest earlier layer on the same schema", host(), [
  await apply(M(1, both), { ok: true }),
  { op: "bind", key: "draft", value: "keep" }, { op: "event", slot: "main", id: "add" },
  await apply(M(2, { main: H.tasks_v2, footer: H.stats }), { ok: true }),
  await apply(M(3, { main: H.tasks_trap, footer: H.stats }), { ok: true }),
  { op: "expect", state: { "__schema.main": 1 } },
  { op: "bind", key: "draft", value: "this traps" }, { op: "event", slot: "main", id: "add" },
  { op: "expect", state: { "tasks.n": 1 }, running: { main: H.tasks }, rollbacks: 1, version: 3 },
]);
S("a trap with nothing to revert to restarts the same version", host(), [
  await apply(M(1, { main: H.tasks_trap }), { ok: true }),
  { op: "bind", key: "draft", value: "x" }, { op: "event", slot: "main", id: "add" },
  { op: "expect", state: { "tasks.n": null }, running: { main: H.tasks_trap }, rollbacks: 0 },
  { op: "bind", key: "draft", value: "" }, { op: "event", slot: "main", id: "add" },
  { op: "expect", text: { main: "recorded" } },
]);
S("an event that runs past the time limit is cut off, its writes dropped, and the slot reverted", host(), [
  await apply(M(1, { main: H.tasks_v2 }), { ok: true }),
  await apply(M(2, { main: H.tasks_hang }), { ok: true }),
  { op: "bind", key: "draft", value: "hang event" }, { op: "event", slot: "main", id: "add" },
  { op: "expect", state: { "tasks.n": null }, running: { main: H.tasks_v2 }, rollbacks: 1 },
]);
S("a migration that never finishes rejects the manifest", host(), [
  await apply(M(1, { main: H.tasks }), { ok: true }),
  await apply(M(2, { main: H.tasks_hang_migrate }), { ok: false, code: "layer_failed" }),
  { op: "expect", version: 1, state: { "migrated.from": null, "__schema.main": 1 } },
]);
S("signatures and app pinning", host(), [
  await apply(M(1, both), { ok: false, code: "untrusted" }, { signer: "attacker" }),
  await apply(M(1, both), { ok: false, code: "untrusted" }, { signer: null }),
  await apply({ ...M(1, both), app: "other.app" }, { ok: false, code: "wrong_app" }),
  { op: "expect", version: 0 },
  await apply(M(1, both), { ok: true }),
]);
S("a host with no trusted keys refuses everything (fail closed)", host({ keys: [] }), [
  await apply(M(1, both), { ok: false, code: "untrusted" }),
]);
S("a host with no pinned app refuses signed manifests", host({ app: null }), [
  await apply(M(1, both), { ok: false, code: "untrusted" }),
]);
S("versions: replay, equal, bad values, too far ahead", host(), [
  await apply(M(5, both), { ok: true }),
  await apply(M(5, both), { ok: false, code: "stale" }),
  await apply(M(4, both), { ok: false, code: "stale" }),
  await apply(M(0, both), { ok: false, code: "bad_version" }),
  await apply(M(6.5, both), { ok: false, code: "bad_version" }),
  await apply(M(9007199254740992, both), { ok: false, code: "bad_version" }),
  await apply(M("6", both), { ok: false, code: "bad_version" }),
  await apply(M(NOW + 365 * 24 * 3600 * 1000 + 1, both), { ok: false, code: "bad_version" }),
  await apply(M(NOW + 365 * 24 * 3600 * 1000, both), { ok: true }),
  { op: "expect", version: NOW + 365 * 24 * 3600 * 1000 },
]);
S("epochs order releases ahead of versions, up to the trusted keyring", host({ maxEpoch: 2 }), [
  await apply(M(100, both), { ok: true }),
  await apply(M(3, both, { epoch: 3 }), { ok: false, code: "bad_version" }),
  await apply(M(1, both, { epoch: -1 }), { ok: false, code: "bad_version" }),
  await apply(M(1, both, { epoch: 1 }), { ok: true }),
  await apply(M(200, both, { epoch: 0 }), { ok: false, code: "stale" }),
  { op: "expect", version: 1, epoch: 1 },
]);
S("a plain host trusts epoch 0 only", host(), [
  await apply(M(1, both, { epoch: 1 }), { ok: false, code: "bad_version" }),
  await apply(M(1, both, { epoch: 0 }), { ok: true }),
]);
S("blobs: tampered, missing, content-addressed", host(), [
  await apply(M(1, both), { ok: false, code: "blob" }, { serve: { [H.tasks]: "tasks_v2.wasm" } }),
  await apply(M(1, { main: "ab".repeat(32) }), { ok: false, code: "blob" }),
  await apply(M(1, { main: "AB".repeat(32) }), { ok: false, code: "malformed" }),
  await apply(M(1, { main: 42 }), { ok: false, code: "malformed" }),
  await apply(M(1, both), { ok: true, fetched: [H.tasks] }), // stats passed its hash check in step 1 and was kept
]);
S("LLP 1 manifests are strict", host(), [
  await apply(M(1, both, { llp: 2, keys: {}, caps: {} }), { ok: false, code: "protocol" }),
  await apply(M(1, both, { llp: 1, caps: {} }), { ok: false, code: "protocol" }),
  await apply(M(1, both, { llp: 1, keys: { main: { own: ["tasks.", "draft"] }, footer: { own: ["geo"], read: ["tasks."] } } }), { ok: false, code: "protocol" }),
  await apply(M(1, both, { llp: 1, keys: { main: { own: ["tasks.", "draft"] }, footer: { own: ["geo"], read: ["tasks."] } }, caps: {}, color: "red" }), { ok: false, code: "protocol" }),
  await apply(M(1, both, { llp: 1, keys: { main: { own: ["tasks.", "draft"] }, footer: { own: ["geo"], read: ["tasks."] } }, caps: { main: ["haptic"] }, "x-note": "ignored" }), { ok: true }),
]);
S("v0 manifests ignore unknown fields", host(), [
  await apply(M(1, both, { color: "red" }), { ok: true }),
]);
const keysDecl = { main: { own: ["tasks.", "draft"] }, footer: { own: ["geo"], read: ["tasks."] } };
S("declared keys: malformed declarations are refused", host(), [
  await apply(M(1, both, { keys: { main: { own: ["tasks."] } } }), { ok: false, code: "malformed" }),
  await apply(M(1, both, { keys: { main: { own: ["tasks."] }, footer: { own: ["tasks.0"] } } }), { ok: false, code: "malformed" }),
  await apply(M(1, both, { keys: { main: { own: ["__schema.main"] }, footer: {} } }), { ok: false, code: "malformed" }),
  await apply(M(1, both, { keys: { main: { own: ["__"] }, footer: {} } }), { ok: false, code: "malformed" }),
  await apply(M(1, both, { keys: { main: { own: [""] }, footer: {} } }), { ok: false, code: "malformed" }),
  await apply(M(1, both, { caps: { pay: ["charge"] } }), { ok: false, code: "malformed" }),
  await apply(M(1, both, { private: ["users/"] }), { ok: false, code: "malformed" }),
  await apply(M(1, both, { personal: ["__x/"] }), { ok: false, code: "malformed" }),
  await apply(M(1, both, { personal: ["profiles"] }), { ok: false, code: "malformed" }),
  await apply(M(1, both, { overlap: -1 }), { ok: false, code: "malformed" }),
  await apply(M(1, both, { hosts: { main: "edge" } }), { ok: false, code: "malformed" }),
  await apply(M(1, both, { order: ["main", "nope"] }), { ok: false, code: "malformed" }),
  await apply(M(1, both, { keys: keysDecl }), { ok: true }),
  await apply(M(2, both, { llp: 1, keys: keysDecl, caps: {}, personal: ["profiles/"] }), { ok: true }),
]);
S("declared keys: a slot sees only what it owns or reads, and can't write outside what it owns", host(), [
  await apply(M(1, { main: H.tasks }), { ok: true }),
  { op: "bind", key: "draft", value: "mine" }, { op: "event", slot: "main", id: "add" },
  { op: "bind", key: "secret.note", value: "hidden" },
  await apply(M(2, { main: H.tasks, snoop: H.snoop }, { keys: { main: { own: ["tasks.", "draft"] }, snoop: { own: ["snoop."], read: ["tasks."] } } }), { ok: true }),
  { op: "expect", text: { snoop: "seen:mine||1.0" } },
  { op: "event", slot: "snoop", id: "own" },
  { op: "expect", state: { "snoop.count": 1 } },
  { op: "event", slot: "snoop", id: "overwrite" },
  { op: "expect", state: { "tasks.0.text": "mine" } },
  { op: "event", slot: "snoop", id: "schema" },
  { op: "expect", state: { "__schema.main": 1 } },
]);
S("without declared keys, no layer may write host keys", host(), [
  await apply(M(1, { main: H.tasks, snoop: H.snoop }), { ok: true }),
  { op: "event", slot: "snoop", id: "schema" },
  { op: "expect", state: { "__schema.main": 1 } },
]);
S("declared capabilities: an undeclared one is answered 'error: not granted'", host(), [
  await apply(M(1, both, { caps: { main: ["haptic"] } }), { ok: true }),
  { op: "event", slot: "footer", id: "where" },
  { op: "expect", state: { geo: "error: not granted" }, capsCalled: [] },
  { op: "event", slot: "footer", id: "buzz" },
  { op: "expect", capsCalled: [] },
]);
S("a capability the host doesn't offer is answered 'error: not granted'", host({ caps: {} }), [
  await apply(M(1, both), { ok: true }),
  { op: "event", slot: "footer", id: "where" },
  { op: "expect", state: { geo: "error: not granted" } },
]);
S("a capability that fails is answered 'error: <message>'", host({ caps: { geo: { error: "gps off" } } }), [
  await apply(M(1, both), { ok: true }),
  { op: "event", slot: "footer", id: "where" },
  { op: "expect", state: { geo: "error: gps off" } },
]);
S("placement: a client fetches and runs only client slots", host(), [
  await apply(M(1, { main: H.tasks, sync: "cd".repeat(32) }, { hosts: { main: "client", sync: "server" }, order: ["main"] }), { ok: true, fetched: [H.tasks] }),
  { op: "expect", running: { main: H.tasks, sync: null } },
]);
S("a client drops layer writes to shared/ (the server owns them)", host(), [
  await apply(M(1, { main: H.tasks_shared }), { ok: true }),
  { op: "event", slot: "main", id: "try-write" },
  { op: "expect", state: { "shared/tasks.n": null } },
  { op: "bind", key: "shared/x", value: "1" },
  { op: "expect", state: { "shared/x": null } },
]);
S("slots missing from a new manifest are removed; order decides what renders", host(), [
  await apply(M(1, both), { ok: true }),
  await apply(M(2, { main: H.tasks }), { ok: true }),
  { op: "expect", running: { main: H.tasks, footer: null }, renders: ["main"] },
  await apply(M(3, both, { order: ["footer"] }), { ok: true }),
  { op: "expect", renders: ["footer"] },
]);
S("a revert never runs old code on data in a newer schema", host(), [
  await apply(M(1, { main: H.tasks }), { ok: true }),
  await apply(M(2, { main: H.tasks_hang }), { ok: true }),
  { op: "expect", state: { "__schema.main": 2 } },
  { op: "bind", key: "draft", value: "hang event" }, { op: "event", slot: "main", id: "add" },
  { op: "expect", running: { main: H.tasks_hang }, rollbacks: 0, state: { "tasks.n": null } },
]);
S("development mode runs unsigned manifests", host({ keys: [], allowUnsigned: true, app: null }), [
  await apply(M(1, both), { ok: true }, { signer: null }),
]);
S("signatures cover the canonical form: a relay that re-orders keys changes nothing", host(), [
  { ...(await apply(M(1, both), { ok: true })), manifestJson: `{"order":["main","footer"],"layers":{"footer":"${H.stats}","main":"${H.tasks}"},"version":1,"app":"demo.tasks"}` },
]);
write("scenarios", scenarios);

// ---------- 4. keyrings (SPEC 12.4) ----------
const ring = (n, root, release, threshold = 1) => ({ app: "demo.tasks", keyring: n, root: { keys: root.map(pubOf), threshold }, release: { keys: release.map(pubOf) } });
const sigs = async (d, names) => { const out = []; for (const n of names) out.push(await signDoc(d, keys[n].priv, pubOf(n))); return out; };
const k1 = ring(1, ["root1", "root2", "root3"], ["publisher"], 2);
const k2 = ring(2, ["root1", "root2", "root3"], ["release2"], 2);
const k3 = ring(3, ["newroot1"], ["release2"]);
const k3old = ring(3, ["root1", "root2", "root3"], ["publisher"], 2);
const keyrings = [
  { name: "release-key rotation signed by 2 of 3 roots", pinned: k1, steps: [{ doc: k2, sigs: await sigs(k2, ["root1", "root3"]), ok: true }] },
  { name: "one root signature is below the threshold", pinned: k1, steps: [{ doc: k2, sigs: await sigs(k2, ["root1"]), ok: false }] },
  { name: "the same root signing twice counts once", pinned: k1, steps: [{ doc: k2, sigs: [...await sigs(k2, ["root2"]), ...await sigs(k2, ["root2"])], ok: false }] },
  { name: "a release key can't sign keyrings", pinned: k1, steps: [{ doc: k2, sigs: await sigs(k2, ["publisher", "release2"]), ok: false }] },
  { name: "keyrings must not skip a number", pinned: k1, steps: [{ doc: k3old, sigs: await sigs(k3old, ["root1", "root2"]), ok: false }] },
  { name: "stale and replayed keyrings are refused", pinned: k2, steps: [{ doc: k1, sigs: await sigs(k1, ["root1", "root2"]), ok: false }, { doc: k2, sigs: await sigs(k2, ["root1", "root2"]), ok: false }] },
  { name: "a keyring for another app is refused", pinned: k1, steps: [{ doc: { ...k2, app: "other" }, sigs: await sigs({ ...k2, app: "other" }, ["root1", "root2"]), ok: false }] },
  { name: "root rotation needs the old and the new root", pinned: k2, steps: [
    { doc: k3, sigs: await sigs(k3, ["root1", "root2"]), ok: false },
    { doc: k3, sigs: await sigs(k3, ["newroot1"]), ok: false },
    { doc: k3, sigs: await sigs(k3, ["root1", "root2", "newroot1"]), ok: true },
  ] },
  { name: "a host that missed rotations walks the chain in order", pinned: k1, steps: [
    { doc: k2, sigs: await sigs(k2, ["root2", "root3"]), ok: true },
    { doc: k3, sigs: await sigs(k3, ["root1", "root3", "newroot1"]), ok: true },
  ], releaseAfter: [await keyId(pubOf("release2"))] },
  { name: "an invalid threshold is refused", pinned: k1, steps: [{ doc: { ...k2, root: { ...k2.root, threshold: 4 } }, sigs: await sigs({ ...k2, root: { ...k2.root, threshold: 4 } }, ["root1", "root2", "root3"]), ok: false }] },
];
write("keyrings", keyrings);

// ---------- 5. fleet agent decisions (SPEC 12.1-12.3) ----------
const F = (version, layers, extra = {}) => ({ app: "demo.tasks", channel: "stable", epoch: 1, version, layers, order: Object.keys(layers), ...extra });
const fm = async (m, signer = "publisher") => ({ t: "manifest", manifest: m, sig: await sign(m, signer) });
const k1single = ring(1, ["root1"], ["publisher"]);
const k2single = ring(2, ["root1"], ["release2"]);
const fleet = [
  { name: "a host applies its channel's release and reports live", keyring: k1single, id: "host-1", channel: "stable", now: NOW, steps: [
    { msg: await fm(F(1, { main: H.tasks })), state: "live", version: 1 },
    { msg: await fm(F(1, { main: H.tasks })), state: "live", version: 1, note: "same version re-signed: nothing to do" },
  ] },
  { name: "channels are signed: a beta release can't be replayed onto stable", keyring: k1single, id: "host-1", channel: "stable", now: NOW, steps: [
    { msg: await fm(F(1, { main: H.tasks }, { channel: "beta" })), state: "rejected", code: "channel" },
    { msg: await fm((({ channel, ...m }) => m)(F(1, { main: H.tasks }))), state: "rejected", code: "channel" },
    { msg: await fm(F(1, { main: H.tasks }), "attacker"), state: "rejected", code: "untrusted" },
    { msg: await fm({ ...F(1, { main: H.tasks }), app: "other" }), state: "rejected", code: "wrong_app" },
  ] },
  { name: "percentage rollouts: hosts outside the share report skipped", keyring: k1single, id: "host-1", channel: "stable", now: NOW, steps: [
    { msg: await fm(F(1, { main: H.tasks }, { rollout: { percent: 0, seed: "s" } })), state: "skipped", version: 0 },
    { msg: await fm(F(1, { main: H.tasks }, { rollout: { percent: 100, seed: "s" } })), state: "live", version: 1 },
  ] },
  { name: "the epoch limit follows the keyring, and a new keyring revokes the old release key", keyring: k1single, id: "host-1", channel: "stable", now: NOW, steps: [
    { msg: await fm(F(5, { main: H.tasks }, { epoch: 2 })), state: "rejected", code: "bad_version" },
    { msg: await fm(F(5, { main: H.tasks })), state: "live", version: 5 },
    { msg: await fm(F(3, { main: H.tasks })), state: null, note: "older than running: ignored without a report" },
    { msg: { t: "keyring", doc: k2single, sigs: await sigs(k2single, ["root1"]) }, state: "keyring" },
    { msg: await fm(F(6, { main: H.tasks }, { epoch: 2 })), state: "rejected", code: "untrusted", note: "signed by the revoked key" },
    { msg: await fm(F(1, { main: H.tasks_v2 }, { epoch: 2 }), "release2"), state: "live", version: 1 },
  ] },
];
write("fleet", fleet);

console.log(`wrote ${canon.length} canonical, ${crypto_.verify.length + crypto_.sha256.length + crypto_.keyId.length + crypto_.bucket.length} crypto, ${scenarios.length} scenarios (${scenarios.reduce((n, s) => n + s.steps.length, 0)} steps), ${keyrings.length} keyring, ${fleet.length} fleet vectors`);
