// Durable storage for the server host (red-team ST-02). Each tenant keeps, on disk:
//   snapshot.json  { kv: [[k, v]...], idem: [[key, result]...] }   written atomically (tmp + rename)
//   log.jsonl      one line per commit: { set, del, idem }          appended (and fsync'd) before a reply goes out
//   current.json   { manifest, sig }                                the last version this tenant committed
// and blobs are shared, content-addressed, under blobs/<sha256>. On start the host loads the
// snapshot, replays the log (a torn last line from a crash is ignored), re-verifies the stored
// manifest's signature and runs it on the restored state.
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync, renameSync, openSync, fsyncSync, closeSync, truncateSync } from "node:fs";
import { join } from "node:path";

const tenantDir = (app) => "t-" + Buffer.from(app).toString("base64url"); // safe for any app name
function writeAtomic(file, data, fsync) {
  const tmp = file + ".tmp";
  writeFileSync(tmp, data);
  if (fsync) { const fd = openSync(tmp, "r+"); fsyncSync(fd); closeSync(fd); }
  renameSync(tmp, file);
}

export class DiskStore {
  constructor(dir, { fsync = true, compactEvery = 1000, idemKeep = 10000 } = {}) {
    Object.assign(this, { dir, fsync, compactEvery, idemKeep });
    mkdirSync(join(dir, "blobs"), { recursive: true });
    mkdirSync(join(dir, "tenants"), { recursive: true });
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
}

class TenantLog {
  constructor(store, app) {
    this.store = store; this.app = app;
    this.dir = join(store.dir, "tenants", tenantDir(app));
    mkdirSync(this.dir, { recursive: true });
    if (!existsSync(join(this.dir, "app.txt"))) writeAtomic(join(this.dir, "app.txt"), app, store.fsync);
    this.lines = 0;
  }
  // -> { kv: Map, idem: Map(key -> result) }
  load() {
    const kv = new Map(), idem = new Map(), fx = new Map();
    const snap = join(this.dir, "snapshot.json");
    if (existsSync(snap)) {
      const s = JSON.parse(readFileSync(snap, "utf8"));
      for (const [k, v] of s.kv) kv.set(k, v);
      for (const [k, r] of s.idem) idem.set(k, r);
      for (const [k, r] of s.fx ?? []) fx.set(k, r);
    }
    const log = join(this.dir, "log.jsonl");
    if (existsSync(log)) {
      const text = readFileSync(log, "utf8"), rows = text.split("\n");
      for (let i = 0; i < rows.length; i++) {
        if (!rows[i]) continue;
        let e;
        try { e = JSON.parse(rows[i]); } catch {
          if (i !== rows.length - 1) throw new Error(`${this.app}: corrupt log line ${i + 1}`);
          truncateSync(log, Buffer.byteLength(text.split("\n").slice(0, i).join("\n") + (i ? "\n" : ""))); // drop the torn tail so later appends start on a clean line
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
    return { kv, idem, fx };
  }
  // One commit: state changes plus the idempotency records of the calls they answer, in one line,
  // so a reply is never sent for a call whose effects or record could be lost.
  append(entry) {
    if (!entry.set?.length && !entry.del?.length && !entry.idem?.length && !entry.fx?.length) return;
    const file = join(this.dir, "log.jsonl");
    const fd = openSync(file, "a");
    try { appendFileSync(fd, JSON.stringify(entry) + "\n"); if (this.store.fsync) fsyncSync(fd); } finally { closeSync(fd); }
    this.lines++;
  }
  needsCompaction() { return this.lines >= this.store.compactEvery; }
  compact(kv, idem, fx = new Map()) {
    writeAtomic(join(this.dir, "snapshot.json"), JSON.stringify({ kv: [...kv], idem: [...idem], fx: [...fx] }), this.store.fsync);
    const log = join(this.dir, "log.jsonl");
    if (existsSync(log)) truncateSync(log, 0);
    this.lines = 0;
  }
  current() { const f = join(this.dir, "current.json"); return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null; }
  setCurrent(manifest, sig) { writeAtomic(join(this.dir, "current.json"), JSON.stringify({ manifest, sig }), this.store.fsync); }
}
