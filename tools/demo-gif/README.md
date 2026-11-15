# Demo GIF

`node tools/demo-gif/record.mjs` records `docs/demo.gif` and `docs/demo.mp4` from a real run, and
writes the numbers it measured to `docs/demo-run.json`. It needs Playwright with Chromium and
`ffmpeg` on PATH, and takes about 40 seconds. Use `--out <path>` to write somewhere else.

What is real:

- The four steps on the left (AI writes the code, safety check, approval, live) move when the real
  `tools/ai-publish.mjs` prints that step, and the times under them are the ones it printed. Its full
  output, including the diff and preview it shows the approver, is saved in `demo-run.json`.
- The phone is a real Live Host (`host/llp-core.js`, layers in Web Workers) in Chromium, connected to
  the publisher over WebSocket, verifying its signature. The tasks are typed and clicked into it.
- Every number in a caption comes from that run: the swap time is what the host measured, the
  compile and check times are what the publisher printed.
- The script fails, and writes no GIF, if the run did not show what the captions say (3 tasks kept,
  the bad change caught as a trap while the app stayed on the previous build, the fix live on the
  second attempt, Delete working afterwards).

What is scripted:

- The publisher runs with `--backend handoff`, so the model's replies come from files. The three
  replies in `replies/` were written by Claude. The second one has an off-by-one planted on purpose
  (a `StaticArray` read one past its end) so the shadow check has a real bug to catch; the third is
  the fix, sent only after the publisher passes the check's error back to the model.
- Because the replies are pre-written, the "model" time is not shown; it would not mean anything.
- The approvals are typed by the script.
- The short pauses between steps are added so a viewer can read them; they don't change any number shown.
