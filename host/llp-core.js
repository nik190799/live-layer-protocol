// Live Layer Protocol (LLP) v0 — host core.
// Runs unchanged in browsers and in Node: only WebAssembly, WebCrypto, TextEncoder/Decoder.

const te = new TextEncoder();
const td = new TextDecoder();

export const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
export async function sha256(bytes) { return hex(await crypto.subtle.digest("SHA-256", bytes)); }

// Canonical JSON: sorted keys, no whitespace — what gets signed.
export function canonical(v) {
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (v && typeof v === "object") return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";
  return JSON.stringify(v);
}
export const b64 = {
  enc: (bytes) => { let s = ""; const u = new Uint8Array(bytes); for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return btoa(s); },
  dec: (str) => { const s = atob(str); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; },
};

const ECDSA = { name: "ECDSA", namedCurve: "P-256" };
const SIG = { name: "ECDSA", hash: "SHA-256" };
export async function generatePublisherKey() {
  const kp = await crypto.subtle.generateKey(ECDSA, true, ["sign", "verify"]);
  return { privateKey: kp.privateKey, publicJwk: await crypto.subtle.exportKey("jwk", kp.publicKey) };
}
export async function signManifest(manifest, privateKey) {
  const sig = await crypto.subtle.sign(SIG, privateKey, te.encode(canonical(manifest)));
  return b64.enc(sig);
}
async function verifyManifest(manifest, sig, jwk) {
  const key = await crypto.subtle.importKey("jwk", jwk, ECDSA, false, ["verify"]);
  return crypto.subtle.verify(SIG, key, b64.dec(sig), te.encode(canonical(manifest)));
}

export class LayerError extends Error {}

// ---------- host state ----------
// A Map with a change log. Each layer worker holds a replica of the store; the log lets the host send
// a worker only the keys that changed since its last call instead of copying the whole store per call
// (which cost 157 ms per event at 100k keys and broke the 100 ms call limit at 1M keys).
const LOG_MAX = 65536;
let storeSeq = 0;
export class Store {
  constructor(init) { this.map = new Map(init ?? []); this.log = []; this.base = 0; this.id = ++storeSeq; this.onChange = null; }
  get rev() { return this.base + this.log.length; }
  get size() { return this.map.size; }
  get(k) { return this.map.get(k); }
  has(k) { return this.map.has(k); }
  keys() { return this.map.keys(); }
  values() { return this.map.values(); }
  entries() { return this.map.entries(); }
  forEach(f) { this.map.forEach(f); }
  [Symbol.iterator]() { return this.map[Symbol.iterator](); }
  set(k, v) { this.map.set(k, v); this.note(k); return this; }
  delete(k) { const had = this.map.delete(k); if (had) this.note(k); return had; }
  note(k) {
    this.log.push(k);
    if (this.log.length > LOG_MAX) { const drop = this.log.length - (LOG_MAX >> 1); this.log.splice(0, drop); this.base += drop; }
    this.onChange?.(k);
  }
  // Keys changed after `rev`, or null when the log no longer reaches back that far.
  since(rev) { return rev < this.base ? null : [...new Set(this.log.slice(rev - this.base))]; }
  snapshot() { return this.map; }
  fork() { return new Overlay(this); }
}
// Copy-on-write view used to stage a swap: writes stay here until commit(), so staging costs
// O(keys written), not O(store size).
const GONE = Symbol("deleted");
class Overlay {
  constructor(parent) { this.parent = parent; this.writes = new Map(); this.log = []; this.base = 0; this.id = ++storeSeq; }
  get rev() { return this.log.length; }
  get(k) { if (this.writes.has(k)) { const v = this.writes.get(k); return v === GONE ? undefined : v; } return this.parent.get(k); }
  has(k) { return this.writes.has(k) ? this.writes.get(k) !== GONE : this.parent.has(k); }
  set(k, v) { this.writes.set(k, v); this.log.push(k); return this; }
  delete(k) { const had = this.has(k); this.writes.set(k, GONE); this.log.push(k); return had; }
  since(rev) { return [...new Set(this.log.slice(rev))]; }
  snapshot() { const m = new Map(this.parent.snapshot()); for (const [k, v] of this.writes) v === GONE ? m.delete(k) : m.set(k, v); return m; }
  *[Symbol.iterator]() { for (const [k, v] of this.snapshot()) yield [k, v]; }
  // Replays the writes onto the parent in order, so parent.rev advances by exactly this.rev.
  commit() { const before = this.parent.rev; for (const k of this.log) { const v = this.writes.get(k); v === GONE ? this.parent.delete(k) || this.parent.note(k) : this.parent.set(k, v); } return before; }
}

