// Durable storage for the server host (red-team ST-02), optionally encrypted at rest (PR-03).
// Each tenant keeps, on disk:
//   snapshot.json  { kv, idem, fx, tombs }  (tombs: hashes of erased call ids)        written atomically (tmp + rename)
//   log.jsonl      one line per commit: { set, del, idem, fx }                appended (and fsync'd) before a reply goes out
//   releases.json  { lanes: [[channel, { manifest, sig, pinned: [{manifest, sig}...] }]...] }
//                  the release each channel last committed, plus older releases still served to
//                  clients outside a partial rollout (section 10.5). Older data dirs have current.json
//                  ({ manifest, sig }, the no-channel lane); it is read and replaced.
//   audit.jsonl    one line per privacy operation (export, erase); never holds the data itself
// and blobs are shared, content-addressed, under blobs/<sha256>. On start the host loads the
// snapshot, replays the log (a torn last line from a crash is ignored), re-verifies each stored
// manifest's signature and runs it on the restored state.
//
// With a data key (host/at-rest.mjs), every file above except blobs is AES-256-GCM sealed, each log
// line on its own, and bound to its tenant and file. Blobs stay plain: they are code anyone on the
// stream can fetch, and their hash already proves them. A "keycheck" file in the data dir tells a
// wrong key (refused at start) from damaged data. Starting with a key on a plaintext data dir
// encrypts it; starting with { key: new, previousKeys: [old] } re-encrypts it under the new key.
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync, renameSync, openSync, fsyncSync, closeSync, truncateSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { codec, seal, open, isSealed } from "./at-rest.mjs";

const hashOf = (entry) => createHash("sha256").update(JSON.stringify(entry)).digest("hex");
// Checks an audit log's chain: -> { ok, entries, brokenAt? }
export function verifyAudit(entries) {
  let prev = null;
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].prev !== prev) return { ok: false, count: entries.length, brokenAt: i };
    prev = hashOf(entries[i]);
  }
  return { ok: true, count: entries.length };
}

const tenantDir = (app) => "t-" + Buffer.from(app).toString("base64url"); // safe for any app name
function writeAtomic(file, data, fsync) {
  const tmp = file + ".tmp";
  writeFileSync(tmp, data, { mode: 0o600 });
  if (fsync) { const fd = openSync(tmp, "r+"); fsyncSync(fd); closeSync(fd); }
  renameSync(tmp, file);
}
const KEYCHECK = "llp-data-key-ok";

export class DiskStore {
  // key: 32-byte Buffer (see host/at-rest.mjs dataKeyFrom) or null for plaintext.
  // previousKeys: keys the data may still be sealed with; everything is rewritten under `key` on open.
  constructor(dir, { fsync = true, compactEvery = 1000, idemKeep = 10000, key = null, previousKeys = [] } = {}) {
    Object.assign(this, { dir, fsync, compactEvery, idemKeep });
    mkdirSync(join(dir, "blobs"), { recursive: true });
    mkdirSync(join(dir, "tenants"), { recursive: true });
    this.codec = codec(key, { previous: previousKeys });
    this.migrated = this.checkKey(key, previousKeys);
  }
  get encrypted() { return this.codec.encrypted; }

  // Refuse a wrong key before reading anything; re-seal everything when the key changed or the data
  // was plaintext. Returns what was done: null, "encrypted" or "rekeyed".
  checkKey(key, previous) {
    const f = join(this.dir, "keycheck");
    const has = existsSync(f);
    if (!key) {
      if (has) throw new Error(`${this.dir} is encrypted at rest; start the server host with its data key`);
      return null;
    }
    let action = "encrypted";
    if (has) {
      const s = readFileSync(f, "utf8");
      const ok = (k) => { try { return open(k, "llp/keycheck", s).toString() === KEYCHECK; } catch { return false; } };
      if (ok(key)) return null;
      if (!previous.some(ok)) throw new Error(`${this.dir}: the data key doesn't match this data dir (it was encrypted with another key)`);
      action = "rekeyed";
    }
    // Rewrite every tenant's files under the current key (also turns plaintext into sealed records).
    for (const app of this.apps()) {
      const t = this.tenant(app);
      const s = t.load();
      t.compact(s.kv, s.idem, s.fx, s.tombs);
      const rel = t.releases();
      if (rel.size) t.writeReleases(rel);
      const audit = t.auditEntries();
      if (audit.length) t.rewriteAudit(audit);
    }
    for (const name of ["keyring.json", "device.json"]) {
      const doc = this.readDoc(join("fleet", name), `llp/fleet/${name}`);
      if (doc) this.writeDoc(join("fleet", name), `llp/fleet/${name}`, doc);
    }
    writeAtomic(f, seal(key, "llp/keycheck", KEYCHECK), this.fsync);
    return action;
  }

