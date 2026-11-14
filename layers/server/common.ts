// Helpers for server-host layers (SPEC section 10). A remote call arrives as an llp_event whose id
// is the op and whose value is "<user>\n<args>": the first line is the caller the server host
// authenticated, never something the client chose. The layer answers by writing __reply (or
// __error); those two keys belong to the call and are never stored.
import { eventValue, setStr } from "../../sdk/assemblyscript/llp";

export function caller(): string { const v = eventValue(); const i = v.indexOf("\n"); return i < 0 ? v : v.substring(0, i); }
export function args(): string { const v = eventValue(); const i = v.indexOf("\n"); return i < 0 ? "" : v.substring(i + 1); }
export function reply(s: string): void { setStr("__reply", s); }
export function fail(s: string): void { setStr("__error", s); }
export function isDigits(s: string): bool {
  if (s.length == 0 || s.length > 9) return false;
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); if (c < 48 || c > 57) return false; }
  return true;
}