// ---------- sandbox limits ----------
// Every layer runs in its own worker (Web Worker in browsers, worker_threads in Node), never on the
// host's thread. A call that runs past its time limit gets its worker killed, and the host treats
// that like a trap: the call's state changes are dropped and the slot is reverted.
export const DEFAULT_LIMITS = {
  callMs: 100,     // wall-clock budget for one llp_view / llp_event / llp_migrate call
  loadMs: 2000,    // budget for compile + instantiate (+ start function) + llp_schema
  memoryMb: 32,    // cap on the layer's linear memory, written into the module's memory limits
  uiNodes: 10000,  // cap on UI nodes one call may emit (bounds the worker's JS heap in every engine)
  heapMb: 64,      // worker JS heap cap (Node only; browsers have no per-worker heap limit)
};

// Rewrite the module's own memory declaration so memory.grow fails past the cap. The engine
// enforces it, so a runaway allocation traps inside the layer instead of eating host memory.
const PAGE = 65536;
function readU32(b, o) { let r = 0, sh = 0, x; do { x = b[o++]; r |= (x & 0x7f) << sh; sh += 7; } while (x & 0x80); return [r >>> 0, o]; }
function u32(n) { const out = []; do { let x = n & 0x7f; n >>>= 7; if (n) x |= 0x80; out.push(x); } while (n); return out; }
export function capMemory(bytes, maxPages) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length < 8 || b[0] !== 0 || b[1] !== 0x61 || b[2] !== 0x73 || b[3] !== 0x6d) throw new LayerError("not a wasm module");
  let o = 8;
  while (o < b.length) {
    const id = b[o];
    const [size, body] = readU32(b, o + 1);
    if (id === 5) {
      let [count, p] = readU32(b, body);
      const mems = [];
      for (let i = 0; i < count; i++) {
        const flags = b[p++];
        if (flags & 0x04) throw new LayerError("64-bit memory is not supported");
        let min, max = Infinity; [min, p] = readU32(b, p);
        if (flags & 0x01) [max, p] = readU32(b, p);
        if (min > maxPages) throw new LayerError(`layer asks for ${Math.round(min * PAGE / 2 ** 20)} MB of memory at start; limit is ${Math.round(maxPages * PAGE / 2 ** 20)} MB`);
        mems.push([(flags & 0x02) | 0x01, ...u32(min), ...u32(Math.min(max, maxPages))]);
      }
      const content = [...u32(count), ...mems.flat()];
      const out = new Uint8Array(b.length - (body + size - o) + 1 + u32(content.length).length + content.length);
      out.set(b.subarray(0, o), 0);
      let w = o; out[w++] = 5;
      for (const x of u32(content.length)) out[w++] = x;
      out.set(content, w); w += content.length;
      out.set(b.subarray(body + size), w);
      return out;
    }
    o = body + size;
  }
  return b; // no memory defined here: instantiation fails later ("layer must export memory")
}

