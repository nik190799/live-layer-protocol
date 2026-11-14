// Test-only server layer for another tenant: "spin" never returns. Used to prove that one tenant's
// runaway layer doesn't stall other tenants on the same server host.
import { eventId } from "../../sdk/assemblyscript/llp";
import { reply, fail } from "./common";

let x: i32 = 0;
export function llp_event(): void {
  const op = eventId();
  if (op == "spin") { while (true) { x++; } }
  else if (op == "ping") reply("pong");
  else fail("unknown op " + op);
}
