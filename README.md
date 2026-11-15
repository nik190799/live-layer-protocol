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
| `layers/variants/` | v2 (migration), broken, crashing, and hanging/memory-hogging variants used in tests |
| `test/run.mjs` | The 14 core proof tests (in-process) |
| `test/sandbox.mjs` | 17 tests of the worker sandbox: infinite loops in view, event and migrate, memory blowup, UI flood, input ordering, inline mode |
| `test/browser.mjs` | The sandbox in real Chromium (needs Playwright; not part of `npm test`) |
| `test/service.mjs` | 10 tests of the per-device service |
| `test/live-e2e.mjs` | 10 over-the-wire tests: real publisher and host processes, plus a rogue stream |
| `tools/ai-publish.mjs`, `ai/` | AI publishing loop: prompt, model writes a layer, compile, shadow check, approve, stream |
| `test/ai-loop.mjs` | 15 tests of the AI loop over real processes |
| `host/fleet.js`, `tools/fleet.mjs`, `host/fleet-host.mjs` | Fleet operations: channels, percentage rollouts, convergence, key rotation (SPEC section 12) |
| `test/fleet.mjs` | 28 fleet tests: a 48-host simulation plus 20 hosts in 4 real processes over WebSocket |
| `host/server-host.mjs`, `host/remote-client.mjs`, `layers/server/` | Server/edge host and client link: shared data, secrets, heavy compute (SPEC section 10) |
| `test/hosts.mjs`, `bench/hosts.mjs` | 30 checks of server and client hosts over real WebSockets; scale measurements (`docs/HOSTS.md`) |
| `test/channels.mjs` | 15 checks: release channels on the server host with a real fleet controller, partial rollouts, restarts, key rotation |
| `test/privacy.mjs`, `test/at-rest-hosts.mjs` | 33 checks: per-person export and erase with an audit log, and encryption at rest for the server host, `llpd` and fleet hosts |
| `case-studies/`, `docs/CASE-STUDIES.md` | CrowdStrike 2024, Knight 2012, Cloudflare 2019, Fastly 2021 and a hotfix replayed the old way and through LLP; `npm run case-studies` (17 checks) |
| `test/interop.mjs` | Runs a browser-published manifest on the Node host |
| `service/`, `install/`, `Install-LiveLayer.cmd` | Per-device service, CLI and installers |
| `web/` | Browser Live Host page (`build.py` inlines the core and layers into `index.html`) |

## Quick test (5 minutes)

Requires Node 22+. The compiled layers are committed in `build/`, so no compiler is needed to test.

```bash
git clone https://github.com/nik190799/live-layer-protocol.git
cd live-layer-protocol
npm install
npm test          # 267 checks: core rules, security fixes, the layer sandbox, the service, live over-the-wire attacks, the AI loop, fleet, server/client hosts, channels, privacy and encryption at rest, and the case studies
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
for v in tasks_v2 tasks_broken tasks_trap tasks_hang tasks_hang_migrate; do npx asc layers/variants/$v.ts -o build/$v.wasm -O3; done

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

`service/llpd.mjs` is the long-running service: it hosts any number of live apps, keeps their state on disk, restores them after a restart (re-checking signatures), accepts signed layer streams on `ws://127.0.0.1:7710/publish`, and serves UI clients at `http://127.0.0.1:7710`. It listens on this device only, refuses connections from web pages on other sites, and asks UI clients for a token that only your user account can read: run `llp open` for the link.

Install:

