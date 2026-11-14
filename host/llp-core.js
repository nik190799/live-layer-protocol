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

// ---------- sandbox limits ----------
// Every layer runs in its own worker (Web Worker in browsers, worker_threads in Node), never on the
// host's thread. A call that runs past its time limit gets its worker killed, and the host treats
// that like a trap: the call's state changes are dropped and the slot is reverted.
export const DEFAULT_LIMITS = {
  callMs: 100,     // wall-clock budget for one llp_view / llp_event / llp_migrate call
  firstCallMs: 1000, // budget for the first call in a fresh worker, which also pays lazy compilation
                     // and is the one most likely to land while the device is busy (a swap, app start)
  loadMs: 2000,    // budget for compile + instantiate (+ start function) + llp_schema
  memoryMb: 32,    // cap on the layer's linear memory, written into the module's memory limits
  uiNodes: 10000,  // cap on UI nodes one call may emit (bounds the worker's JS heap in every engine)
  heapMb: 64,      // worker JS heap cap (Node only; browsers have no per-worker heap limit)
  isolation: "worker", // "inline" runs layers on the host's thread with no time limit: only for trusted
                        // code, e.g. simulating many devices in one process (bench/sim-hosts.mjs)
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
  const bytes = (p, l) => new Uint8Array(mem.buffer, p, l);
  const str = (p, l) => td.decode(bytes(p, l));
  const put = (s, p, cap) => { const b = te.encode(s); bytes(p, Math.min(b.length, cap)).set(b.subarray(0, cap)); return b.length; };
  const c = () => { if (!ctx) throw new LayerError("host call outside a host-initiated call"); return ctx; };
  const node = (n) => { const x = c(); if (++x.nodes > maxNodes) throw new LayerError(`UI exceeded ${maxNodes} nodes`); x.stack[x.stack.length - 1].c.push(n); return n; };
  const write = (k, v) => { const x = c(); x.kv.set(k, v); x.writes.set(k, v); };
  const llp = {
    ui_begin: (p, l) => c().stack.push(node({ k: str(p, l), a: {}, c: [] })),
    ui_attr: (kp, kl, vp, vl) => { const s = c().stack; s[s.length - 1].a[str(kp, kl)] = str(vp, vl); },
    ui_text: (p, l) => { node({ k: "text", t: str(p, l) }); },
    ui_end: () => { const s = c().stack; if (s.length <= 1) throw new LayerError("ui_end without ui_begin"); s.pop(); },
    kv_get_n: (kp, kl, def) => { const v = c().kv.get(str(kp, kl)); return typeof v === "number" ? v : def; },
    kv_set_n: (kp, kl, v) => write(str(kp, kl), v),
    kv_get_s: (kp, kl, bp, cap) => { const v = c().kv.get(str(kp, kl)); return put(v == null ? "" : String(v), bp, cap); },
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
        if (typeof ex.llp_view !== "function") throw new LayerError("layer must export llp_view");
        mem = ex.memory;
        post({ id, ok: true, schema: ex.llp_schema ? ex.llp_schema() : 0, hasMigrate: typeof ex.llp_migrate === "function", logs });
      } else if (op === "call") {
        const root = { k: "root", a: {}, c: [] };
        ctx = { kv: m.kv, stack: [root], event: m.event, effects: [], writes: new Map(), nodes: 0 };
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
    this.w = w; this.dead = null; this.pending = null; this.seq = 0; this.calls = 0;
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

export class LiveHost {
  constructor({ trustedKeys = [], capabilities = {}, onRender = () => {}, onLog = () => {}, maxPrev = 5, limits = {} } = {}) {
    this.trustedKeys = trustedKeys;      // publisher public keys (JWK)
    this.capabilities = capabilities;    // name -> async (arg, ctx) => string result
    this.onRender = onRender;
    this.onLog = onLog;
    this.maxPrev = maxPrev;
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.kv = new Map();                 // host-owned state: survives every swap
    this.blobs = new Map();              // content-addressed store: hash -> bytes
    this.slots = new Map();              // slot -> { hash, box, prev: [hash...] }
    this.version = 0;
    this.app = null;
    this.history = [];
    this.spare = null;                   // a pre-spawned worker, so a swap doesn't wait for worker boot
    this.pool = [];                      // healthy workers freed by swaps, reused before the spare
    this.queue = Promise.resolve();      // apply / render / dispatch run one at a time, as they did when synchronous
  }

  log(kind, msg, extra = {}) { const e = { t: Date.now(), kind, msg, ...extra }; this.history.push(e); this.onLog(e); }
  exclusive(fn) {
    this.pending = (this.pending ?? 0) + 1;
    const r = this.queue.then(fn).finally(() => { this.pending--; });
    this.queue = r.catch(() => {});
    return r;
  }

  // ---------- layer instances (each in its own worker) ----------
  async load(slot, hash) {
    const inline = this.limits.isolation === "inline";
    let box = this.pool.pop(); // a healthy worker freed by an earlier swap: no boot wait
    if (!box) {
      const w = inline ? inlineWorker() : await (this.spare ?? spawnWorker(this.limits));
      if (!inline) this.spare = spawnWorker(this.limits);
      this.spare?.catch(() => {});
      box = new Sandbox(w);
    }
    box.calls = 0; // the new module's first call gets the first-call budget
    const w = box.w;
    if (w.inline && !inline && !this.warnedInline) { this.warnedInline = true; this.log("error", "this page blocks workers, so layers run on the page's thread and a layer stuck in a loop can freeze it"); }
    try {
      const pages = Math.floor(this.limits.memoryMb * 2 ** 20 / PAGE);
      const bytes = capMemory(this.blobs.get(hash), pages);
      const r = await box.request({ op: "load", bytes, maxNodes: this.limits.uiNodes, memCap: pages * PAGE }, this.limits.loadMs);
      this.flushLogs(slot, r.logs);
      box.schema = r.schema; box.hasMigrate = r.hasMigrate;
      return box;
    } catch (e) { box.kill(); this.flushLogs(slot, e.logs); throw e; }
  }

  // Run one guest entry point against `kv`. Writes land in `kv` only if the call finishes cleanly.
  async call(slot, box, fn, kv, event = null, ...args) {
    try {
      const ms = box.calls++ ? this.limits.callMs : Math.max(this.limits.callMs, this.limits.firstCallMs);
      const r = await box.request({ op: "call", fn, args, kv, event }, ms);
      this.flushLogs(slot, r.logs);
      for (const [k, v] of r.writes) kv.set(k, v);
      return r;
    } catch (e) { this.flushLogs(slot, e.logs); throw new LayerError(`${fn}: ${e.message}`); }
  }
  // A worker whose layer was swapped out cleanly is reused for the next load (its old instance is
  // dropped when the new module loads). Workers that failed or overran are always killed instead.
  recycle(box) { if (!box.dead && !box.pending && this.pool.length < 2) this.pool.push(box); else box.kill(); }
  flushLogs(slot, logs) { for (const l of logs ?? []) this.log("layer", l, { slot }); }

  // ---------- applying a streamed manifest ----------
  // manifest = { app, version, layers: { slotName: sha256 }, order: [slot...] }
  apply(manifest, sig, fetchBlob) { return this.exclusive(() => this.applyNow(manifest, sig, fetchBlob)); }
  async applyNow(manifest, sig, fetchBlob) {
    const t0 = performance.now();
    if (this.limits.isolation !== "inline") this.spare ??= spawnWorker(this.limits); // boot a worker while we verify and fetch
    if (this.trustedKeys.length) {
      let ok = false;
      for (const k of this.trustedKeys) if (await verifyManifest(manifest, sig, k)) { ok = true; break; }
      if (!ok) return this.reject(manifest, "signature not trusted");
    }
    if (this.app && manifest.app !== this.app) return this.reject(manifest, "different app");
    if (manifest.version <= this.version) return this.reject(manifest, `stale version ${manifest.version} ≤ ${this.version}`);

    // Fetch only what we don't have (content addressing).
    const wanted = Object.values(manifest.layers).filter((h) => !this.blobs.has(h));
    for (const h of wanted) {
      const bytes = await fetchBlob(h);
      if ((await sha256(bytes)) !== h) return this.reject(manifest, `blob ${h.slice(0, 8)} failed integrity check`);
      this.blobs.set(h, bytes);
    }

    // Stage every changed slot in a shadow copy of state; commit all or nothing.
    const shadowKv = new Map(this.kv);
    const staged = [];
    try {
      for (const [slot, hash] of Object.entries(manifest.layers)) {
        if (this.slots.get(slot)?.hash === hash) continue;
        const box = await this.load(slot, hash);
        staged.push({ slot, hash, box });
        const want = box.schema;
        const have = shadowKv.get(`__schema.${slot}`) ?? want;
        if (want !== have) {
          if (!box.hasMigrate) throw new LayerError(`${slot}: schema ${have}→${want} but no llp_migrate`);
          await this.call(slot, box, "llp_migrate", shadowKv, null, have);
        }
        shadowKv.set(`__schema.${slot}`, want);
        await this.call(slot, box, "llp_view", shadowKv); // health check: must render cleanly against real state
      }
    } catch (e) {
      for (const s of staged) s.box.kill();
      return this.reject(manifest, e.message);
    }

    // Atomic commit.
    for (const { slot, hash, box } of staged) {
      const cur = this.slots.get(slot);
      if (cur) this.recycle(cur.box); // previous versions are kept as hashes and re-instantiated only on revert
      this.slots.set(slot, { hash, box, prev: cur ? [cur.hash, ...cur.prev].slice(0, this.maxPrev) : [] });
    }
    for (const s of [...this.slots.keys()]) if (!(s in manifest.layers)) { this.recycle(this.slots.get(s).box); this.slots.delete(s); }
    this.order = manifest.order ?? Object.keys(manifest.layers);
    this.kv = shadowKv;
    this.app = manifest.app;
    this.version = manifest.version;
    const ms = +(performance.now() - t0).toFixed(1);
    this.log("swap", `v${manifest.version} live — ${staged.length} layer(s) swapped in ${ms} ms`, { ms, version: manifest.version, swapped: staged.map((s) => s.slot) });
    await this.renderNow();
    return { ok: true, ms, version: manifest.version, swapped: staged.map((s) => s.slot) };
  }

  reject(manifest, reason) {
    this.log("reject", `v${manifest.version} rejected: ${reason}`, { version: manifest.version });
    return { ok: false, reason, version: manifest.version };
  }

  // ---------- running ----------
  render() { return this.exclusive(() => this.renderNow()); }
  async renderNow() {
    const kv = this.kv;
    const views = await Promise.all((this.order ?? []).map(async (slot) => {
      for (;;) {
        const s = this.slots.get(slot);
        if (!s) return null;
        const scratch = new Map(kv); // layers render in parallel; writes are merged in slot order below
        try { const r = await this.call(slot, s.box, "llp_view", scratch); return { slot, tree: r.tree, writes: r.writes }; }
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
      const shadow = new Map(this.kv);
      let r;
      try { r = await this.call(slot, s.box, "llp_event", shadow, { id, value }); }
      catch (e) { await this.revert(slot, e); await this.renderNow(); return []; }
      for (const [k, v] of r.writes) this.kv.set(k, v);
      await this.renderNow();
      return r.effects;
    });
    for (const fx of effects) this.runCapability(slot, fx);
  }

  async runCapability(slot, { name, arg }) {
    const impl = this.capabilities[name];
    if (!impl) { this.log("cap", `capability "${name}" not granted`, { slot }); return this.dispatch(slot, `cap:${name}`, "error: not granted"); }
    try {
      const result = await impl(arg, { slot });
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
  setBound(key, value) { if (this.pending) this.exclusive(() => { this.kv.set(key, value); }); else this.kv.set(key, value); }

  // Stop every layer worker (lets a Node process exit at once; a browser tab doesn't need it).
  close() {
    for (const s of this.slots.values()) s.box.kill();
    for (const b of this.pool.splice(0)) b.kill();
    this.spare?.then((w) => w.kill(), () => {});
    this.spare = null;
  }
}
