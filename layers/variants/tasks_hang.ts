// Sandbox test layer: Tasks v2 plus deliberate failures, picked by the draft text.
// "hang view" loops forever in llp_view, "hang event" in llp_event (after writing state),
// "blow memory" allocates until memory runs out, "flood ui" emits a million UI nodes. Used by test/sandbox.mjs.
import { col, row, card, heading, label, big, button, input, toggle, end, text,
         getNum, setNum, getStr, setStr, eventId, eventValue, cap, fmt } from "../../sdk/assemblyscript/llp";

export function llp_schema(): i32 { return 2; }
export function llp_migrate(from: i32): void { const n = <i32>getNum("tasks.n"); for (let i = 0; i < n; i++) setNum("tasks." + i.toString() + ".pri", 1); setNum("migrated.from", <f64>from); }

export function llp_view(): void {
  if (getStr("draft") == "hang view") spin();
  if (getStr("draft") == "flood ui") { col(); for (let i = 0; i < 1000000; i++) text("x"); end(); return; }
  const n = <i32>getNum("tasks.n");
  let done = 0;
  for (let i = 0; i < n; i++) if (getNum("tasks." + i.toString() + ".done") > 0) done++;

  col();
    heading("Tasks v2 — streamed live");
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
    if (draft == "hang event") { setNum("tasks.n", 999); spin(); }
    if (draft == "blow memory") { setNum("tasks.n", 999); hog(); }
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

let sink: i32 = 0;
function spin(): void { let x: i32 = 1; while (true) { x = x * 1103515245 + 12345; sink = x; } }
const hoard = new Array<ArrayBuffer>(0);
function hog(): void { while (true) hoard.push(new ArrayBuffer(1 << 20)); }
