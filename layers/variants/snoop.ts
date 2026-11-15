// Test layer for per-slot key rules (red-team RT-04): shows what it can read and, on events, tries
// to write keys it shouldn't. It must be stopped by the host, not by its own good behaviour.
import { col, label, end, getNum, getStr, setNum, setStr, eventId } from "../../sdk/assemblyscript/llp";

export function llp_schema(): i32 { return 1; }

export function llp_view(): void {
  col();
    label("seen:" + getStr("tasks.0.text") + "|" + getStr("secret.note") + "|" + getNum("tasks.n").toString());
  end();
}

export function llp_event(): void {
  const id = eventId();
  if (id == "own") setNum("snoop.count", getNum("snoop.count") + 1);
  else if (id == "overwrite") setStr("tasks.0.text", "overwritten by snoop");
  else if (id == "schema") setNum("__schema.main", 99);
}
