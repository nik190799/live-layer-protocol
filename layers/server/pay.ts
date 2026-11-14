// Server slot "pay": takes a payment through the server's "charge" capability. The payment API key
// lives in the server host's capability provider; this layer (and every client) never sees it.
import { getNum, setNum, setStr, eventId, eventValue, cap } from "../../sdk/assemblyscript/llp";
import { caller, args, reply, fail, isDigits } from "./common";

export function llp_event(): void {
  const op = eventId();
  if (op == "checkout") {
    const cents = args();
    if (!isDigits(cents) || I32.parseInt(cents) == 0) { fail("checkout takes an amount in cents"); return; }
    cap("charge", caller() + " " + cents);
    reply("pending");
  } else if (op == "cap:charge") {
    const r = eventValue();
    if (r.startsWith("error")) { fail(r); return; }
    const n = <i32>getNum("shared/orders.n");
    setStr("shared/orders." + n.toString(), r);
    setNum("shared/orders.n", n + 1);
    reply(r);
  } else fail("unknown op " + op);
}
