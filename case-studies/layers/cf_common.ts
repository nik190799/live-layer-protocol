// Cloudflare 2019 model: a WAF layer on an edge server checks every request against its rules.
// The matcher backtracks like the PCRE-style engine the WAF used: ".*" first takes everything,
// then gives characters back one at a time until the rest of the pattern matches.
import { col, label, end, getNum, setNum, eventId, eventValue, fmt } from "../../sdk/assemblyscript/llp";

const STAR: i32 = 42; // "*" in a pattern below stands for ".*"; every other character is a literal
function m(s: string, si: i32, p: string, pi: i32): bool {
  if (pi == p.length) return true;
  const c = p.charCodeAt(pi);
  if (c == STAR) { for (let j = s.length; j >= si; j--) if (m(s, j, p, pi + 1)) return true; return false; }
  return si < s.length && s.charCodeAt(si) == c && m(s, si + 1, p, pi + 1);
}
// Unanchored search, as a regex engine does: try every start position.
export function search(s: string, p: string): bool { for (let i = 0; i <= s.length; i++) if (m(s, i, p, 0)) return true; return false; }

export function view(): void { col(); label("edge: " + fmt(getNum("served")) + " served, " + fmt(getNum("flagged")) + " flagged"); end(); }
export function handle(rules: string[]): void {
  if (eventId() != "req") return;
  const body = eventValue();
  let flagged = false;
  for (let i = 0; i < rules.length; i++) if (search(body, rules[i])) flagged = true;
  setNum("served", getNum("served") + 1);
  if (flagged) setNum("flagged", getNum("flagged") + 1);
}
