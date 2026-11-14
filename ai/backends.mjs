// Pluggable model backends. Each one is { name, generate({ system, messages }) -> Promise<string> }.
// messages is a plain [{ role: "user" | "assistant", content: string }] list.
import { readFileSync } from "node:fs";

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
