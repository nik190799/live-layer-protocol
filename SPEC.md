# Live Layer Protocol (LLP) — v0 draft

Status: working draft, reference implementation in `host/llp-core.js`. Every rule below is exercised by `test/run.mjs` (section 6.1 by `test/sandbox.mjs`, section 10 by `test/hosts.mjs`, section 12 by `test/fleet.mjs`).

## 1. Goal

Ship code into a **running** application as a stream of small, signed, content-addressed layers. The app updates in place, in milliseconds, without losing state, on any OS, from any source language. No build-release-deploy pipeline; verification happens at the moment a layer arrives.

## 2. Roles

| Role | What it is |
|---|---|
| **Layer** | A WebAssembly module (any source language) that implements the LLP ABI. Stateless. |
| **Live Host** | The runtime that runs layers. Primarily per-device (OS service, app shell, or browser page); the same runtime also runs headless on server and edge nodes (section 10). Owns state, permissions, rendering, and the swap engine. |
| **Publisher** | A human or AI agent that compiles layers, signs manifests, and streams them. |
| **Layer store** | Any content-addressed blob source: registry, CDN, peer, or the publisher itself. |

## 3. Core principles

1. **State lives in the host, never in a layer.** Layers read and write a host-owned key/value store. Swapping code therefore cannot lose state.
2. **Content addressing.** A layer is identified by the SHA-256 of its bytes. Hosts fetch only hashes they don't already hold.
3. **Signed, monotonic manifests.** Only manifests signed by a trusted publisher key, with a version greater than the running one, are accepted.
4. **Verify before live.** A new layer is instantiated in a shadow copy of state, migrated, and rendered once. Only a clean result is committed.
5. **All-or-nothing commits.** A manifest that changes several layers commits all of them or none.
6. **Transactional events.** If a layer traps or breaks a sandbox limit while handling an event, nothing it wrote is kept and the layer is reverted to its previous version.
7. **Capabilities are requested, never assumed.** Layers ask the host for effects (haptics, location, network…); the host decides and answers asynchronously.
8. **Same layer, any host.** The client is the primary host: swap, shadow verification and rollback run on-device. The same layers and the same Live Host also run on server/edge nodes for work a client can't be trusted with or can't fit. Where a slot runs is a manifest field, not a rewrite.
9. **Layers never run on the host's thread.** Each layer instance runs in its own worker with a time limit and a memory cap (section 6.1). A layer that breaks a limit is killed and treated like a trap.

## 4. Manifest

```json
{
  "app": "demo.tasks",
  "version": 2,
  "layers": { "main": "<sha256>", "footer": "<sha256>" },
  "order": ["main", "footer"]
}
```

Signature: ECDSA P-256 / SHA-256 over the **canonical JSON** (sorted keys, no whitespace), base64-encoded, sent alongside the manifest. Hosts hold a list of trusted publisher public keys (JWK).

## 5. Stream messages

Transport-agnostic JSON messages. Reference transports: WebSocket (Node host), BroadcastChannel / in-page (browser host). QUIC/WebTransport are natural next transports.

| Direction | Message |
|---|---|
| host → publisher | `{"t":"hello","app","version","have":[hash…]}` |
| publisher → host | `{"t":"manifest","manifest":{…},"sig":"…"}` |
| host → publisher | `{"t":"want","hashes":[…]}` |
| publisher → host | `{"t":"blob","hash","data":"<base64>"}` |
| host → publisher | `{"t":"ack","version","ms"}` or `{"t":"nack","version","reason"}` |

## 6. Swap algorithm (host)

1. Verify signature against trusted keys → else reject.
2. Reject if `version ≤ running version` (anti-rollback/replay).
3. Fetch missing blobs; reject any whose SHA-256 ≠ declared hash.
4. Open a copy-on-write shadow of state (writes stay in the shadow; cost is proportional to keys written, not store size).
5. For each changed slot placed on this host (10.1): instantiate → if `llp_schema()` differs from the stored schema, call `llp_migrate(from)` → call `llp_view()` and require a balanced UI tree (a headless server layer may omit `llp_view`).
6. Any failure → reject the whole manifest; the running version is untouched.
7. Commit: swap slot pointers, keep previous versions for revert, replay the shadow's writes onto state, render.

### 6.1 Sandbox limits

