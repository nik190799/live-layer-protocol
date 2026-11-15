Adds a progress bar and a "N left" count under the heading, and keeps every existing task as it is (no schema change).

```ts
// "Tasks" main layer: a progress bar and how many tasks are left.
import { col, row, heading, label, big, button, input, toggle, el, attr, end,
         getNum, setNum, getStr, setStr, eventId, cap } from "./llp";

export function llp_schema(): i32 { return 1; }
export function llp_migrate(from: i32): void {}

function progress(pct: i32): void { el("progress"); attr("value", pct.toString()); end(); }

export function llp_view(): void {
  const n = <i32>getNum("tasks.n");
  let done = 0;
  for (let i = 0; i < n; i++) if (getNum("tasks." + i.toString() + ".done") > 0) done++;

  col();
    heading("Tasks");
    big((n - done).toString() + " left");
    progress(n == 0 ? 0 : <i32>(done * 100 / n));
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
        setStr("tasks." + w.toString() + ".text", getStr(k + ".text"));
        setNum("tasks." + w.toString() + ".done", 0);
        w++;
      }
    }
    setNum("tasks.n", w);
  }
}
```