// ---------- the worker: owns one layer instance and the guest ABI ----------
// Self-contained (it's stringified into the worker), so it must not use anything from this file.
function llpWorker(post, onMessage) {
  const te = new TextEncoder(), td = new TextDecoder();
  class LayerError extends Error {}
  let ex = null, mem = null, ctx = null, maxNodes = 10000, memCap = Infinity, logs = [];
  // The worker keeps its own replica of host state. The host sends only the keys that changed since
  // this worker's last call, so a call costs the same with 10 keys or a million.
  let replica = new Map();
  const sync = (s) => { if (!s) return; if (s.full) replica = s.full; for (const [k, v] of s.set ?? []) replica.set(k, v); for (const k of s.del ?? []) replica.delete(k); };
  const bytes = (p, l) => new Uint8Array(mem.buffer, p, l);
  const str = (p, l) => td.decode(bytes(p, l));
  const put = (s, p, cap) => { const b = te.encode(s); bytes(p, Math.min(b.length, cap)).set(b.subarray(0, cap)); return b.length; };
  const c = () => { if (!ctx) throw new LayerError("host call outside a host-initiated call"); return ctx; };
  const node = (n) => { const x = c(); if (++x.nodes > maxNodes) throw new LayerError(`UI exceeded ${maxNodes} nodes`); x.stack[x.stack.length - 1].c.push(n); return n; };
  const write = (k, v) => { c().writes.set(k, v); };
  const read = (k) => { const x = c(); return x.writes.has(k) ? x.writes.get(k) : replica.get(k); };
  const llp = {
    ui_begin: (p, l) => c().stack.push(node({ k: str(p, l), a: {}, c: [] })),
    ui_attr: (kp, kl, vp, vl) => { const s = c().stack; s[s.length - 1].a[str(kp, kl)] = str(vp, vl); },
    ui_text: (p, l) => { node({ k: "text", t: str(p, l) }); },
    ui_end: () => { const s = c().stack; if (s.length <= 1) throw new LayerError("ui_end without ui_begin"); s.pop(); },
    kv_get_n: (kp, kl, def) => { const v = read(str(kp, kl)); return typeof v === "number" ? v : def; },
    kv_set_n: (kp, kl, v) => write(str(kp, kl), v),
    kv_get_s: (kp, kl, bp, cap) => { const v = read(str(kp, kl)); return put(v == null ? "" : String(v), bp, cap); },
    kv_set_s: (kp, kl, vp, vl) => write(str(kp, kl), str(vp, vl)),
    ev_id: (bp, cap) => put(c().event?.id ?? "", bp, cap),
    ev_val: (bp, cap) => put(c().event?.value ?? "", bp, cap),
    cap: (np, nl, ap, al) => { const x = c(); x.effects.push({ name: str(np, nl), arg: str(ap, al) }); return x.effects.length; },
    log: (p, l) => { if (logs.length < 100) logs.push(str(p, l)); },
    now: () => Date.now(),
  };
  const env = { abort: () => { throw new LayerError("layer aborted"); }, seed: () => Math.random() * 2 ** 32 };
  onMessage(async ({ id, op, ...m }) => {
    logs = [];
    try {
      if (op === "load") {
        maxNodes = m.maxNodes; memCap = m.memCap;
        const { instance } = await WebAssembly.instantiate(m.bytes, { llp, env });
        ex = instance.exports;
        if (!(ex.memory instanceof WebAssembly.Memory)) throw new LayerError("layer must export memory");
        if (!m.headless && typeof ex.llp_view !== "function") throw new LayerError("layer must export llp_view");
        mem = ex.memory;
        post({ id, ok: true, schema: ex.llp_schema ? ex.llp_schema() : 0, hasMigrate: typeof ex.llp_migrate === "function", hasView: typeof ex.llp_view === "function", logs });
      } else if (op === "sync") {
        sync(m.sync);
        post({ id, ok: true, size: replica.size });
      } else if (op === "call") {
        sync(m.sync);
        const root = { k: "root", a: {}, c: [] };
        ctx = { stack: [root], event: m.event, effects: [], writes: new Map(), nodes: 0 };
        try {
          ex[m.fn]?.(...m.args);
          if (ctx.stack.length !== 1) throw new LayerError(`unbalanced UI in ${m.fn}`);
          post({ id, ok: true, tree: root.c.length === 1 ? root.c[0] : root, effects: ctx.effects, writes: [...ctx.writes], logs });
        } finally { ctx = null; }
      }
    } catch (e) {
      let error = e?.message ?? String(e);
      const used = mem ? mem.buffer.byteLength : 0; // memory.grow can't be hooked, so report when a trap happens near the cap
      if (used >= memCap * 0.9) error += ` (layer memory at ${Math.round(used / 2 ** 20)} of ${Math.round(memCap / 2 ** 20)} MB limit)`;
      post({ id, ok: false, error, logs });
    }
  });
  post({ ready: true });
}
const WORKER_SRC = `(${llpWorker})(
  typeof self !== "undefined" && typeof self.postMessage === "function" ? (m) => self.postMessage(m) : (m) => require("node:worker_threads").parentPort.postMessage(m),
  typeof self !== "undefined" && typeof self.postMessage === "function" ? (f) => { self.onmessage = (e) => f(e.data); } : (f) => require("node:worker_threads").parentPort.on("message", f));`;

