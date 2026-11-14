// Live Layer Protocol (LLP) v0 — AssemblyScript SDK
// A layer is stateless code. State lives in the host, so swapping a layer never loses it.

@external("llp", "ui_begin") declare function _ui_begin(p: usize, l: i32): void;
@external("llp", "ui_attr") declare function _ui_attr(kp: usize, kl: i32, vp: usize, vl: i32): void;
@external("llp", "ui_text") declare function _ui_text(p: usize, l: i32): void;
@external("llp", "ui_end") declare function _ui_end(): void;
@external("llp", "kv_get_n") declare function _kv_get_n(kp: usize, kl: i32, def: f64): f64;
@external("llp", "kv_set_n") declare function _kv_set_n(kp: usize, kl: i32, v: f64): void;
@external("llp", "kv_get_s") declare function _kv_get_s(kp: usize, kl: i32, bp: usize, cap: i32): i32;
@external("llp", "kv_set_s") declare function _kv_set_s(kp: usize, kl: i32, vp: usize, vl: i32): void;
@external("llp", "ev_id") declare function _ev_id(bp: usize, cap: i32): i32;
@external("llp", "ev_val") declare function _ev_val(bp: usize, cap: i32): i32;
@external("llp", "cap") declare function _cap(np: usize, nl: i32, ap: usize, al: i32): i32;
@external("llp", "log") declare function _log(p: usize, l: i32): void;
@external("llp", "now") declare function _now(): f64;

const BUF_CAP: i32 = 8192;
const BUF = new ArrayBuffer(BUF_CAP);

function bp(): usize { return changetype<usize>(BUF); }

// ---- UI (immediate mode: begin/attr/text/end) ----
export function el(kind: string): void { const b = String.UTF8.encode(kind); _ui_begin(changetype<usize>(b), b.byteLength); }
export function attr(k: string, v: string): void {
  const a = String.UTF8.encode(k); const c = String.UTF8.encode(v);
  _ui_attr(changetype<usize>(a), a.byteLength, changetype<usize>(c), c.byteLength);
}
export function end(): void { _ui_end(); }
export function text(s: string): void { const b = String.UTF8.encode(s); _ui_text(changetype<usize>(b), b.byteLength); }

export function col(): void { el("col"); }
export function row(): void { el("row"); }
export function card(): void { el("card"); }
export function heading(s: string): void { el("heading"); text(s); end(); }
export function label(s: string): void { el("label"); text(s); end(); }
export function big(s: string): void { el("big"); text(s); end(); }
export function button(id: string, caption: string, style: string = ""): void {
  el("button"); attr("id", id); if (style.length > 0) attr("style", style); text(caption); end();
}
export function input(bind: string, placeholder: string, submit: string = ""): void {
  el("input"); attr("bind", bind); attr("placeholder", placeholder); if (submit.length > 0) attr("submit", submit); end();
}
export function toggle(id: string, on: bool, caption: string): void {
  el("toggle"); attr("id", id); attr("on", on ? "1" : "0"); text(caption); end();
}

// ---- State (host-owned key/value store) ----
export function getNum(k: string, def: f64 = 0): f64 { const b = String.UTF8.encode(k); return _kv_get_n(changetype<usize>(b), b.byteLength, def); }
export function setNum(k: string, v: f64): void { const b = String.UTF8.encode(k); _kv_set_n(changetype<usize>(b), b.byteLength, v); }
export function getStr(k: string): string {
  const b = String.UTF8.encode(k);
  const n = _kv_get_s(changetype<usize>(b), b.byteLength, bp(), BUF_CAP);
  return String.UTF8.decodeUnsafe(bp(), <usize>min(n, BUF_CAP));
}
export function setStr(k: string, v: string): void {
  const a = String.UTF8.encode(k); const c = String.UTF8.encode(v);
  _kv_set_s(changetype<usize>(a), a.byteLength, changetype<usize>(c), c.byteLength);
}

// ---- Events ----
export function eventId(): string { const n = _ev_id(bp(), BUF_CAP); return String.UTF8.decodeUnsafe(bp(), <usize>min(n, BUF_CAP)); }
export function eventValue(): string { const n = _ev_val(bp(), BUF_CAP); return String.UTF8.decodeUnsafe(bp(), <usize>min(n, BUF_CAP)); }

// ---- Capabilities (results come back as an event "cap:<name>") ----
export function cap(name: string, arg: string = ""): i32 {
  const a = String.UTF8.encode(name); const c = String.UTF8.encode(arg);
  return _cap(changetype<usize>(a), a.byteLength, changetype<usize>(c), c.byteLength);
}
export function log(s: string): void { const b = String.UTF8.encode(s); _log(changetype<usize>(b), b.byteLength); }
export function now(): f64 { return _now(); }

export function fmt(n: f64): string {
  if (n == Math.floor(n) && Math.abs(n) < 1e15) return (<i64>n).toString();
  return n.toString();
}