Every layer instance lives in its own worker (a Web Worker in browsers, `worker_threads` in Node). The host keeps one worker booted in advance so a swap doesn't wait for one to start. Each worker keeps a replica of host state. The host keeps a change log, and each call carries only the keys that changed since that worker's last call; a worker that is new or fell more than 65,536 changes behind gets one full copy. The worker returns the UI tree, requested effects and the keys it wrote. The host applies those writes only if the call finished cleanly. (Sending the whole state with every call cost 157 ms per event at 100k keys and broke the 100 ms limit at 1M keys; with the log an event costs 0.5 ms at any size.)

| Limit | Default | Enforced by | On breach |
|---|---|---|---|
| Time per call (`llp_view`, `llp_event`, `llp_migrate`) | 100 ms; 1000 ms for the first call in a fresh worker, which also pays lazy compilation and often lands while the device is busy | host timer; the worker is terminated | killed, writes dropped, slot reverted (at swap time: manifest rejected) |
| Time to load (compile, instantiate, start function, `llp_schema`) | 2000 ms | host timer | killed, manifest rejected |
| Linear memory | 32 MB | the host rewrites the module's memory maximum before instantiating, so `memory.grow` fails and the layer traps | trap, writes dropped, slot reverted |
| UI nodes per call | 10,000 | worker-side ABI | trap |
| Worker JS heap | 64 MB | `resourceLimits` (Node only) | killed |

When a slot has no previous version to revert to, the host restarts the same version in a fresh worker, so it keeps working for inputs that don't hit the bad path. A page whose security policy blocks workers falls back to running layers on its own thread, logs an error saying so, and loses time-limit protection. `limits: { isolation: "inline" }` opts into the same mode on purpose, for trusted code only, such as simulating hundreds of devices in one process (`bench/sim-hosts.mjs`).

