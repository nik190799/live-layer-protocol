// Server slot "sync" v1: the authoritative shared task list for every user of the app.
// Clients can't write shared/ themselves; they call these ops. Everything from a client is
// untrusted input, so every op validates its arguments.
import { getNum, setNum, getStr, setStr, eventId, fmt } from "../../sdk/assemblyscript/llp";
import { caller, args, reply, fail, isDigits } from "./common";

export function llp_schema(): i32 { return 1; }

export function llp_event(): void {
  const op = eventId(), user = caller(), a = args();
  setNum("server/calls", getNum("server/calls") + 1); // server-private: never sent to clients
  if (op == "add") {
    if (a.length == 0 || a.length > 200) { fail("text must be 1 to 200 characters"); return; }
    const n = <i32>getNum("shared/tasks.n");
    const k = "shared/tasks." + n.toString();
    setStr(k + ".text", a); setStr(k + ".by", user); setNum(k + ".done", 0);
    setNum("shared/tasks.n", n + 1);
    reply(n.toString());
  } else if (op == "toggle") {
    if (!isDigits(a)) { fail("toggle takes a task number"); return; }
    const i = I32.parseInt(a);
    if (i >= <i32>getNum("shared/tasks.n")) { fail("no such task"); return; }
    const k = "shared/tasks." + i.toString() + ".done";
    setNum(k, getNum(k) > 0 ? 0 : 1);
    reply("ok");
  } else if (op == "count") {
    reply(fmt(getNum("shared/tasks.n")));
  } else if (op == "work") {
    // Heavy compute: count the primes below n with a sieve.
    if (!isDigits(a)) { fail("work takes a number"); return; }
    const n = I32.parseInt(a);
    const sieve = new Uint8Array(n + 1);
    let count = 0;
    for (let i = 2; i <= n; i++) {
      if (sieve[i]) continue;
      count++;
      for (let j = <i64>i * i; j <= n; j += i) sieve[<i32>j] = 1;
    }
    reply(count.toString());
  } else {
    fail("unknown op " + op);
  }
}
