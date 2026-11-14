// Compile an AI-written layer and shadow-check it before anyone is asked to approve it.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import asc from "assemblyscript/asc";

const SDK = new URL("../sdk/assemblyscript/llp.ts", import.meta.url).pathname;

export async function compile(source, dir, name) {
  mkdirSync(dir, { recursive: true });
  copyFileSync(SDK, join(dir, "llp.ts"));
  const src = join(dir, `${name}.ts`), out = join(dir, `${name}.wasm`);
  writeFileSync(src, source);
  let stderr = "";
  const sink = { write: (s) => { stderr += s; return true; } };
  const r = await asc.main([src, "-o", out, "-O3", "--noColors"], { stdout: { write: () => true }, stderr: sink });
  if (r.error) return { ok: false, error: (stderr || r.error.message).trim().slice(0, 4000) };
  return { ok: true, bytes: new Uint8Array(readFileSync(out)), file: out };
}

// Runs the check in a worker so an infinite loop in the layer can be stopped.
// base:  { slot: bytes } of what is live now; candidate: { slot, bytes } replacing one slot.
export function shadowCheck({ base, order, candidate, timeoutMs = 3000 }) {
  return new Promise((resolve) => {
    const w = new Worker(new URL("./check-worker.mjs", import.meta.url), { workerData: { base, order, candidate } });
    const timer = setTimeout(() => { w.terminate(); resolve({ ok: false, error: `timed out after ${timeoutMs} ms (an infinite loop or very slow code in llp_view or llp_event)` }); }, timeoutMs);
    w.once("message", (m) => { clearTimeout(timer); w.terminate(); resolve(m); });
    w.once("error", (e) => { clearTimeout(timer); resolve({ ok: false, error: e.message }); });
  });
}
