// Client slot "main" for the run-anywhere demo: renders the server-owned shared/ task list and sends
// changes as remote calls to the server slot "sync". Built with -DV2 semantics in tasks_shared_v2.ts.
import { col, row, heading, label, button, input, toggle, end,
         getNum, getStr, setStr, eventId, eventValue, cap, fmt } from "../../sdk/assemblyscript/llp";

export function llp_view(): void {
  const n = <i32>getNum("shared/tasks.n");
  col();
    heading("Shared tasks");
    label(n.toString() + " shared tasks");
    row(); input("draft", "Add a shared task…", "add"); button("add", "Add", "primary"); end();
    for (let i = n > 50 ? n - 50 : 0; i < n; i++) { // newest 50: a UI page, not the whole store
      const k = "shared/tasks." + i.toString();
      toggle("t:" + i.toString(), getNum(k + ".done") > 0, getStr(k + ".text") + " (" + getStr(k + ".by") + ")");
    }
    button("buy", "Buy for $12.99");
    label("last reply: " + getStr("last"));
  end();
}

export function llp_event(): void {
  const id = eventId();
  if (id == "add") { cap("remote", "sync:add " + getStr("draft")); setStr("draft", ""); }
  else if (id.startsWith("t:")) cap("remote", "sync:toggle " + id.substring(2));
  else if (id == "buy") cap("remote", "pay:checkout 1299");
  else if (id == "try-write") setStr("shared/tasks.n", "999"); // a client layer trying to write shared state
  else if (id == "cap:remote") setStr("last", eventValue());
}
