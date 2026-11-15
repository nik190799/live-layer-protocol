// Knight Capital 2012 model of the SMARS order router. Parent orders arrive as "order" events with
// value "<shares>,<flag>". Child orders go to the market; fills are instant in this model.
import { col, label, end, getNum, setNum, fmt } from "../../sdk/assemblyscript/llp";

export function view(): void {
  col(); label("parents " + fmt(getNum("parents")) + ", child orders " + fmt(getNum("child")) + ", shares " + fmt(getNum("shares"))); end();
}
export function child(shares: f64): void { setNum("child", getNum("child") + 1); setNum("shares", getNum("shares") + shares); }
export function parse(v: string): i32[] { const p = v.split(","); return [I32.parseInt(p[0]), I32.parseInt(p[1])]; }