Measured on Node 22 (Linux, 2 slots): a warm swap takes about 3 ms (was about 1 ms on the main thread); the first swap takes about 40 ms because it boots the first worker; a two-layer render takes 0.13 ms (was 0.015 ms); an event with its re-render takes 0.23 ms (was 0.02 ms); each worker costs about 12 MB of memory. A stuck layer is cut off about 105 ms after the call starts (about 1 s if the stuck call is its first one, as in a swap's health check), and the host's thread never stalls more than a few milliseconds while it runs. Chromium gives the same results (`test/browser.mjs`).

## 7. Layer ABI (v0)

Imports, module `llp` (strings are UTF-8 `(ptr, len)` in the layer's memory; reads into a layer-provided buffer return the full length):

| Import | Signature | Purpose |
|---|---|---|
| `ui_begin` | `(kind)` | open a UI element |
| `ui_attr` | `(key, value)` | set an attribute on the open element |
| `ui_text` | `(text)` | add a text child |
| `ui_end` | `()` | close the open element |
| `kv_get_n` / `kv_set_n` | `(key, default) → f64` / `(key, f64)` | numeric state |
| `kv_get_s` / `kv_set_s` | `(key, buf, cap) → len` / `(key, value)` | string state |
| `ev_id` / `ev_val` | `(buf, cap) → len` | current event id / value |
| `cap` | `(name, arg) → request id` | request a capability; result arrives as event `cap:<name>` |
| `log` | `(text)` | diagnostics |
| `now` | `() → f64` | wall clock, ms |

Exports:

| Export | Required | Purpose |
|---|---|---|
| `memory` | yes | linear memory |
| `llp_view()` | yes | build the UI for the current state |
| `llp_event()` | no | handle the current event |
| `llp_schema() → i32` | no | state schema version this layer expects |
| `llp_migrate(from: i32)` | no | convert state from an older schema |

## 8. UI vocabulary (v0)

`col`, `row`, `card`, `heading`, `label`, `big`, `button(id, style)`, `input(bind, placeholder, submit)`, `toggle(id, on)`, `progress(value)`, `text`. Inputs with `bind` write directly into host state. The host renders natively for its platform (DOM in browsers, text in the headless host) and diffs to preserve focus, scroll, and input contents across swaps.

The vocabulary is deliberately small in v0. The long-term direction is a typed component catalog plus a raw canvas/GPU surface for anything custom.

## 9. Capability tiers

1. **Standard capabilities** — defined by LLP, implemented by every host on every OS (v0 demo: `haptic`, `geo`).
2. **Capability providers** — native, separately trusted host plugins exposing a typed interface for specialized hardware or OS features.
3. **Raw device channels** — generic USB / HID / serial / BLE / MIDI passthrough behind a user permission, so new devices need no new provider.

## 10. Hosts: run anywhere

Implemented in `host/server-host.mjs` (server/edge host) and `host/remote-client.mjs` (client link); proven by `test/hosts.mjs` (30 checks) and measured by `bench/hosts.mjs` (results in `docs/HOSTS.md`).

**Client host (primary).** Runs the swap engine, shadow verification and rollback on-device (sections 3 and 6). Owns UI, local state and device capabilities, and keeps working offline.

**Server/edge host.** The same Live Host core with `role: "server"`: headless (`llp_view` optional, nothing rendered). Used only where the client is the wrong place:

| Need | Why not the client |
|---|---|
| Shared, multi-user data | One authoritative store per app/tenant; a client can't arbitrate other users' writes. |
| Secrets and payments | API keys live in server-side capability providers; they never reach a layer's bytes or a device. |
| Heavy compute | Big jobs don't fit a client's 100 ms call budget or a phone's memory. |

**Authority** is a publisher role, not a layer host. It holds the signing keys and decides the canonical version. Keys never sit on a node that runs layers: the server host is configured with public keys only, and relays manifests it cannot alter (clients check the signature and every blob hash themselves).

**Tenants.** Each `app` is a tenant with its own state, its own layer workers, its own limits and its own call queue. Server limits default to 1000 ms per call, 128 MB linear memory and 512 MB worker heap (client: 100 ms, 32 MB, 64 MB). A server host keeps no spare worker, and stops a tenant's workers after `idleMs` (default 120 s) without calls; the next call restarts them (about 35 ms).

### 10.1 One manifest stream

Both host types subscribe to the same signed, monotonic stream. An optional `hosts` field places each slot; omitted means `client`:

```json
{
  "app": "demo.tasks",
  "version": 3,
  "layers": { "main": "<sha256>", "sync": "<sha256>", "pay": "<sha256>" },
  "order": ["main"],
  "hosts": { "main": "client", "sync": "server", "pay": "server" }
}
```

`version` is app-wide. Each host verifies the whole manifest but fetches and instantiates only the slots placed on it (`any` = either host may run it). An unknown placement rejects the manifest. In the reference deployment clients connect to the server host, which follows the publisher (section 5 messages) and relays the stream and the blobs to its clients.

### 10.2 Talking across hosts

**Calls.** A client layer calls a server slot with the standard capability `cap("remote", "<slot>:<op> <args>")`; `args` is an opaque string (JSON by convention). The reply arrives as event `cap:remote`, with the reply string as value or `error: <code>: <message>`.

Wire messages, next to the section 5 stream on the client ↔ server link:

| Direction | Message |
|---|---|
| client → server | `{"t":"hello","app","version","have","token","watch"?}` (the section 5 hello plus a token and the `shared/` prefixes to mirror) |
| server → client | `{"t":"shared","full"?,"set":[[key,value]…],"del":[key…]}`, then `manifest` if newer than the client's |
| client → server | `{"t":"call","id","idem","slot","op","args","version"}` |
| server → client | `{"t":"reply","id","ok":true,"value"}` or `{"t":"reply","id","ok":false,"error":{"code","message","serverVersion"?}}` |

Error codes: `bad_request` (malformed call; `args` over 64 KB), `unauthorized` (no or bad token), `not_found` (no such server slot in the caller's version), `version_mismatch` (with `serverVersion`), `layer_failed` (the server layer trapped or ran past its limit; it is reverted as in principle 6), `app_error` (the layer refused the input), `overloaded` (more than `maxPending`, default 256, calls queued for the tenant).

**Auth.** `hello` carries a token; the server host's `authenticate(token, app)` returns a user id or refuses (`unauthorized`, then disconnect). The reference scheme is an HMAC-signed `{user, app, expiry}` token; any function with that shape can replace it. The server layer sees the call as `llp_event` with id `<op>` and value `<user>\n<args>`: the first line is always the authenticated user, never something the client sent.

**Replies.** A server layer answers by writing `__reply` (or `__error`, which becomes `app_error`). Those two keys belong to the call and are never stored. If the layer requests a capability (for example `charge`), the server runs it outside the tenant's queue and delivers the result as event `cap:<name>` to the same layer; the last `__reply` written wins. Up to 8 such hops per call. Each hop is its own transaction.

**Shared state.** Keys under `shared/` are owned by the server host. Clients hold a read cache that the server fills (`shared` messages) after every call and every migration; a client layer's writes to `shared/`, and inputs bound to `shared/` keys, are dropped and logged. Keys under any other prefix on the server (for example `server/`) never leave it. All other client keys stay client-local. No key has two owners. A client mirrors all of `shared/` by default, or only the prefixes it lists in `watch`.

**Trust.** Server layers treat everything from a client as untrusted input. A client may be running modified layers or speaking the protocol by hand.

**Offline.** Calls made while offline wait in the client's outbox (up to `queueMs`, default 5 minutes, then the layer gets `error: offline`). On reconnect the client resends `hello` and then every unanswered call with its original `idem` id. The server remembers the result of the last 10,000 call ids per tenant (keyed by user), so a resent call returns the first result instead of running again. Conflicts don't arise as overwrites: a write is an operation the server layer applies to the current authoritative state, in arrival order.

### 10.3 Staying consistent

1. **Server commits first.** The server host relays manifest N to clients only after it has committed N, so server slots for N exist before any client calls them. If the server refuses N, it is never relayed and clients stay on N−1.
2. **Overlap window.** The server keeps the previous version's server workers running for `windowMs` (default 30 s) after committing N, so clients that haven't swapped yet keep working. A call from a version outside the window gets `version_mismatch`; the client asks for the latest manifest, swaps, and retries the call once with the new version.
3. **Expand/contract migrations.** `shared/` schema changes must stay readable by N−1 during the window; removals ship in a later version. Server migrations run against a copy-on-write shadow of the tenant's store (section 6, step 4), so verifying a migration costs O(keys written).
4. **Rollback is a new version.** A local revert (principle 6) is per-host and reported as `nack`. A client that refuses N stays on N−1 and works until the window closes; after that its calls fail with a clear `version_mismatch` until the publisher ships N+1 that it can run. Rolling back the app for everyone means publishing N+1 that points at the old hashes, keeping anti-rollback intact.

The window only affects latency, not correctness: with retry-on-mismatch a client that missed the window pays one extra round trip. Measured: relaying a server-only change to 40 clients takes about 20 ms; a change that also swaps the client slot takes 350 ms (p50) to 490 ms (max). The 30 s default is about 60 times the measured worst case.

## 11. Known gaps in v0 (deliberately deferred)

- Time limits are wall-clock, not CPU time, so a heavily loaded device can cut off a slow but honest layer. Limits are per host, not per layer or per manifest.
- A layer can still grow the shared state without bound across many events; there is no quota on state size.
- A killed layer's `log` output for that call is lost.
- Memory blowup is caught by the engine's memory cap, so the error says `unreachable` (plus the memory reading) rather than naming an out-of-memory condition.
- Layers on the same host can't call each other; they communicate only through shared state. Across hosts, a client layer calls a server layer with `remote` (10.2).
- Manifests carry one signature, so release keys are 1-of-n; only the root role (section 12.4) supports k-of-n thresholds. No delegation to per-team or per-slot keys yet. Keyrings don't expire, so a host cut off from the controller isn't told it is stale (TUF's freeze-attack defence).
- Bespoke JSON-free ABI instead of the WebAssembly Component Model/WIT; the ABI is designed to map onto WIT once browser support lands.
- Fleet status reports (section 12.3) are the host's own word and are unauthenticated. They are fine for tracking and gating rollouts, never for security decisions.
- **Run-anywhere hosts (section 10), what's still open:**
  - Channels (12.1) and the server host don't compose yet. The server keeps only the current version and the previous one (for the window), so if beta clients run v8 while stable clients run v7, stable clients' calls get `version_mismatch` once the window closes. The server needs to keep every channel's current server slots live.
  - A tenant's calls run one at a time (one writer on one store): 4,000 to 7,000 simple calls per second per tenant in our runs, and a long compute call holds up that tenant's other calls. Read-only or per-key concurrency is not built.
  - One worker per server layer per active tenant costs about 9 MB. Idle tenants give theirs back, but many simultaneously busy tenants need more machines, or many tenants sharing one worker.
  - A client mirroring all of a big `shared/` store runs out of worker memory around 1M keys; clients must `watch` narrower prefixes. There is no per-user read access control on `shared/`: every authenticated user of an app can read everything they watch.
  - The idempotency cache and the shared store live in one server process's memory. Several server nodes for one tenant (replication, failover, durable storage) are not built.
  - Queued offline calls are retried once after a version change. If the op's meaning changed between versions, the new server code decides; expand/contract (10.3) is what makes that safe.
  - Key custody for the authority role (HSM, threshold signing of manifests) is not specified beyond section 12.4.
  - Time limits are wall-clock, so a heavily loaded server can cut off an honest slow call.

## 12. Fleet operations

Implemented in `host/fleet.js` (host side, browser and Node) and `tools/fleet.mjs` (controller); proven by `test/fleet.mjs`. The core (section 6) is unchanged: the fleet layer decides *whether* a host applies a manifest, and the core still verifies everything before it goes live.

### 12.1 Channels

A manifest may carry `"channel": "<name>"`. A fleet host belongs to exactly one channel and refuses manifests for any other, including ones with no channel. The field is inside the signature, so a valid beta manifest can't be replayed onto stable hosts, and editing it breaks the signature. `version` stays one counter for the whole app, across channels.

### 12.2 Percentage rollouts

```json
{ "app": "demo.tasks", "channel": "stable", "version": 7, "layers": {...}, "order": [...],
  "rollout": { "percent": 25, "seed": "demo.tasks/stable" } }
```

Each host computes its bucket, `uint32(sha256(seed + "\n" + hostId)[0..4]) mod 10000`, and applies the manifest only if `bucket < percent × 100`. Hosts outside the share report `skipped` and keep running the previous release. Because the bucket is fixed per host and seed, widening a share only adds hosts. To widen, the controller re-signs the same version with a higher percent. Hosts already on that version have nothing to do; newly included hosts apply it. The default seed keeps the same canary hosts from release to release; set a per-release seed to rotate them. Narrowing a share can't take a release back from hosts that already run it: that is a rollback (10.3.4).

### 12.3 Convergence

Fleet messages travel next to the section 5 stream:

| Direction | Message |
|---|---|
| host → controller | `{"t":"hello","app","host","channel","version","keyring","have"}` |
| controller → host | `{"t":"keyring","doc","sigs"}` (every keyring newer than the host's, oldest first), then the channel's current manifest |
| host → controller | `{"t":"status","host","channel","version","keyring","target","percent","state","reason"}` |

`state` is `live`, `skipped` (outside the share), `rejected` (refused before going live), `reverted` (went live, then trapped and was reverted, principle 6), `keyring` or `keyring-rejected`. Manifests older than the running version are ignored without a report. For each channel the controller reports how many online hosts are live on the target version, held back, rejected (with reasons), reverted, still pending, or on an old keyring, plus how many are offline. A channel has **converged** when no online host is pending, rejected, reverted or on an old keyring, and, at 100%, none is held back. An offline host catches up when it reconnects, because `hello` is always answered with the missing keyrings and the current manifest.

**Gated rollouts.** `rollout(channel, layers, { steps: [5, 25, 50, 100], maxFailRate, soakMs })` publishes at the first step, waits until every online host has reported, lets runtime failures surface for `soakMs`, and computes the failure rate (rejected + reverted, over hosts that tried it). Above `maxFailRate` (default 0) it stops widening and publishes a rollback; otherwise it widens to the next step.

### 12.4 Keys and rotation

Two roles, after TUF:

- **Root** keys (k-of-n, kept offline) sign only keyrings.
- **Release** keys sign manifests (section 4, one signature).

```json
{ "app": "demo.tasks", "keyring": 3,
  "root": { "keys": [<jwk>, <jwk>, <jwk>], "threshold": 2 },
  "release": { "keys": [<jwk>] } }
```

Signatures go alongside the document as `[{ "kid", "sig" }]`, where `kid` is the first 16 hex characters of SHA-256 over the canonical `{crv,kty,x,y}` of the key. A host is installed with a pinned keyring and accepts keyring n+1 only if (1) its number is exactly one higher, (2) it is signed by a threshold of the *current* root, and (3) if it changes the root, it is also signed by a threshold of the *new* root. Each step is therefore checked against keys the host already trusts, and a host that missed several rotations walks the chain in order.

- **Release key rotation:** keyring n+1 lists only the new key. The controller sends it to every host, then re-signs every channel's current manifest with the new key (same version, so hosts already on it do nothing). The old key is revoked the moment a host accepts the keyring. A leaked release key can't issue keyrings.
- **Root rotation:** keyring n+1 with a new `root`, signed by old and new roots. Afterwards the old root keys can't issue keyrings.
- A host must store its latest accepted keyring (`host/fleet-host.mjs --trust-dir`). One that restarts from the pinned keyring trusts revoked keys again until it reconnects to the controller. `test/fleet.mjs` W6 shows both cases.

The core's `trustedKeys` becomes the keyring's release keys; the agent also checks the signature itself before evaluating channel or share.
