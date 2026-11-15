# Demo GIF

`node tools/demo-gif/record.mjs` records `docs/demo.gif` and `docs/demo.mp4`: the same two AI changes,
shipped two ways at the same moment, side by side. It writes every number it measured to
`docs/demo-run.json`, including links to the GitHub Actions runs.

Needs Playwright with Chromium, `ffmpeg`, push access to `origin` and the `gh` CLI signed in. Each
change force-pushes the branch `demo-today/recording`, which runs `.github/workflows/today-demo.yml`.
A full recording takes about 3 minutes of real time. `--ci local` runs the same tests in a fresh clone
on this machine instead of on GitHub. `--out <path>` writes somewhere else.

## Both sides are real

**Today (left)**, from `today-app/` and `today-pipeline.mjs`:

- A plain JS tasks app on a Node server. Tasks are saved to a file on the server, so they survive a
  restart, as they would with a database.
- Its test suite covers the features it has: API tests, plus end-to-end tests in headless Chromium.
- A change is committed and pushed. GitHub Actions installs the test browser and runs the tests.
  When they pass, the server is stopped and the new release started, and the open page notices the
  new release and reloads, like most web apps.

**With LLP (right)**: the real `tools/ai-publish.mjs` streams to a real Live Host
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
- **The LLP fix clock includes a 1.6 s pause** while "Blocked" is shown, before the fixed reply is
  handed over. This makes LLP look slower, not faster.
- **After Today's bug goes live, the script clicks Delete**, like a user would. That crash starts the
  "broken for users" clock, and the rollback (a git revert through the same pipeline) stops it.

The script exits without writing a GIF if the run did not show what the captions say:

- LLP kept the tasks and the draft, and today lost the draft.
- The bug was blocked as a trap while the LLP device stayed on the previous build.
- The LLP fix went live on the second attempt, and Delete then worked.
- Today was slower on the good change.
