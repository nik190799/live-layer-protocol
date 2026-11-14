// Server slot "sync" v2: adds priorities. Expand-only change (SPEC 10.3): every v1 op still works,
// and the migration only adds keys, so v1 clients reading shared/ keep working during the overlap.
import { getNum, setNum, getStr, setStr, eventId, fmt } from "../../sdk/assemblyscript/llp";
import { caller, args, reply, fail, isDigits } from "./common";

export function llp_schema(): i32 { return 2; }
export function llp_migrate(from: i32): void {
  const n = <i32>getNum("shared/tasks.n");
  for (let i = 0; i < n; i++) setNum("shared/tasks." + i.toString() + ".pri", 1);
  setNum("server/migrated.from", <f64>from);
}

function add(text: string, pri: i32, user: string): void {
  if (text.length == 0 || text.length > 200) { fail("text must be 1 to 200 characters"); return; }
  const n = <i32>getNum("shared/tasks.n");
  const k = "shared/tasks." + n.toString();
  setStr(k + ".text", text); setStr(k + ".by", user); setNum(k + ".done", 0); setNum(k + ".pri", pri);
  setNum("shared/tasks.n", n + 1);
  reply(n.toString());
}

export function llp_event(): void {
  const op = eventId(), user = caller(), a = args();
  setNum("server/calls", getNum("server/calls") + 1);
  if (op == "add") add(a, 1, user);
  else if (op == "add2") {
    // "<priority 1-3>|<text>"
    const bar = a.indexOf("|");
    const p = bar > 0 ? a.substring(0, bar) : "";
    if (!isDigits(p) || I32.parseInt(p) < 1 || I32.parseInt(p) > 3) { fail("add2 takes <priority 1-3>|<text>"); return; }
    add(a.substring(bar + 1), I32.parseInt(p), user);
  } else if (op == "toggle") {
    if (!isDigits(a)) { fail("toggle takes a task number"); return; }
    const i = I32.parseInt(a);
    if (i >= <i32>getNum("shared/tasks.n")) { fail("no such task"); return; }
    const k = "shared/tasks." + i.toString() + ".done";
    setNum(k, getNum(k) > 0 ? 0 : 1);
    reply("ok");
  } else if (op == "count") reply(fmt(getNum("shared/tasks.n")));
  else fail("unknown op " + op);
}
