# Demo GIF

`node tools/demo-gif/record.mjs` races the same two AI changes through two ways of shipping, at the
same moment, side by side. One run writes three cuts, all 4:5 for phone feeds (GIF 600x750, MP4
1080x1350):

- `docs/demo-1-speed.*`: the same change goes live. LLP takes about a second and keeps what the user
  was typing. Today takes a CI run and a restart, and the reload wipes what the user was typing.
- `docs/demo-2-bug.*`: the AI writes a bug. LLP blocks it before any user gets it and ships the fix.
  Today's tests pass it, a user hits it, and it stays broken until the rollback goes through CI again.
- `docs/demo.*`: both clips plus a closing card.

Every measured number goes to `docs/demo-run.json`, including links to the GitHub Actions runs.

Needs Playwright with Chromium, `ffmpeg`, push access to `origin` and the `gh` CLI signed in. Each
change force-pushes the branch `demo-today/recording`, which runs `.github/workflows/today-demo.yml`.
A full recording takes 3 to 4 minutes of real time. `--ci local` runs the same tests in a fresh clone
on this machine instead of on GitHub. `--out <path>` writes somewhere else.

## Both sides are real

**Today (top)**, from `today-app/` and `today-pipeline.mjs`:

- A plain JS tasks app on a Node server. Tasks are saved to a file on the server, so they survive a
  restart, as they would with a database.
- Its test suite covers the features it has: API tests, plus end-to-end tests in headless Chromium.
- A change is committed and pushed. GitHub Actions installs the test browser and runs the tests.
  When they pass, the server is stopped and the new release started, and the open page notices the
  new release and reloads, like most web apps.

**With LLP (bottom)**: the real `tools/ai-publish.mjs` streams to a real Live Host
(`host/llp-core.js`) in Chromium. It compiles, shadow-checks, signs, streams and swaps.

Both clocks are real elapsed time from the moment the request is made. The long CI waits are sped up
×20 in the video, and the page says so while they are.

## What is scripted, and why

- **The AI's code was written in advance by Claude**, for both sides (`replies/` for LLP, and
  `today-app/versions/` for today). Each side gets the same change: a progress bar, then a Delete
  button. Both Delete versions have the same planted off-by-one (reading one task past the end), so
  there is a real bug to catch. Neither clock includes time for a model to think.
- **Approvals are instant on both sides**, so neither clock includes a person's review time.
- **A typed draft shows what a reload loses.** "Call the ba" is typed into both apps before the first
  change. LLP keeps it because the input is bound to host-owned state. Today's page reload loses it.
  The script fails if either side doesn't behave that way.
- **The BLOCKED stamp stays on screen a moment after the LLP clock has stopped**, so it can be read.
  The clock is not affected.
- **After Today's bug goes live, the script clicks Delete**, like a user would. That crash starts the
  "broken for users" clock, and the rollback (a git revert through the same pipeline) stops it.

The script exits without writing a GIF if the run did not show what the captions say:

- LLP kept the tasks and the draft, and today lost the draft.
- The bug was blocked as a trap while the LLP device stayed on the previous build.
- The LLP fix went live on the second attempt, and Delete then worked.
- Today was slower on the good change.

## "How LLP works" image

`node tools/demo-gif/render-architecture.mjs` renders `architecture.html` to `docs/llp-architecture.png`
(1080x1350, 4:5). It fails instead of writing the image if any text overflows the frame or the
comparison row overlaps the diagram. Every claim on it is in SPEC.md sections 3, 6 and 6.1.
