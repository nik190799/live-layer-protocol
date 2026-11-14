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

class LayerError extends Error {}

export class LiveHost {
  constructor({ trustedKeys = [], capabilities = {}, onRender = () => {}, onLog = () => {}, maxPrev = 5 } = {}) {
    this.trustedKeys = trustedKeys;      // publisher public keys (JWK)
    this.capabilities = capabilities;    // name -> async (arg, ctx) => string result
    this.onRender = onRender;
    this.onLog = onLog;
    this.maxPrev = maxPrev;
    this.kv = new Map();                 // host-owned state: survives every swap
    this.blobs = new Map();              // content-addressed store: hash -> bytes
    this.slots = new Map();              // slot -> { hash, exports, prev: [] }
    this.version = 0;
    this.app = null;
    this.ctx = null;                     // per-call context: { kv, tree stack, event }
    this.history = [];
  }

  log(kind, msg, extra = {}) { const e = { t: Date.now(), kind, msg, ...extra }; this.history.push(e); this.onLog(e); }

  // ---------- the guest ABI ----------
  imports(slot) {
    const host = this;
    let mem = null;
    const bytes = (p, l) => new Uint8Array(mem.buffer, p, l);
    const str = (p, l) => td.decode(bytes(p, l));
    const put = (s, p, cap) => { const b = te.encode(s); bytes(p, Math.min(b.length, cap)).set(b.subarray(0, cap)); return b.length; };
    const c = () => { if (!host.ctx) throw new LayerError("host call outside a host-initiated call"); return host.ctx; };
    const llp = {
      ui_begin: (p, l) => { const n = { k: str(p, l), a: {}, c: [] }; const s = c().stack; s[s.length - 1].c.push(n); s.push(n); },
      ui_attr: (kp, kl, vp, vl) => { const s = c().stack; s[s.length - 1].a[str(kp, kl)] = str(vp, vl); },
      ui_text: (p, l) => { const s = c().stack; s[s.length - 1].c.push({ k: "text", t: str(p, l) }); },
      ui_end: () => { const s = c().stack; if (s.length <= 1) throw new LayerError("ui_end without ui_begin"); s.pop(); },
      kv_get_n: (kp, kl, def) => { const v = c().kv.get(str(kp, kl)); return typeof v === "number" ? v : def; },
      kv_set_n: (kp, kl, v) => { c().kv.set(str(kp, kl), v); },
      kv_get_s: (kp, kl, bp, cap) => { const v = c().kv.get(str(kp, kl)); return put(v == null ? "" : String(v), bp, cap); },
      kv_set_s: (kp, kl, vp, vl) => { c().kv.set(str(kp, kl), str(vp, vl)); },
      ev_id: (bp, cap) => put(c().event?.id ?? "", bp, cap),
      ev_val: (bp, cap) => put(c().event?.value ?? "", bp, cap),
      cap: (np, nl, ap, al) => { const x = c(); x.effects.push({ name: str(np, nl), arg: str(ap, al) }); return x.effects.length; },
      log: (p, l) => host.log("layer", str(p, l), { slot }),
      now: () => Date.now(),
    };
    const env = { abort: () => { throw new LayerError("layer aborted"); }, seed: () => Math.random() * 2 ** 32 };
    return { imports: { llp, env }, bind: (m) => { mem = m; } };
  }

  async instantiate(slot, bytes) {
    const { imports, bind } = this.imports(slot);
    const { instance } = await WebAssembly.instantiate(bytes, imports);
    const ex = instance.exports;
    if (!(ex.memory instanceof WebAssembly.Memory)) throw new LayerError("layer must export memory");
    if (typeof ex.llp_view !== "function") throw new LayerError("layer must export llp_view");
    bind(ex.memory);
    return ex;
  }