// Last resort for pages whose security policy forbids workers: same code and messages, but on the
// page's own thread, so time limits can't preempt it. The host logs loudly when this happens.
function inlineWorker() {
  let onMsg = () => {}, handler = () => {};
  llpWorker((m) => onMsg(m), (f) => { handler = f; });
  return { inline: true, post: (m) => queueMicrotask(() => handler(structuredClone(m))), listen: (f) => { onMsg = f; }, kill: () => { handler = () => {}; onMsg = () => {}; } };
}

let browserUrl = null, workersBlocked = false;
async function spawnWorker(limits) {
  if (typeof globalThis.Worker === "function") { // browsers, Deno, Bun
    if (workersBlocked) return inlineWorker();
    let w;
    try {
      browserUrl ??= URL.createObjectURL(new Blob([WORKER_SRC], { type: "text/javascript" }));
      w = new Worker(browserUrl);
    } catch { workersBlocked = true; return inlineWorker(); }
    // A security policy can also block the worker after construction; it then fails without ever saying ready.
    const started = await new Promise((res) => {
      const t = setTimeout(() => res(false), 5000);
      w.onmessage = (e) => { clearTimeout(t); res(e.data?.ready === true); };
      w.onerror = (e) => { e.preventDefault?.(); clearTimeout(t); res(false); };
    });
    if (!started) { w.terminate(); workersBlocked = true; return inlineWorker(); }
    return {
      post: (m) => w.postMessage(m),
      listen: (onMsg, onDie) => { w.onmessage = (e) => onMsg(e.data); w.onerror = (e) => { e.preventDefault?.(); onDie(e.message || "worker crashed"); }; },
      kill: () => w.terminate(),
    };
  }
  const { Worker: NodeWorker } = await import("node:worker_threads");
  const w = new NodeWorker(WORKER_SRC, { eval: true, resourceLimits: { maxOldGenerationSizeMb: limits.heapMb, maxYoungGenerationSizeMb: Math.max(4, limits.heapMb >> 3) } });
  w.unref(); // an idle layer must not keep the process alive; the call timer does while a call is in flight
  return {
    post: (m) => w.postMessage(m),
    listen: (onMsg, onDie) => {
      w.on("message", onMsg); w.on("error", (e) => onDie(e.code === "ERR_WORKER_OUT_OF_MEMORY" ? "worker ran out of memory" : e.message)); w.on("exit", () => onDie("worker exited"));
      w.unref(); // adding a message listener re-refs the worker
    },
    kill: () => w.terminate(),
  };
}

// Host-side handle on one layer's worker. One request at a time; a request that overruns kills it.
class Sandbox {
  constructor(w) {
    this.w = w; this.dead = null; this.pending = null; this.seq = 0;
    w.listen((m) => { const p = this.pending; if (p && m.id === p.id) { this.pending = null; clearTimeout(p.timer); p.resolve(m); } },
             (why) => this.die(why));
  }
  die(why) {
    if (this.dead) return;
    this.dead = why; this.w.kill();
    const p = this.pending; this.pending = null;
    if (p) { clearTimeout(p.timer); p.reject(new LayerError(why)); }
  }
  kill() { this.die("killed by host"); }
  request(msg, ms, transfer) {
    if (this.dead) return Promise.reject(new LayerError(`layer is dead (${this.dead})`));
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const timer = setTimeout(() => this.die(`ran past its ${ms} ms time limit; worker killed`), ms);
      this.pending = { id, resolve, reject, timer };
      this.w.post({ id, ...msg }, transfer);
    }).then((r) => { if (!r.ok) throw Object.assign(new LayerError(r.error), { logs: r.logs }); return r; });
  }
}

const PLACES = new Set(["client", "server", "any"]);
export const placement = (manifest, slot) => manifest.hosts?.[slot] ?? "client";

export class LiveHost {
  // role: "client" (default: UI, local state, device capabilities) or "server" (headless; runs the
  // slots a manifest places on "server"; owns keys under shared/). See SPEC section 10.
  constructor({ trustedKeys = [], capabilities = {}, onRender = () => {}, onLog = () => {}, maxPrev = 5, limits = {}, role = "client" } = {}) {
    this.trustedKeys = trustedKeys;      // publisher public keys (JWK)
    this.capabilities = capabilities;    // name -> async (arg, ctx) => string result
    this.onRender = onRender;
    this.onLog = onLog;
    this.maxPrev = maxPrev;
    this.role = role;
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.kv = new Store();               // host-owned state: survives every swap
    this.blobs = new Map();              // content-addressed store: hash -> bytes
    this.slots = new Map();              // slot -> { hash, box, prev: [hash...] }
    this.version = 0;
    this.app = null;
    this.manifest = null;
    this.history = [];
    this.spare = null;                   // a pre-spawned worker, so a swap doesn't wait for worker boot
    this.queue = Promise.resolve();      // apply / render / dispatch run one at a time, as they did when synchronous
  }

