// Fastly 2021 model: an edge layer serves requests for many customers. Each customer's settings live
// in host state ("cfg.<customer>.<name>"), pushed by the customer, not by a code release.
import { col, label, end, getNum, setNum, eventId, eventValue, fmt } from "../../sdk/assemblyscript/llp";
export function view(): void { col(); label("edge: " + fmt(getNum("served")) + " served"); end(); }
export function customer(): string { const v = eventValue(); const i = v.indexOf("/"); return i < 0 ? v : v.substring(0, i); }
export function served(): void { setNum("served", getNum("served") + 1); }
export function hash(s: string): i32 { let h: i32 = 7; for (let i = 0; i < s.length; i++) h = h * 31 + s.charCodeAt(i); return h & 0x7fffffff; }
export { getNum, setNum, eventId };