  // Run one guest entry point inside a context; collects UI tree + effects.
  call(exports, fn, kv, event, ...args) {
    const root = { k: "root", a: {}, c: [] };
    this.ctx = { kv, stack: [root], event, effects: [] };
    try {
      exports[fn]?.(...args);
      if (this.ctx.stack.length !== 1) throw new LayerError(`unbalanced UI in ${fn}`);
      return { tree: root.c.length === 1 ? root.c[0] : root, effects: this.ctx.effects };
    } finally { this.ctx = null; }
  }

  // ---------- applying a streamed manifest ----------
  // manifest = { app, version, layers: { slotName: sha256 }, order: [slot...] }
  async apply(manifest, sig, fetchBlob) {
    const t0 = performance.now();
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
        const ex = await this.instantiate(slot, this.blobs.get(hash));
        const want = ex.llp_schema ? ex.llp_schema() : 0;
        const have = shadowKv.get(`__schema.${slot}`) ?? want;
        if (want !== have) {
          if (!ex.llp_migrate) throw new LayerError(`${slot}: schema ${have}→${want} but no llp_migrate`);
          this.call(ex, "llp_migrate", shadowKv, null, have);
        }
        shadowKv.set(`__schema.${slot}`, want);
        this.call(ex, "llp_view", shadowKv, null); // health check: must render cleanly against real state
        staged.push({ slot, hash, ex });
      }
    } catch (e) {
      return this.reject(manifest, e.message);
    }

    // Atomic commit.
    for (const { slot, hash, ex } of staged) {
      const cur = this.slots.get(slot);
      const prev = cur ? [{ hash: cur.hash, exports: cur.exports }, ...cur.prev].slice(0, this.maxPrev) : [];
      this.slots.set(slot, { hash, exports: ex, prev });
    }
    for (const s of [...this.slots.keys()]) if (!(s in manifest.layers)) this.slots.delete(s);
    this.order = manifest.order ?? Object.keys(manifest.layers);
    this.kv = shadowKv;
    this.app = manifest.app;
    this.version = manifest.version;
    const ms = +(performance.now() - t0).toFixed(1);
    this.log("swap", `v${manifest.version} live — ${staged.length} layer(s) swapped in ${ms} ms`, { ms, version: manifest.version, swapped: staged.map((s) => s.slot) });
    this.render();
    return { ok: true, ms, version: manifest.version, swapped: staged.map((s) => s.slot) };
  }

  reject(manifest, reason) {
    this.log("reject", `v${manifest.version} rejected: ${reason}`, { version: manifest.version });
    return { ok: false, reason, version: manifest.version };
  }

  // ---------- running ----------
  render() {
    const out = [];
    for (const slot of this.order ?? []) {
      const s = this.slots.get(slot);
      if (!s) continue;
      try { out.push({ slot, tree: this.call(s.exports, "llp_view", this.kv, null).tree }); }
      catch (e) { if (this.revert(slot, e)) return this.render(); out.push({ slot, error: e.message }); }
    }
    this.onRender(out);
    return out;
  }

  // Events are transactions: if the layer traps, state is restored and the layer reverted.
  async dispatch(slot, id, value = "") {
    const s = this.slots.get(slot);
    if (!s) return;
    const snapshot = new Map(this.kv);
    let effects = [];
    try { effects = this.call(s.exports, "llp_event", this.kv, { id, value }).effects; }
    catch (e) { this.kv = snapshot; this.revert(slot, e); return this.render(); }
    this.render();
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

  revert(slot, err) {
    const s = this.slots.get(slot);
    if (!s || !s.prev.length) { this.log("error", `${slot}: ${err.message} (no previous version to revert to)`, { slot }); return false; }
    const [back, ...rest] = s.prev;
    this.slots.set(slot, { hash: back.hash, exports: back.exports, prev: rest });
    this.log("rollback", `${slot} trapped (${err.message}) — reverted to ${back.hash.slice(0, 8)}`, { slot });
    return true;
  }

  // Inputs bound to state write straight into the host store (no layer call needed).
  setBound(key, value) { this.kv.set(key, value); }
}