  // Code outside the host may assign a plain Map (e.g. state restored from disk); keep it a Store.
  get kv() { return this._kv; }
  set kv(m) { this._kv = m instanceof Store ? m : new Store(m); }

  get headless() { return this.role === "server"; }
  placedHere(manifest, slot) { const p = placement(manifest, slot); return p === this.role || p === "any"; }

  log(kind, msg, extra = {}) { const e = { t: Date.now(), kind, msg, ...extra }; this.history.push(e); if (this.history.length > 5000) this.history.splice(0, 1000); this.onLog(e); }
  exclusive(fn) {
    this.pending = (this.pending ?? 0) + 1;
    const r = this.queue.then(fn).finally(() => { this.pending--; });
    this.queue = r.catch(() => {});
    return r;
  }

  // ---------- layer instances (each in its own worker) ----------
  async load(slot, hash) {
    const w = await (this.spare ?? spawnWorker(this.limits));
    this.spare = null;
    if (!this.headless) { this.spare = spawnWorker(this.limits); this.spare.catch(() => {}); } // a server with many tenants can't keep a spare worker per tenant
    const box = new Sandbox(w);
    if (w.inline && !this.warnedInline) { this.warnedInline = true; this.log("error", "this page blocks workers, so layers run on the page's thread and a layer stuck in a loop can freeze it"); }
    try {
      const pages = Math.floor(this.limits.memoryMb * 2 ** 20 / PAGE);
      const bytes = capMemory(this.blobs.get(hash), pages);
      const r = await box.request({ op: "load", bytes, maxNodes: this.limits.uiNodes, memCap: pages * PAGE, headless: this.headless }, this.limits.loadMs);
      this.flushLogs(slot, r.logs);
      box.schema = r.schema; box.hasMigrate = r.hasMigrate; box.hasView = r.hasView;
      return box;
    } catch (e) { box.kill(); this.flushLogs(slot, e.logs); throw e; }
  }

  // Bring a worker's replica of `kv` up to date: the changed keys ride along with the call, and only
  // a worker that has never seen this store (or fell behind the change log) gets a full copy.
  async syncFor(box, kv) {
    const keys = box.src === kv ? kv.since(box.rev) : null;
    if (keys) {
      const set = [], del = [];
      for (const k of keys) kv.has(k) ? set.push([k, kv.get(k)]) : del.push(k);
      box.src = kv; box.rev = kv.rev;
      return set.length || del.length ? { set, del } : null;
    }
    const full = kv.snapshot();
    const r = await box.request({ op: "sync", sync: { full } }, this.limits.loadMs + Math.ceil(full.size / 1000)); // ~1 ms per 1000 keys to copy
    box.src = kv; box.rev = kv.rev;
    return null;
  }

  // Run one guest entry point against `kv`. With apply (the default) the writes land in `kv` only
  // if the call finishes cleanly; with apply=false they are only returned.
  async call(slot, box, fn, kv, event = null, args = [], { apply = true } = {}) {
    try {
      const sync = await this.syncFor(box, kv);
      const r = await box.request({ op: "call", fn, args, event, sync }, this.limits.callMs);
      this.flushLogs(slot, r.logs);
      r.writes = this.filterWrites(slot, r.writes);
      if (apply) for (const [k, v] of r.writes) kv.set(k, v);
      return r;
    } catch (e) { this.flushLogs(slot, e.logs); throw new LayerError(`${fn}: ${e.message}`); }
  }
  // "No key has two owners": on a client, shared/ is a read cache the server fills. A client layer
  // can't write it (it sends a remote call instead), so such writes are dropped.
  filterWrites(slot, writes) {
    if (this.role !== "client") return writes;
    const kept = writes.filter(([k]) => !k.startsWith("shared/"));
    if (kept.length !== writes.length) this.log("error", `${slot}: wrote shared/ keys on a client; dropped (shared/ is owned by the server host)`, { slot });
    return kept;
  }
  flushLogs(slot, logs) { for (const l of logs ?? []) this.log("layer", l, { slot }); }

