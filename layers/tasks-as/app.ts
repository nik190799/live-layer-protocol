// "Tasks" main layer — written in AssemblyScript (TypeScript-like).
import { col, row, card, heading, label, big, button, input, toggle, end, text,
         getNum, setNum, getStr, setStr, eventId, eventValue, cap, fmt } from "../../sdk/assemblyscript/llp";

export function llp_schema(): i32 { return 1; }
export function llp_migrate(from: i32): void {}

export function llp_view(): void {
  const n = <i32>getNum("tasks.n");
  let done = 0;
  for (let i = 0; i < n; i++) if (getNum("tasks." + i.toString() + ".done") > 0) done++;

  col();
    heading("Tasks");
    label(done.toString() + " of " + n.toString() + " done");
    row();
      input("draft", "Add a task…", "add");
      button("add", "Add", "primary");
    end();
    for (let i = 0; i < n; i++) {
      const k = "tasks." + i.toString();
      toggle("t:" + i.toString(), getNum(k + ".done") > 0, getStr(k + ".text"));
    }
    if (done > 0) button("clear", "Clear done");
  end();
}

export function llp_event(): void {
  const id = eventId();
  if (id == "add") {
    const draft = getStr("draft");
    if (draft.length == 0) return;
    const n = <i32>getNum("tasks.n");
    setStr("tasks." + n.toString() + ".text", draft);
    setNum("tasks." + n.toString() + ".done", 0);
    setNum("tasks.n", n + 1);
    setStr("draft", "");
  } else if (id.startsWith("t:")) {
    const k = "tasks." + id.substr(2);
    const now = getNum(k + ".done") > 0 ? 0.0 : 1.0;
    setNum(k + ".done", now);
    if (now > 0) cap("haptic", "20");
  } else if (id == "clear") {
    const n = <i32>getNum("tasks.n");
    let w = 0;
    for (let i = 0; i < n; i++) {
      const k = "tasks." + i.toString();
      if (getNum(k + ".done") == 0) {
        const t = getStr(k + ".text");
        setStr("tasks." + w.toString() + ".text", t);
        setNum("tasks." + w.toString() + ".done", 0);
        w++;
      }
    }
    setNum("tasks.n", w);
  }
}
