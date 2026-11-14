// Shared helpers for the LLP benchmark.
export const now = () => performance.timeOrigin + performance.now(); // ms, comparable across local processes

export function stats(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))]; // nearest-rank
  const r = (v) => +v.toFixed(3);
  return { n: s.length, p50: r(q(0.5)), p95: r(q(0.95)), min: r(s[0]), max: r(s[s.length - 1]) };
}

// Make a byte-different but behaviour-identical build of a layer by appending a
// WebAssembly custom section. Stands in for "a new compile of the changed layer":
// new hash, same code, so every trial is a real swap the host must verify and stage.
const leb = (n) => { const out = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; out.push(b); } while (n); return out; };
export function withNonce(bytes, nonce) {
  const name = new TextEncoder().encode("llp.bench"), payload = new TextEncoder().encode(String(nonce));
  const body = [...leb(name.length), ...name, ...payload];
  const out = new Uint8Array(bytes.length + 1 + leb(body.length).length + body.length);
  out.set(bytes, 0);
  out.set([0, ...leb(body.length), ...body], bytes.length);
  return out;
}
