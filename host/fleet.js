// LLP fleet layer (SPEC section 11): release channels, percentage rollouts, convergence reports
// and signing-key rotation. Host side only; the publisher side is tools/fleet.mjs.
// Like llp-core.js it uses only WebCrypto + TextEncoder, so it runs unchanged in browsers and Node.
// It wraps a LiveHost without changing it: the core still does verify-before-live and the swap.
import { sha256, canonical, b64 } from "./llp-core.js";

const te = new TextEncoder();
const ECDSA = { name: "ECDSA", namedCurve: "P-256" };
const SIG = { name: "ECDSA", hash: "SHA-256" };

// ---------- signatures ----------
const pub = (jwk) => ({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
export async function keyId(jwk) { return (await sha256(te.encode(canonical(pub(jwk))))).slice(0, 16); }
export async function signDoc(doc, privateKey, publicJwk) {
  const sig = await crypto.subtle.sign(SIG, privateKey, te.encode(canonical(doc)));
  return { kid: await keyId(publicJwk), sig: b64.enc(sig) };
}
export async function verifyDoc(doc, sig, jwk) {
  try {
    const key = await crypto.subtle.importKey("jwk", pub(jwk), ECDSA, false, ["verify"]);
    return await crypto.subtle.verify(SIG, key, b64.dec(sig), te.encode(canonical(doc)));
  } catch { return false; }
}
// How many distinct keys of `role` produced a valid signature in `sigs` ([{kid, sig}]).
async function validSigners(doc, sigs, role) {
  const byKid = new Map();
  for (const k of role.keys) byKid.set(await keyId(k), k);
  const ok = new Set();
  for (const s of sigs || []) {
    const k = byKid.get(s?.kid);
    if (k && !ok.has(s.kid) && (await verifyDoc(doc, s.sig, k))) ok.add(s.kid);
  }
  return ok.size;
}

// ---------- percentage rollouts ----------
// A host's bucket is a stable number in [0, 10000) from hash(seed, hostId). A rollout at p% reaches
// exactly the hosts with bucket < p*100, so raising p only ever adds hosts, never swaps the cohort.
export async function bucketOf(hostId, seed) { return parseInt((await sha256(te.encode(`${seed}\n${hostId}`))).slice(0, 8), 16) % 10000; }
export const rolloutSeed = (m) => m.rollout?.seed ?? `${m.app}/${m.channel ?? ""}`;
export async function inRollout(manifest, hostId) {
  const p = manifest.rollout?.percent ?? 100;
  if (p >= 100) return true;
  return (await bucketOf(hostId, rolloutSeed(manifest))) < Math.round(p * 100);
}

// ---------- keyring: who may sign manifests ----------
// doc = { app, keyring: n, root: { keys:[jwk], threshold }, release: { keys:[jwk] } }
// Root keys are kept offline and only sign keyrings. Release keys sign manifests (one signature,
// as in SPEC section 4). Keyring n+1 is accepted only if signed by `threshold` keys of keyring n's
// root, and, when it changes the root, also by `threshold` keys of the new root. Versions must
// increase by exactly one so every step is checked against the root the host already trusts.
function checkRole(role, name) {
  if (!role || !Array.isArray(role.keys) || role.keys.length === 0) throw new Error(`${name} has no keys`);
  const t = role.threshold ?? 1;
  if (!Number.isInteger(t) || t < 1 || t > role.keys.length) throw new Error(`${name} threshold ${t} is invalid`);
}
export class TrustStore {
  // `pinned` is the keyring shipped with the host (trust on install). Its signatures aren't checked.
  constructor(pinned) { checkRole(pinned.root, "root"); checkRole(pinned.release, "release"); this.doc = pinned; }
  get version() { return this.doc.keyring; }
  get app() { return this.doc.app; }
  releaseKeys() { return this.doc.release.keys; }
  async update(doc, sigs) {
    const cur = this.doc;
    if (doc?.app !== cur.app) return { ok: false, reason: "keyring for a different app" };
    if (!(doc.keyring > cur.keyring)) return { ok: false, reason: `stale keyring ${doc.keyring} ≤ ${cur.keyring}` };
    if (doc.keyring !== cur.keyring + 1) return { ok: false, reason: `keyring ${doc.keyring} skips ${cur.keyring + 1}; send the chain in order` };
    try { checkRole(doc.root, "root"); checkRole(doc.release, "release"); } catch (e) { return { ok: false, reason: e.message }; }
    const t = cur.root.threshold ?? 1;
    const n = await validSigners(doc, sigs, cur.root);
    if (n < t) return { ok: false, reason: `keyring ${doc.keyring} has ${n} of ${t} current root signatures` };
    if (canonical(doc.root) !== canonical(cur.root)) {
      const t2 = doc.root.threshold ?? 1, n2 = await validSigners(doc, sigs, doc.root);
      if (n2 < t2) return { ok: false, reason: `new root has ${n2} of ${t2} signatures` };
    }
    this.doc = doc;
    return { ok: true, keyring: doc.keyring };
  }
  async verifyManifest(manifest, sig) {
    for (const k of this.doc.release.keys) if (await verifyDoc(manifest, sig, k)) return true;
    return false;
  }
}

// ---------- the agent: one per host ----------
// Speaks the fleet messages next to the SPEC section 5 stream:
//   host -> publisher  {t:"hello", app, host, channel, version, keyring, have}
//   publisher -> host  {t:"keyring", doc, sigs}   (oldest first when the host is behind)
//   host -> publisher  {t:"status", host, channel, version, keyring, target, percent, state, reason}
// where state is live | skipped (not in this rollout's share) | rejected | reverted | keyring | keyring-rejected.
export class FleetAgent {
  constructor({ host, id, channel, trust, send = () => {} }) {
    if (!id) throw new Error("FleetAgent needs a stable host id");
    Object.assign(this, { host, id, channel, trust, send });
    host.trustedKeys = trust.releaseKeys();
    host.app ??= trust.app;            // pin the host to the keyring's app from the start (RT-05)
    host.maxEpoch = trust.version;     // a manifest may claim an epoch only up to the keyring this host trusts (RT-02)
    this.target = 0;
    this.reverts = 0;
    this.queue = Promise.resolve();
    this.pending = new Map();    // blob hash -> resolve, for blobs asked for with "want"
    this.blobTimeoutMs = 10000;
    const prev = host.onLog;
    host.onLog = (e) => { prev?.(e); if (e.kind === "rollback") { this.reverts++; this.report("reverted", e.msg); } };
  }
  hello() {
    this.send({ t: "hello", app: this.trust.app, host: this.id, channel: this.channel, version: this.host.version, keyring: this.trust.version, have: [...this.host.blobs.keys()] });
  }
  report(state, reason, extra = {}) {
    this.state = state;
    this.reason = reason;
    this.send({ t: "status", host: this.id, channel: this.channel, version: this.host.version, keyring: this.trust.version, target: this.target, percent: this.percent, state, reason, ...extra });
  }
  // Entry point for a wire transport: feed every message from the publisher here. Blobs are
  // fetched over the same stream with "want" (SPEC section 5).
  receive(msg) {
    if (msg.t === "blob") { const r = this.pending.get(msg.hash); if (r) { this.pending.delete(msg.hash); r(b64.dec(msg.data)); } return Promise.resolve(null); }
    return this.onMessage(msg, (h) => this.want(h));
  }
  want(hash) {
    return new Promise((res, rej) => {
      this.pending.set(hash, res);
      this.send({ t: "want", hashes: [hash] });
      const t = setTimeout(() => { if (this.pending.delete(hash)) rej(new Error(`blob ${hash.slice(0, 8)} never arrived`)); }, this.blobTimeoutMs);
      t.unref?.();
    });
  }
  // Messages are handled one at a time, in arrival order, so a keyring that precedes a manifest
  // signed by the new key is always in place first. Resolves to what was reported.
  onMessage(msg, fetchBlob) {
    const run = this.queue.then(() => this.handle(msg, fetchBlob));
    this.queue = run.catch(() => {});
    return run;
  }
  async handle(msg, fetchBlob) {
    if (msg.t === "keyring") {
      const r = await this.trust.update(msg.doc, msg.sigs);
      if (!r.ok) return this.report("keyring-rejected", r.reason), r;
      this.host.trustedKeys = this.trust.releaseKeys();
      this.host.maxEpoch = this.trust.version;
      const missed = this.state === "rejected" && /signature|epoch/.test(this.reason);
      this.report("keyring", `keyring ${r.keyring}`);
      // A release signed by the new key may have arrived first (e.g. from a cache); ask again.
      if (missed) this.hello();
      return r;
    }
    if (msg.t !== "manifest") return null;
    const m = msg.manifest;
    // Checked here, before anything else, so an unsigned message can't even produce a "skipped".
    if (!(await this.trust.verifyManifest(m, msg.sig))) return this.reject(m, "signature not trusted");
    if (m.app !== this.trust.app) return this.reject(m, "different app");
    // The channel is inside the signed manifest, so a beta release can't be replayed onto stable.
    if ((m.channel ?? null) !== (this.channel ?? null)) return this.reject(m, `manifest is for channel ${m.channel ?? "(none)"}, host is on ${this.channel ?? "(none)"}`);
    // Older than what's running: a late duplicate or a replay. Ignored, and it doesn't change the
    // host's reported state (the core would refuse it anyway, SPEC section 6 step 2).
    // Versions are ordered as (epoch, version): a new keyring epoch restarts the order (RT-02).
    const cmp = this.host.compareVersion(m);
    if (cmp < 0) return { state: "stale", reason: `v${m.version} (epoch ${m.epoch ?? 0}) < running v${this.host.version} (epoch ${this.host.epoch})` };
    this.target = m.version;
    this.percent = m.rollout?.percent ?? 100;
    // A share increase re-signs the same version; hosts already on it have nothing to do.
    if (cmp === 0) return this.done(this.state === "reverted" ? "reverted" : "live", "already on this version");
    if (!(await inRollout(m, this.id))) return this.done("skipped", `not in the ${m.rollout.percent}% share`);
    let r;
    try { r = await this.host.apply(m, msg.sig, fetchBlob); } catch (e) { r = { ok: false, reason: e.message }; }
    return r.ok ? this.done("live", `${r.ms} ms`, { ms: r.ms }) : this.done("rejected", r.reason);
  }
  reject(m, reason) { return this.done("rejected", reason, { target: m?.version }); }
  done(state, reason, extra = {}) { this.report(state, reason, extra); return { state, reason, ...extra }; }
}
