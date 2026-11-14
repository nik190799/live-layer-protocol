// Client slot "main" v2: uses the new server op sync:add2 (priority), which exists only in server v2.
import { col, row, heading, label, button, input, toggle, end,
         getNum, getStr, setStr, eventId, eventValue, cap, fmt } from "../../sdk/assemblyscript/llp";

export function llp_view(): void {
  const n = <i32>getNum("shared/tasks.n");
  col();
    heading("Shared tasks v2");
    label(n.toString() + " shared tasks");
    row(); input("draft", "Add an urgent task…", "add"); button("add", "Add urgent", "primary"); end();
    for (let i = n > 50 ? n - 50 : 0; i < n; i++) { // newest 50: a UI page, not the whole store
      const k = "shared/tasks." + i.toString();
      toggle("t:" + i.toString(), getNum(k + ".done") > 0, "P" + fmt(getNum(k + ".pri", 1)) + " " + getStr(k + ".text"));
    }
    label("last reply: " + getStr("last"));
  end();
}

export function llp_event(): void {
  const id = eventId();
  if (id == "add") { cap("remote", "sync:add2 3|" + getStr("draft")); setStr("draft", ""); }
  else if (id.startsWith("t:")) cap("remote", "sync:toggle " + id.substring(2));
  else if (id == "cap:remote") setStr("last", eventValue());
}