  // ---------- applying a streamed manifest ----------
  // manifest = { app, version, layers: { slotName: sha256 }, order: [slot...], hosts?: { slot: "client"|"server"|"any" } }
  apply(manifest, sig, fetchBlob) { return this.exclusive(() => this.applyNow(manifest, sig, fetchBlob)); }
  async applyNow(manifest, sig, fetchBlob) {
    const t0 = performance.now();
    if (!this.headless) this.spare ??= spawnWorker(this.limits); // boot a worker while we verify and fetch
    if (this.trustedKeys.length) {
      let ok = false;
      for (const k of this.trustedKeys) if (await verifyManifest(manifest, sig, k)) { ok = true; break; }
      if (!ok) return this.reject(manifest, "signature not trusted");
    }
    if (this.app && manifest.app !== this.app) return this.reject(manifest, "different app");
    if (manifest.version <= this.version) return this.reject(manifest, `stale version ${manifest.version} ≤ ${this.version}`);
    for (const slot of Object.keys(manifest.layers)) if (!PLACES.has(placement(manifest, slot))) return this.reject(manifest, `${slot}: unknown host "${placement(manifest, slot)}"`);

    // The whole manifest is verified, but only the slots placed on this host are fetched and run.
    const mine = Object.entries(manifest.layers).filter(([slot]) => this.placedHere(manifest, slot));
    // Fetch only what we don't have (content addressing).
    const wanted = [...new Set(mine.map(([, h]) => h))].filter((h) => !this.blobs.has(h));
    for (const h of wanted) {
      const bytes = await fetchBlob(h);
      if ((await sha256(bytes)) !== h) return this.reject(manifest, `blob ${h.slice(0, 8)} failed integrity check`);
      this.blobs.set(h, bytes);
    }

    // Stage every changed slot in a copy-on-write view of state; commit all or nothing.
    const shadowKv = this.kv.fork();
    const staged = [];
    try {
      for (const [slot, hash] of mine) {
        if (this.slots.get(slot)?.hash === hash) continue;
        const box = await this.load(slot, hash);
        staged.push({ slot, hash, box });
        const want = box.schema;
        const have = shadowKv.get(`__schema.${slot}`) ?? want;
        if (want !== have) {
          if (!box.hasMigrate) throw new LayerError(`${slot}: schema ${have}→${want} but no llp_migrate`);
          await this.call(slot, box, "llp_migrate", shadowKv, null, [have]);
        }
        shadowKv.set(`__schema.${slot}`, want);
        // health check: must render cleanly against real state (a headless layer may have no view)
        if (box.hasView) await this.call(slot, box, "llp_view", shadowKv, null, [], { apply: !this.headless });
      }
    } catch (e) {
      for (const s of staged) s.box.kill();
      return this.reject(manifest, e.message);
    }

    // Atomic commit.
    const prevVersion = this.version, prevManifest = this.manifest;
    const base = shadowKv.commit();
    for (const { box } of staged) if (box.src === shadowKv) { box.src = this.kv; box.rev = base + box.rev; }
    for (const { slot, hash, box } of staged) {
      const cur = this.slots.get(slot);
      if (cur) this.retire(slot, cur, prevVersion); // previous versions are kept as hashes and re-instantiated only on revert
      this.slots.set(slot, { hash, box, prev: cur ? [cur.hash, ...cur.prev].slice(0, this.maxPrev) : [] });
    }
    const keep = new Set(mine.map(([slot]) => slot));
    for (const s of [...this.slots.keys()]) if (!keep.has(s)) { this.retire(s, this.slots.get(s), prevVersion); this.slots.delete(s); }
    this.order = (manifest.order ?? Object.keys(manifest.layers)).filter((s) => keep.has(s));
    this.app = manifest.app;
    this.version = manifest.version;
    this.manifest = manifest;
    this.committed(prevManifest, manifest);
    const ms = +(performance.now() - t0).toFixed(1);
    this.log("swap", `v${manifest.version} live — ${staged.length} layer(s) swapped in ${ms} ms`, { ms, version: manifest.version, swapped: staged.map((s) => s.slot) });
    await this.renderNow();
    return { ok: true, ms, version: manifest.version, swapped: staged.map((s) => s.slot) };
  }
  // Hooks for the server host (overlap window). A client just stops the old worker.
  retire(slot, cur, version) { cur.box.kill(); }
  committed(prev, next) {}

