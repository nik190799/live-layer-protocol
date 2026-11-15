// Runs the LLP conformance vectors against the JavaScript reference host.
//   node conformance/run-js.mjs            check
//   node conformance/run-js.mjs --record   also fill "recorded" placeholders from this host's output
// The Go host runs the same vectors: cd impl/go && go run ./cmd/llp-conformance ../../conformance
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { LiveHost, canonical, sha256, b64 } from "../host/llp-core.js";
import { TrustStore, FleetAgent, keyId, bucketOf, verifyDoc } from "../host/fleet.js";

const dir = new URL(".", import.meta.url);
const record = process.argv.includes("--record");
const only = (() => { const i = process.argv.indexOf("--only"); return i > 0 ? process.argv[i + 1] : null; })();
const load = (n) => JSON.parse(readFileSync(new URL(`vectors/${n}.json`, dir), "utf8"));
const keys = JSON.parse(readFileSync(new URL("keys.json", dir), "utf8"));
const build = new URL("../build/", dir);
const files = {};
for (const f of readdirSync(build)) if (f.endsWith(".wasm")) files[await sha256(readFileSync(new URL(f, build)))] = f;
const blobOf = (f) => new Uint8Array(readFileSync(new URL(f, build)));

let pass = 0, fail = 0;
const failures = [];
const check = (name, ok, detail = "") => { if (ok) pass++; else { fail++; failures.push(name); } if (!ok || process.argv.includes("-v")) console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail && !ok ? "  — " + detail : ""}`); };
const eq = (a, b) => canonical(a) === canonical(b);
const realNow = Date.now;

// ---------- canonical ----------
for (const v of load("canonical")) {
  let got, err = null;
  try { got = canonical(JSON.parse(v.json)); } catch (e) { err = e.message; }
  if (v.error) check(`canonical: ${v.name}`, err !== null, `got ${got}`);
  else check(`canonical: ${v.name}`, got === v.canonical, `got ${got ?? err}`);
}

// ---------- crypto ----------
const cr = load("crypto");
for (const v of cr.sha256) {
  const bytes = v.file ? blobOf(v.file) : Uint8Array.from((v.hex.match(/../g) ?? []).map((x) => parseInt(x, 16)));
  check(`sha256: ${v.name}`, (await sha256(bytes)) === v.sha256);
}
for (const v of cr.keyId) check(`keyId: ${v.name}`, (await keyId(v.jwk)) === v.kid);
for (const v of cr.verify) {
  const doc = v.docJson ? JSON.parse(v.docJson) : v.doc;
  check(`verify: ${v.name}`, (await verifyDoc(doc, v.sig, v.jwk)) === v.valid);
}
for (const v of cr.bucket) check(`bucket: ${JSON.stringify(v.host)} / ${v.seed}`, (await bucketOf(v.host, v.seed)) === v.bucket);

// ---------- scenarios ----------
const textOf = (n) => !n ? [] : n.k === "text" ? [n.t] : (n.c ?? []).flatMap(textOf);
const scenarios = load("scenarios");
let recorded = false;
for (const sc of scenarios) {
  if (only && !sc.name.includes(only)) continue;
  const cfg = sc.host;
  Date.now = () => cfg.now;
  const calls = [];
  const capabilities = {};
  for (const [name, c] of Object.entries(cfg.caps ?? {})) capabilities[name] = async (arg) => { calls.push([name, arg]); if (c.error) throw new Error(c.error); return c.none ? undefined : c.result; };
  let last = [];
  const host = new LiveHost({ app: cfg.app ?? null, trustedKeys: (cfg.keys ?? []).map((k) => keys[k].public), allowUnsigned: !!cfg.allowUnsigned, capabilities, onRender: (v) => { last = v; } });
  host.maxEpoch = cfg.maxEpoch ?? 0;
  const settle = async () => { for (let i = 0; i < 6; i++) { await new Promise((r) => setTimeout(r, 3)); await host.queue; } };
  for (const [i, st] of sc.steps.entries()) {
    const label = `scenario: ${sc.name} [step ${i + 1} ${st.op}]`;
    if (st.op === "apply") {
      const m = st.manifestJson ? JSON.parse(st.manifestJson) : st.manifest;
      const fetched = [];
      const r = await host.apply(m, st.sig, async (h) => { fetched.push(h); const f = st.serve?.[h] ?? files[h]; return f ? blobOf(f) : null; });
      await settle();
      const e = st.expect;
      let ok = r.ok === e.ok && (e.code === undefined || r.code === e.code);
      if (e.swapped) ok &&= eq([...r.swapped].sort(), [...e.swapped].sort());
      if (e.fetched) ok &&= eq([...fetched].sort(), [...e.fetched].sort());
      check(label, ok, `got ${JSON.stringify({ ok: r.ok, code: r.code, reason: r.reason, swapped: r.swapped, fetched: fetched.map((h) => h.slice(0, 8)) })}`);
    } else if (st.op === "bind") { host.setBound(st.key, st.value); }
    else if (st.op === "event") { await host.dispatch(st.slot, st.id, st.value ?? ""); await settle(); }
    else if (st.op === "expect") {
      const bad = [];
      for (const [k, v] of Object.entries(st.state ?? {})) if (v === null ? host.kv.has(k) : !eq(host.kv.get(k), v)) bad.push(`state ${k}=${JSON.stringify(host.kv.get(k))} want ${JSON.stringify(v)}`);
      const run = host.running();
      for (const [k, v] of Object.entries(st.running ?? {})) if ((run[k] ?? null) !== v) bad.push(`running ${k}=${run[k]?.slice(0, 8)} want ${v?.slice(0, 8)}`);
      if (st.version !== undefined && host.version !== st.version) bad.push(`version ${host.version} want ${st.version}`);
      if (st.epoch !== undefined && host.epoch !== st.epoch) bad.push(`epoch ${host.epoch} want ${st.epoch}`);
      if (st.rollbacks !== undefined) { const n = host.history.filter((h) => h.kind === "rollback").length; if (n !== st.rollbacks) bad.push(`rollbacks ${n} want ${st.rollbacks}`); }
      if (st.renders) { const got = last.map((v) => v.slot); if (!eq(got, st.renders)) bad.push(`renders ${got} want ${st.renders}`); }
      if (st.capsCalled) if (!eq(calls, st.capsCalled)) bad.push(`caps ${JSON.stringify(calls)} want ${JSON.stringify(st.capsCalled)}`);
      for (const [field, pick] of [["text", (v) => v.error ? { error: true } : textOf(v.tree).join("|")], ["views", (v) => v.error ? { error: true } : v.tree]]) {
        for (const [slot, want] of Object.entries(st[field] ?? {})) {
          const v = last.find((x) => x.slot === slot);
          const got = v ? pick(v) : null;
          if (want === "recorded" || st.recorded?.includes(`${field}.${slot}`)) {
            if (record) { st[field][slot] = got; st.recorded = [...new Set([...(st.recorded ?? []), `${field}.${slot}`])]; recorded = true; continue; }
            if (want === "recorded") { bad.push(`${field}.${slot} not recorded yet (run with --record)`); continue; }
          }
          if (!eq(got, want)) bad.push(`${field}.${slot}=${JSON.stringify(got)} want ${JSON.stringify(want)}`);
        }
      }
      check(label, bad.length === 0, bad.join("; "));
    }
  }
  host.close();
  Date.now = realNow;
}
if (record && recorded) writeFileSync(new URL("vectors/scenarios.json", dir), JSON.stringify(scenarios, null, 1) + "\n");

// ---------- keyrings ----------
for (const v of load("keyrings")) {
  const t = new TrustStore(v.pinned);
  let ok = true, why = [];
  for (const [i, st] of v.steps.entries()) { const r = await t.update(st.doc, st.sigs); if (r.ok !== st.ok) { ok = false; why.push(`step ${i + 1}: ok=${r.ok} (${r.reason})`); } }
  if (v.releaseAfter) { const got = []; for (const k of t.releaseKeys()) got.push(await keyId(k)); if (!eq(got, v.releaseAfter)) { ok = false; why.push(`release keys ${got}`); } }
  check(`keyring: ${v.name}`, ok, why.join("; "));
}

// ---------- fleet ----------
for (const v of load("fleet")) {
  Date.now = () => v.now;
  const host = new LiveHost({});
  const trust = new TrustStore(v.keyring);
  let agent;
  const sent = [];
  agent = new FleetAgent({ host, id: v.id, channel: v.channel, trust, send: (m) => {
    sent.push(m);
    if (m.t === "want") for (const h of m.hashes) queueMicrotask(() => agent.receive({ t: "blob", hash: h, data: files[h] ? b64.enc(blobOf(files[h])) : "" }));
  } });
  for (const [i, st] of v.steps.entries()) {
    const before = sent.length;
    await agent.receive(st.msg);
    const reports = sent.slice(before).filter((m) => m.t === "status");
    const r = reports.at(-1) ?? null;
    let ok = st.state === null ? reports.length === 0 : r?.state === st.state;
    if (ok && st.code) ok = r.code === st.code;
    if (ok && st.version !== undefined) ok = host.version === st.version;
    check(`fleet: ${v.name} [step ${i + 1}]`, ok, `got ${JSON.stringify(r && { state: r.state, code: r.code, reason: r.reason })} version ${host.version}`);
  }
  host.close();
  Date.now = realNow;
}

console.log(`\nJS reference host: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
