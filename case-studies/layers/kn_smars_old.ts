// The old SMARS code: flag 1 still switches on "Power Peg", a test feature retired in 2003 but never
// removed. In 2005 the cumulative-quantity check was moved out of Power Peg's path, so Power Peg
// never learns that a parent order is filled and keeps sending child orders on every market tick.
import { getNum, setNum, eventId, eventValue } from "../../sdk/assemblyscript/llp";
import { view, child, parse } from "./kn_common";
export function llp_view(): void { view(); }
export function llp_event(): void {
  const id = eventId();
  if (id == "order") {
    const o = parse(eventValue());
    setNum("parents", getNum("parents") + 1);
    if (o[1] == 1) { const n = <i32>getNum("pp.n"); setNum("pp." + n.toString(), o[0]); setNum("pp.n", n + 1); }
    else child(o[0]);
  } else if (id == "tick") {
    const n = <i32>getNum("pp.n");
    for (let i = 0; i < n; i++) child(100); // no "filled >= wanted" check: it was moved away in 2005
  }
}
