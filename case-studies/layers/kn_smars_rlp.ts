// The new SMARS code for the Retail Liquidity Program: flag 1 now means "route to RLP".
// Power Peg is gone. Each parent order becomes one child order that fills it.
import { getNum, setNum, eventId, eventValue } from "../../sdk/assemblyscript/llp";
import { view, child, parse } from "./kn_common";
export function llp_view(): void { view(); }
export function llp_event(): void {
  if (eventId() != "order") return;
  const o = parse(eventValue());
  setNum("parents", getNum("parents") + 1);
  child(o[0]);
}