  apps() {
    const out = [];
    for (const d of readdirSync(join(this.dir, "tenants"))) {
      const f = join(this.dir, "tenants", d, "app.txt");
      if (existsSync(f)) out.push(readFileSync(f, "utf8"));
    }
    return out;
  }
  tenant(app) { return new TenantLog(this, app); }
  hasBlob(h) { return /^[0-9a-f]{64}$/.test(h) && existsSync(join(this.dir, "blobs", h)); }
  getBlob(h) { return new Uint8Array(readFileSync(join(this.dir, "blobs", h))); }
  putBlob(h, bytes) { if (/^[0-9a-f]{64}$/.test(h) && !this.hasBlob(h)) writeAtomic(join(this.dir, "blobs", h), bytes, this.fsync); }

  // A small JSON document under the data dir, sealed when there's a key.
  readDoc(rel, aad) {
    const f = join(this.dir, rel);
    if (!existsSync(f)) return null;
    return JSON.parse(this.codec.decode(aad, readFileSync(f, "utf8")).text);
  }
  writeDoc(rel, aad, doc) {
    const f = join(this.dir, rel);
    mkdirSync(join(f, ".."), { recursive: true });
    writeAtomic(f, this.codec.encode(aad, JSON.stringify(doc)), this.fsync);
  }
}

class TenantLog {
  constructor(store, app) {
    this.store = store; this.app = app;
    this.dir = join(store.dir, "tenants", tenantDir(app));
    mkdirSync(this.dir, { recursive: true });
    if (!existsSync(join(this.dir, "app.txt"))) writeAtomic(join(this.dir, "app.txt"), app, store.fsync);
    this.lines = 0;
  }
  aad(kind) { return `llp/server/${this.app}/${kind}`; }
  read(kind, file) { return JSON.parse(this.store.codec.decode(this.aad(kind), readFileSync(join(this.dir, file), "utf8")).text); }
  write(kind, file, doc) { writeAtomic(join(this.dir, file), this.store.codec.encode(this.aad(kind), JSON.stringify(doc)), this.store.fsync); }