  reject(manifest, reason) {
    this.log("reject", `v${manifest.version} rejected: ${reason}`, { version: manifest.version });
    return { ok: false, reason, version: manifest.version };
  }

  // ---------- running ----------
  render() { return this.exclusive(() => this.renderNow()); }
  async renderNow() {
    if (this.headless) return [];
    const kv = this.kv;
    const views = await Promise.all((this.order ?? []).map(async (slot) => {
      for (;;) {
        const s = this.slots.get(slot);
        if (!s) return null;
        // layers render in parallel against the same state; writes are merged in slot order below
        try { const r = await this.call(slot, s.box, "llp_view", kv, null, [], { apply: false }); return { slot, tree: r.tree, writes: r.writes }; }
        catch (e) { if (!(await this.revert(slot, e))) return { slot, error: e.message }; }
      }
    }));
    const out = [];
    for (const v of views) if (v) { for (const [k, x] of v.writes ?? []) this.kv.set(k, x); out.push(v.error ? { slot: v.slot, error: v.error } : { slot: v.slot, tree: v.tree }); }
    this.onRender(out);
    return out;
  }

  // Events are transactions: the layer's writes apply only if it finishes; if it traps or runs
  // past its limits, nothing it wrote is kept and the layer is reverted.
  async dispatch(slot, id, value = "") {
    const effects = await this.exclusive(async () => {
      const s = this.slots.get(slot);
      if (!s) return [];
      try { const r = await this.call(slot, s.box, "llp_event", this.kv, { id, value }); await this.renderNow(); return r.effects; }
      catch (e) { await this.revert(slot, e); await this.renderNow(); return []; }
    });
    for (const fx of effects) this.runCapability(slot, fx);
  }

  async runCapability(slot, { name, arg }) {
    const impl = this.capabilities[name];
    if (!impl) { this.log("cap", `capability "${name}" not granted`, { slot }); return this.dispatch(slot, `cap:${name}`, "error: not granted"); }
    try {
      const result = await impl(arg, { slot, host: this });
      if (result !== undefined) await this.dispatch(slot, `cap:${name}`, String(result));
    } catch (e) { await this.dispatch(slot, `cap:${name}`, "error: " + e.message); }
  }

  async revert(slot, err) {
    const s = this.slots.get(slot);
    if (!s) return false;
    s.box.kill();
    let prev = s.prev;
    while (prev.length) {
      const [back, ...rest] = prev;
      try {
        const box = await this.load(slot, back);
        this.slots.set(slot, { hash: back, box, prev: rest });
        this.log("rollback", `${slot} failed (${err.message}) — reverted to ${back.slice(0, 8)}`, { slot });
        return true;
      } catch { prev = rest; }
    }
    // Nothing to fall back to: restart the same version in a fresh worker, so the slot still works
    // for inputs that don't hit the bad path. This call's output is an error either way.
    let box = s.box;
    try { box = await this.load(slot, s.hash); } catch {}
    this.slots.set(slot, { hash: s.hash, box, prev: [] });
    this.log("error", `${slot}: ${err.message} (no previous version to revert to)`, { slot });
    return false;
  }

  // Inputs bound to state write straight into the host store (no layer call needed). If calls are
  // still queued, the write waits its turn, so "type A, click, type B, click" keeps its order.
  setBound(key, value) {
    if (this.role === "client" && key.startsWith("shared/")) { this.log("error", `input bound to ${key}: shared/ is owned by the server host; dropped`); return; }
    if (this.pending) this.exclusive(() => { this.kv.set(key, value); }); else this.kv.set(key, value);
  }

  // The server host's copy of shared/ keys arriving on a client (bypasses the client-side write rule).
  applyShared({ set = [], del = [], full = false }) {
    return this.exclusive(async () => {
      if (full) { const keep = new Set(set.map(([k]) => k)); for (const k of [...this.kv.keys()]) if (k.startsWith("shared/") && !keep.has(k)) this.kv.delete(k); }
      for (const [k, v] of set) if (k.startsWith("shared/")) this.kv.set(k, v);
      for (const k of del) if (k.startsWith("shared/")) this.kv.delete(k);
      await this.renderNow();
    });
  }

  // Stop every layer worker (lets a Node process exit at once; a browser tab doesn't need it).
  close() {
    for (const s of this.slots.values()) s.box.kill();
    this.spare?.then((w) => w.kill(), () => {});
    this.spare = null;
  }
}