- **Windows:** `double-click `Install-LiveLayer.cmd`, or run `powershell -ExecutionPolicy Bypass -File install\install-windows.ps1` (no admin needed; starts at sign-in). Remove with `install\uninstall-windows.ps1`.
- **Linux / macOS:** `sh install/install-unix.sh` (systemd user service, launchd agent, or a background process).

Then, from any terminal: `llp push <app> <slot>=<file.wasm> ...`, `llp watch ...` (push on every save), `llp status`, `llp key`, `llp open [app]` (prints the UI link), `llp trust <key.json> <app>` (trust a teammate's key for one app).

Tests: `node test/service.mjs` (16 checks: install, two live clients, capability effects, refusal, origin blocking, restart with state restored, swap after restart, status, the UI token, UI writes limited to bound inputs, per-app trust).

## AI publishing loop (prompt to live app)

Type what you want changed. A model writes the new layer, and the loop compiles it to Wasm, shadow-checks it, shows you a diff and a preview, and after you answer `y` signs it and streams it into the running app. State is kept. If the layer fails to compile, traps or hangs in the shadow check, or the running host refuses it, the error goes back to the model and it tries again (up to `--max-attempts`, default 4).

Terminal 1, the AI publisher (it is also the stream server):

```bash
export ANTHROPIC_API_KEY=...        # from console.anthropic.com; never commit it
npm run ai                          # uses Claude when a key is set; model: claude-opus-5-5 (override with LLP_MODEL, LLP_EFFORT)
```

Terminal 2, the running app:

```bash
node host/node-host.mjs ws://localhost:7700 keys/publisher.pub.json
set draft Buy milk
click main add
```

Then in terminal 1 at `ai>` type a change, for example `show how many tasks are left and add a clear all button`. At `approve?` answer `y` to ship, `n` to discard, or `r <what to change>` to send it back.

**No API key? Use Claude in a chat as the model:** `node tools/ai-publish.mjs --backend handoff footer=build/stats.wasm`. Each model call is written to `.ai-live/handoff/NNN.request.md` and the loop waits for `NNN.reply.md`; paste the request into Claude (or let a Claude session with file access read it) and save the answer there. A real run, with one rejected attempt, is in [docs/claude-handoff-run](docs/claude-handoff-run/README.md).

Without a key and without `--backend handoff` it uses a stub backend that ignores the prompt and returns two canned replies (the first has a compile error), so you can see the whole loop work: `npm run ai`.

What the shadow check does, before you are asked: it starts the live layers in a worker thread, uses the current layer like a person would to build real-looking state, swaps the candidate in with the real host core, clicks every button it draws, and stops it after 3 seconds if it hangs. The running host still does its own check against its real state when the layer arrives.

Files: the live source is `.ai-live/current.ts`, every attempt is in `.ai-live/attempts/`, and each change is logged with its timings in `.ai-live/history.jsonl`. Restarting resumes from `current.ts` (use `--fresh` to start over).

## Fleet: channels, staged rollouts, key rotation

Terminal 1, the fleet controller (keys go to `keys/fleet/`; the root key would live offline in production):

```bash
node tools/fleet.mjs --port 7720
```

Terminal 2, five hosts on the stable channel, each keeping its accepted keyring on disk:

```bash
node host/fleet-host.mjs ws://localhost:7720 keys/fleet/keyring.pinned.json --id laptop --channel stable --count 5   # keeps its keyring and device key in keys/fleet/trust/
```

Then type into terminal 1:

```
publish stable 100 main=build/tasks.wasm footer=build/stats.wasm   # everyone
publish stable 20 main=build/tasks_v2.wasm footer=build/stats.wasm # 20% of hosts
percent stable 100                                                 # widen
status stable                                                      # convergence report
rollout stable 10,50,100 main=build/tasks_broken.wasm footer=build/stats.wasm  # halts at 10% and rolls back
rotate                                                             # new release key, fleet-wide
```

Tests: `npm run test:fleet` (28 checks). In a 48-host simulation: share accuracy over 10,000 ids, channel isolation, exact cohorts, widening only adds hosts, user state kept, offline hosts catching up, a broken release halted at 10% and a crashing one at 20% (caught by host revert reports while traffic runs), release and 2-of-3 root rotation, a revoked key refused, and a late host walking the whole keyring chain. Over the wire: 20 hosts in 4 processes, a 30% rollout, a dead process shown as offline, rotation, restart catch-up, and a rogue stream using the revoked key. `FLEET_HOSTS=300 npm run test:fleet` runs the simulation with 300 hosts.

## Server and edge hosts (same layers, any host)

One signed stream feeds both kinds of host. A manifest's `hosts` field puts each slot on the client or the server; the server host runs the server slots, owns everything under `shared/`, keeps secrets in its capability providers, and relays the stream to clients only after it has committed each version. Client layers call server layers with `cap("remote", "sync:add Buy milk")`.

```js
import { ServerHost, tokenAuth } from "./host/server-host.mjs";
const auth = tokenAuth(process.env.SESSION_SECRET);
const server = new ServerHost({ trustedKeys: [publisherPublicJwk], authenticate: auth.authenticate,
  capabilities: { charge: (arg) => callPaymentApi(arg, process.env.PAY_KEY) } });
await server.listen(7800);
server.subscribe("ws://localhost:7700", "demo.shared");   // follow the publisher

// on a client
import { connectServer } from "./host/remote-client.mjs";
connectServer(host, "ws://server:7800", { app: "demo.shared", token: auth.issue("alice", "demo.shared") });
```

Tests: `npm run test:hosts` (30 checks). What each open question in the spec turned out to be, with numbers: `docs/HOSTS.md`.

### Release channels behind a server host

A server host can follow a fleet controller on several channels at once (SPEC 10.5). Each channel gets its own release and server workers over the app's one store, clients behind the server name their channel, and releases that clients outside a partial rollout still run stay served.

```js
const server = new ServerHost({ authenticate: auth.authenticate, dataDir: "data", dataKey: dataKeyFrom({ command: "secret-tool lookup service llp" }),
  fleet: { keyring: pinnedKeyring, id: "srv-1" } });
await server.joinFleet("wss://fleet.example:7720", ["stable", "beta"]);
await server.listen(7800);
// on a client: its channel, a stable device id for rollout shares, and the app's keyring
connectServer(host, "wss://server:7800", { app, token, channel: "beta", id: deviceId, trust: new TrustStore(pinnedKeyring) });
```

Tests: `npm run test:channels` (15 checks).

### Personal data and encryption at rest

A manifest's signed `personal` field says which keys belong to which person (`"personal": ["server/profiles/"]` makes `server/profiles/alice/...` alice's). `server.exportUser(app, "alice")` and `server.eraseUser(app, "alice")` find, return or delete that data, with the person's call records and payment effects, and write a hash-chained audit entry; the person's devices clear their own copy. `llp export <app>` and `llp erase <app>` do the device side for the local service. With a data key (`dataKey` for the server host, `LLP_DATA_KEY_CMD`, `LLP_DATA_KEY_FILE` or `LLP_DATA_KEY` for `llpd`, `llp` and `fleet-host`), everything saved except public code is AES-256-GCM encrypted (SPEC section 13). Tests: `npm run test:privacy` (33 checks).

## Status

The run-anywhere hosts (SPEC section 10) are implemented and tested: see the section above and `docs/HOSTS.md`. Fleet operations (SPEC section 12) are implemented and tested. Every layer runs in its own worker with a time limit and a memory cap (SPEC section 6.1), so a layer stuck in an infinite loop is killed and reverted instead of freezing its host. Known v0 gaps are listed in SPEC section 11. A review of what a worldwide standard would still need, with severities and fixes, is in `docs/RED-TEAM.md`; `npm run redteam` re-checks the proven findings.