  // -> { kv: Map, idem: Map(key -> result), fx: Map(callId -> record) }
  load() {
    const kv = new Map(), idem = new Map(), fx = new Map(), tombs = new Set();
    this.lines = 0;
    if (existsSync(join(this.dir, "snapshot.json"))) {
      const s = this.read("snapshot", "snapshot.json");
      for (const [k, v] of s.kv) kv.set(k, v);
      for (const [k, r] of s.idem) idem.set(k, r);
      for (const [k, r] of s.fx ?? []) fx.set(k, r);
      for (const k of s.tombs ?? []) tombs.add(k);
    }
    const log = join(this.dir, "log.jsonl");
    if (existsSync(log)) {
      const text = readFileSync(log, "utf8"), rows = text.split("\n");
      for (let i = 0; i < rows.length; i++) {
        if (!rows[i]) continue;
        let e;
        try { e = JSON.parse(this.store.codec.decode(this.aad("log"), rows[i]).text); } catch (err) {
          // Only the last line may be torn by a crash; a bad line in the middle is damage (or a wrong
          // key, which the keycheck has already ruled out), so stop rather than lose later commits.
          if (i !== rows.length - 1) throw new Error(`${this.app}: corrupt log line ${i + 1} (${err.message})`);
          truncateSync(log, Buffer.byteLength(rows.slice(0, i).join("\n") + (i ? "\n" : ""))); // drop the torn tail so later appends start on a clean line
          break;
        }
        for (const [k, v] of e.set ?? []) kv.set(k, v);
        for (const k of e.del ?? []) kv.delete(k);
        for (const [k, r] of e.idem ?? []) idem.set(k, r);
        for (const [k, r] of e.fx ?? []) fx.set(k, r);
        this.lines++;
      }
    }
    while (idem.size > this.store.idemKeep) idem.delete(idem.keys().next().value);
    while (fx.size > this.store.idemKeep) fx.delete(fx.keys().next().value);
    return { kv, idem, fx, tombs };
  }
  // One commit: state changes plus the idempotency records of the calls they answer, in one line,
  // so a reply is never sent for a call whose effects or record could be lost.
  append(entry) {
    if (!entry.set?.length && !entry.del?.length && !entry.idem?.length && !entry.fx?.length) return;
    const file = join(this.dir, "log.jsonl");
    const fd = openSync(file, "a", 0o600);
    try { appendFileSync(fd, this.store.codec.encode(this.aad("log"), JSON.stringify(entry)) + "\n"); if (this.store.fsync) fsyncSync(fd); } finally { closeSync(fd); }
    this.lines++;
  }
  needsCompaction() { return this.lines >= this.store.compactEvery; }
  // Replace the log with one snapshot. Also how an erase leaves no old value behind in the log.
  compact(kv, idem, fx = new Map(), tombs = new Set()) {
    this.write("snapshot", "snapshot.json", { kv: [...kv], idem: [...idem], fx: [...fx], tombs: [...tombs] });
    const log = join(this.dir, "log.jsonl");
    if (existsSync(log)) { truncateSync(log, 0); if (this.store.fsync) { const fd = openSync(log, "r+"); fsyncSync(fd); closeSync(fd); } }
    this.lines = 0;
  }

  // ---------- releases, one lane per channel (null = manifests without a channel) ----------
  // -> Map(channel -> { manifest, sig, pinned: [{manifest, sig}] })
  releases() {
    const out = new Map();
    if (existsSync(join(this.dir, "releases.json"))) {
      for (const [ch, r] of this.read("releases", "releases.json").lanes) out.set(ch, { pinned: [], ...r });
    } else if (existsSync(join(this.dir, "current.json"))) {
      const raw = readFileSync(join(this.dir, "current.json"), "utf8");
      const cur = JSON.parse(this.store.codec.decode(this.aad("current"), raw).text);
      out.set(cur.manifest.channel ?? null, { ...cur, pinned: [] });
    }
    return out;
  }
  writeReleases(map) {
    this.write("releases", "releases.json", { lanes: [...map] });
    const old = join(this.dir, "current.json");
    if (existsSync(old)) unlinkSync(old);
  }
  // Kept for callers of the single-lane API.
  current() { return this.releases().get(null) ?? [...this.releases().values()][0] ?? null; }

  // ---------- audit log (privacy operations) ----------
  // Each entry carries the SHA-256 of the one before it, so a removed or edited line shows.
  audit(entry) {
    if (this.lastAudit === undefined) { const all = this.auditEntries(); this.lastAudit = all.length ? hashOf(all[all.length - 1]) : null; }
    entry = { ...entry, prev: this.lastAudit };
    this.lastAudit = hashOf(entry);
    const fd = openSync(join(this.dir, "audit.jsonl"), "a", 0o600);
    try { appendFileSync(fd, this.store.codec.encode(this.aad("audit"), JSON.stringify(entry)) + "\n"); if (this.store.fsync) fsyncSync(fd); } finally { closeSync(fd); }
  }
  auditEntries() {
    const f = join(this.dir, "audit.jsonl");
    if (!existsSync(f)) return [];
    const out = [];
    for (const row of readFileSync(f, "utf8").split("\n")) {
      if (!row) continue;
      try { out.push(JSON.parse(this.store.codec.decode(this.aad("audit"), row).text)); } catch { /* a torn last line */ }
    }
    return out;
  }
  rewriteAudit(entries) { writeAtomic(join(this.dir, "audit.jsonl"), entries.map((e) => this.store.codec.encode(this.aad("audit"), JSON.stringify(e)) + "\n").join(""), this.store.fsync); }
}

export { isSealed };
