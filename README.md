# Live Layer Protocol (LLP) — v0 reference implementation

Stream code into a running app. Layers are signed, content-addressed WebAssembly modules; the host verifies, rehearses, and swaps them in place in milliseconds without losing state. See `SPEC.md`.

## Layout

| Path | What it is |
|---|---|
| `SPEC.md` | Protocol draft: manifest, stream messages, swap rules, layer ABI, capability tiers |
| `host/llp-core.js` | The host core. Same file runs in browsers and Node |
| `host/node-host.mjs` | Headless Live Host (renders to the terminal) |
| `tools/publisher.mjs` | Watches compiled layers, signs manifests, streams them over WebSocket |
| `sdk/assemblyscript/llp.ts`, `sdk/c/llp.h` | Layer SDKs |
| `layers/tasks-as/app.ts` | Main layer (AssemblyScript) |
| `layers/stats-c/stats.c` | Footer layer (C) |
| `layers/variants/` | v2 (migration), broken, and crashing variants used in tests |
| `test/run.mjs` | The 14 core proof tests (in-process) |
| `test/service.mjs` | 10 tests of the per-device service |
| `test/live-e2e.mjs` | 10 over-the-wire tests: real publisher and host processes, plus a rogue stream |
| `test/interop.mjs` | Runs a browser-published manifest on the Node host |
| `service/`, `install/`, `Install-LiveLayer.cmd` | Per-device service, CLI and installers |
| `web/` | Browser Live Host page (`build.py` inlines the core and layers into `index.html`) |

## Quick test (5 minutes)

Requires Node 22+. The compiled layers are committed in `build/`, so no compiler is needed to test.

```bash
git clone https://github.com/nik190799/live-layer-protocol.git
cd live-layer-protocol
npm install
npm test          # 34 checks: core rules, the service, and live over-the-wire attacks
```

### Watch it update live

Terminal 1, the publisher (signs and streams whatever is in the two files):

```bash
cp build/tasks.wasm build/live-main.wasm; cp build/stats.wasm build/live-footer.wasm
node tools/publisher.mjs --port 7700 main=build/live-main.wasm footer=build/live-footer.wasm
```

Terminal 2, the running app (a headless host that draws in the terminal):

```bash
node host/node-host.mjs ws://localhost:7700 keys/publisher.pub.json
set draft Buy milk
click main add
```

Terminal 3, "ship" new code by replacing a layer file. No build, no deploy:

```bash
cp build/tasks_v2.wasm build/live-main.wasm      # terminal 2 shows "Tasks v2" with Buy milk still there
cp build/tasks_broken.wasm build/live-main.wasm  # refused; v2 keeps running
cp build/tasks_trap.wasm build/live-main.wasm    # goes live, then crashes on the next add...
```

...then in terminal 2 run `set draft x` and `click main add`: the crash is caught, state is restored and the host reverts to v2.

On Windows PowerShell use `copy` instead of `cp`.

## Rebuild the layers from source

Needs clang with the wasm32 target for the C layer. `npm run build` does the same as:

```bash
npm install
npx asc layers/tasks-as/app.ts -o build/tasks.wasm -O3
clang --target=wasm32 -nostdlib -O2 -Wl,--no-entry -o build/stats.wasm layers/stats-c/stats.c
for v in tasks_v2 tasks_broken tasks_trap; do npx asc layers/variants/$v.ts -o build/$v.wasm -O3; done

node test/run.mjs                       # 14 proof tests

# live streaming between two processes
cp build/tasks.wasm build/live-main.wasm; cp build/stats.wasm build/live-footer.wasm
node tools/publisher.mjs --port 7700 main=build/live-main.wasm footer=build/live-footer.wasm
node host/node-host.mjs ws://localhost:7700 keys/publisher.pub.json   # in another terminal
# now overwrite build/live-main.wasm with any other build and watch the host swap it
```

Host commands: `click <slot> <id>`, `set <key> <text>`, `state`.

Requires Node 22+ (for WebCrypto and the built-in WebSocket) and clang with the wasm32 target for the C layer.

## The Live Layer service (one per device)

`service/llpd.mjs` is the long-running service: it hosts any number of live apps, keeps their state on disk, restores them after a restart (re-checking signatures), accepts signed layer streams on `ws://127.0.0.1:7710/publish`, and serves UI clients at `http://127.0.0.1:7710`. It listens on this device only and refuses connections from web pages on other sites.

Install:

- **Windows:** `double-click `Install-LiveLayer.cmd`, or run `powershell -ExecutionPolicy Bypass -File install\install-windows.ps1` (no admin needed; starts at sign-in). Remove with `install\uninstall-windows.ps1`.
- **Linux / macOS:** `sh install/install-unix.sh` (systemd user service, launchd agent, or a background process).

Then, from any terminal: `llp push <app> <slot>=<file.wasm> ...`, `llp watch ...` (push on every save), `llp status`, `llp key`, `llp trust <key.json>`.

Tests: `node test/service.mjs` (10 checks: install, two live clients, capability effects, refusal, origin blocking, restart with state restored, swap after restart, status).

## Status

The run-anywhere hosts design (SPEC section 10) is not implemented or tested. Known v0 gaps are listed in SPEC section 11; the biggest is that a layer stuck in an infinite loop can still freeze its host.
