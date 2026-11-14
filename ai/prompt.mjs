// What the model is told, and how its answer is read back.
import { readFileSync } from "node:fs";

const SDK = readFileSync(new URL("../sdk/assemblyscript/llp.ts", import.meta.url), "utf8");

export const SYSTEM = `You write one layer of a live app for the Live Layer Protocol (LLP).
A layer is an AssemblyScript module compiled to WebAssembly and streamed into an app that is already running.
It replaces the previous layer in place, so the person using the app must keep everything they had.

Rules of the ABI:
- The layer is stateless. All state lives in the host key/value store (getNum/setNum/getStr/setStr).
  Never keep app state in globals: globals reset on every swap.
- Export llp_view(): void. It draws the whole UI every time with el/attr/text/end helpers.
  Every container you open (col, row, card) must be closed with end(). Unbalanced UI is rejected.
- Export llp_event(): void. eventId() is the id of the clicked button or toggle. Input boxes write their
  text straight into the state key named by their bind attribute; an input with submit="x" fires event "x" on Enter.
- Export llp_schema(): i32 and llp_migrate(from: i32): void. Keep reading the existing state keys.
  If you add keys that need defaults for data that already exists, bump llp_schema() and fill them in llp_migrate.
- UI kinds the hosts can draw: col, row, card, heading, label, big, button (style "primary" or "danger"),
  input, toggle, progress (attr "value" 0-100), and text.
- Capabilities (haptic, geo...) are requested with cap(name, arg); results come back later as event "cap:<name>".
- Another layer (a footer) reads tasks.n and tasks.<i>.done, so keep those keys meaning the same thing.
- Import helpers only from "./llp". The host checks your layer against real state before it goes live; if it
  fails to compile or traps you will get the error back and must fix it.

Reply with a one-sentence summary of the change, then the complete new file in a single \`\`\`ts code block.
No other code blocks.

This is the SDK file "./llp" you import from:
\`\`\`ts
${SDK}
\`\`\``;

export function firstRequest(prompt, currentSource) {
  return `Here is the layer that is live right now:\n\`\`\`ts\n${currentSource}\n\`\`\`\n\nChange it so that: ${prompt}`;
}

export function feedback(stage, detail) {
  const what = {
    format: "I could not find a single ```ts code block in your reply.",
    compile: "The layer failed to compile.",
    check: "The layer compiled but failed the shadow check (it was run against a copy of the app's real state and its buttons were clicked).",
    host: "The running app refused the layer when it tried to swap it in.",
    revise: "The reviewer did not approve this version and asked for a change.",
  }[stage];
  return `${what}\n\n${detail}\n\nReturn the complete corrected file in one \`\`\`ts block.`;
}

export function extractCode(reply) {
  const blocks = [...reply.matchAll(/```(?:ts|typescript|assemblyscript)?\s*\n([\s\S]*?)```/g)].map((m) => m[1]);
  if (!blocks.length) return null;
  return blocks[blocks.length - 1].trimEnd() + "\n";
}

export function summaryOf(reply) {
  return reply.split("```")[0].trim().split("\n")[0].slice(0, 200);
}
