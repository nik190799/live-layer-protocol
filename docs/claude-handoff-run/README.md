# Claude as the model, no API key (run of 2026-11-15)

`tools/ai-publish.mjs --backend handoff` was run for real against a headless Live Host. Instead of an
API call, each model request was written to `.ai-live/handoff/NNN.request.md`, and Claude (in a chat
session on a subscription) read it and wrote `NNN.reply.md` by hand. Everything after that was the
real loop: AssemblyScript compile, shadow check in a worker, the diff and preview, approval on stdin,
signed manifest streamed over WebSocket, signature checked and layer swapped by the host.

The host already held real state (3 tasks, one done) before the first change.

| # | Person's prompt | Model calls | What happened |
|---|---|---|---|
| 1 | star important tasks, starred first, header counts them | 001, 002 | 001 left the per-task `row()` open on purpose. Shadow check refused it (`unbalanced UI in llp_view`), the error went back as call 002, the fix passed and was approved. Schema went 1 → 2 and `llp_migrate` gave the existing tasks `star = 0`. Host swapped in 7.9 ms with all 3 tasks kept. |
| 2 | delete button per task, case-insensitive filter box | 003 | Passed first time, approved, swapped in 4.1 ms. On the host: filter `MOM` showed only "Call mom" and "2 hidden by the filter"; deleting it shifted the rest down and "Pay rent" kept its star. |
| 3 | progress bar under the heading | 004, 005 | 004 passed the checks, but the reviewer answered `r put the progress bar at the bottom, just above Clear done`. Those words went back as call 005, that version was approved and swapped in 5.7 ms. Ticking a task moved both this bar and the separate C footer layer to 50%. |

Files: `001.request.md` (the full first request, including the system prompt), `00N.reply.md` (what
Claude answered), `final-layer.ts` (the layer live at the end), `publisher.txt` and `host.txt` (both
terminals), `history.jsonl` (the loop's own log with timings; the "model" time is how long the
handwritten reply took).

To do this yourself: `node tools/ai-publish.mjs --backend handoff footer=build/stats.wasm`, connect a
host, type a change, then answer the request file it names (in a Claude chat, or by hand).
Write the reply to `NNN.reply.md.tmp` and rename it, so the loop never reads half a file.
