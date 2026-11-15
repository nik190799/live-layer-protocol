// Pluggable model backends. Each one is { name, generate({ system, messages }) -> Promise<string> }.
// messages is a plain [{ role: "user" | "assistant", content: string }] list.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Claude through the official SDK. The key comes from the environment (ANTHROPIC_API_KEY,
// ANTHROPIC_AUTH_TOKEN or an `ant auth login` profile); nothing is read from or written to disk.
export async function claudeBackend({ model = process.env.LLP_MODEL || "claude-opus-5-5", effort = process.env.LLP_EFFORT || "high" } = {}) {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic();
  return {
    name: `claude (${model})`,
    async generate({ system, messages }) {
      const res = await client.beta.messages.create({
        model,
        max_tokens: 16000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",          // a refused request is retried on a fallback model server-side
        output_config: { effort },
        system,
        messages,
      });
      if (res.stop_reason === "refusal") throw new Error(`model refused: ${res.stop_details?.explanation ?? "no detail"}`);
      const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
      if (res.stop_reason === "max_tokens") return text + "\n(reply was cut off at max_tokens)";
      return text;
    },
  };
}

// Canned replies, in order, ignoring the prompt. Used to prove the loop without a key and in tests.
// script: array of reply strings, or a path to a JSON file holding one.
export function stubBackend(script) {
  const replies = typeof script === "string" ? JSON.parse(readFileSync(script, "utf8")) : script;
  let i = 0;
  return {
    name: "stub (canned replies, prompt ignored)",
    calls: [],
    async generate(req) {
      this.calls.push(req);
      if (i >= replies.length) throw new Error("stub backend has no more replies");
      return replies[i++];
    },
  };
}

// A model that answers through files, so no API key is needed: any session that can read and
// write files (a person, or Claude in a chat on a subscription) plays the model. For call N the
// loop writes <dir>/NNN.request.json (the exact system + messages an API call would carry) and
// <dir>/NNN.request.md (the same, readable), then waits for <dir>/NNN.reply.md and uses its text
// as the model's reply. A reply is taken only once it is complete: write NNN.reply.md.tmp and
// rename it, or write the file in one go.
export function handoffBackend(dir, { pollMs = 100, timeoutMs = +(process.env.LLP_HANDOFF_TIMEOUT_MS || 30 * 60_000), onWaiting } = {}) {
  mkdirSync(dir, { recursive: true });
  let n = readdirSync(dir).filter((f) => /^\d+\.request\.json$/.test(f)).length;
  return {
    name: `handoff (replies read from ${dir})`,
    async generate({ system, messages }) {
      const id = String(++n).padStart(3, "0");
      const req = join(dir, `${id}.request.json`), md = join(dir, `${id}.request.md`), reply = join(dir, `${id}.reply.md`);
      writeFileSync(req, JSON.stringify({ system, messages }, null, 2));
      writeFileSync(md, `# Model call ${id}\n\nWrite the reply to ${reply}\n\n## System\n\n${system}\n\n`
        + messages.map((m, i) => `## ${i + 1}. ${m.role}\n\n${m.content}\n`).join("\n"));
      onWaiting?.({ id, request: req, readable: md, reply });
      const t0 = Date.now();
      while (!existsSync(reply)) {
        if (Date.now() - t0 > timeoutMs) throw new Error(`no reply at ${reply} after ${Math.round(timeoutMs / 1000)} s`);
        await new Promise((r) => setTimeout(r, pollMs));
      }
      return readFileSync(reply, "utf8");
    },
  };
}
