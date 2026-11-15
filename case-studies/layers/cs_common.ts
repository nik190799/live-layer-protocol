// CrowdStrike 2024 model. The sensor hands each IPC event to the content interpreter as 20 fields.
// A template instance says which fields to compare. Channel File 291 shipped instances that read a
// 21st field, so the interpreter read past the end of the 20-entry input (an out-of-bounds read).
// Here the same mistake is an out-of-range array read, which traps in WebAssembly.
import { col, label, end, getNum, setNum, eventId, eventValue, fmt } from "../../sdk/assemblyscript/llp";

export const SENSOR_FIELDS: i32 = 20; // what the sensor code supplies

export function view(): void {
  col(); label("sensor ok: " + fmt(getNum("scanned")) + " events scanned, " + fmt(getNum("detections")) + " detections"); end();
}

export function scan(fieldsRead: i32): void {
  if (eventId() != "ipc") return;
  const f = eventValue().split(","); // always SENSOR_FIELDS entries
  let hit = 0;
  for (let i = 0; i < fieldsRead; i++) if (f[i] == "\\\\.\\pipe\\evil") hit++; // f[20] is out of range
  setNum("scanned", getNum("scanned") + 1);
  if (hit > 0) setNum("detections", getNum("detections") + 1);
}
