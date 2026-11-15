# Live Layer Protocol (LLP) — v0 draft

Status: working draft, reference implementation in `host/llp-core.js`. Every rule below is exercised by `test/run.mjs` (section 6.1 by `test/sandbox.mjs`, section 10 by `test/hosts.mjs`, 10.5 by `test/channels.mjs`, section 12 by `test/fleet.mjs`, section 14 by `test/privacy.mjs` and `test/at-rest-hosts.mjs`). A second, independent host in Go (`impl/go`) and a shared conformance suite (`conformance/`) cover sections 3-9 and 12; see section 13 and `docs/CONFORMANCE.md`.

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
3. **Signed, monotonic manifests.** Only manifests signed by a trusted publisher key, for the host's own app, with a version greater than the running one and within range, are accepted. A host with no trusted keys refuses everything (fail closed).
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

Signature: ECDSA P-256 / SHA-256 over the **canonical JSON** of the manifest, sent alongside it. Hosts hold a list of trusted publisher public keys (JWK).

- **Canonical JSON** is RFC 8785 (JCS): object keys sorted by UTF-16 code units, no whitespace, strings escaped and numbers written exactly as ECMAScript `JSON.stringify` does (so `1.0` is `1`, `1e21` is `1e+21`, and only `"`, `\` and control characters are escaped). A member whose value is absent is left out. Documents must be I-JSON (RFC 7493): a string holding a lone UTF-16 surrogate has no canonical form, so a host refuses it. Duplicate keys: the last one wins.
- **Signature encoding:** the 64-byte IEEE P1363 form `r‖s` (32 bytes each, what WebCrypto emits), in standard base64. Writers pad; readers accept a missing pad. DER-encoded signatures are refused. There is no low-S rule.
- **Keys:** a JWK with `kty: "EC"`, `crv: "P-256"` and base64url `x` and `y` of 32 bytes each; other members are ignored. A point that isn't on the curve verifies nothing.

Each value in `layers` must be a lowercase hex SHA-256 (64 characters). `order`, when present, must be a list of slot names from `layers`. Otherwise the manifest is `malformed`.

`version` must be a positive safe integer (`Number.isSafeInteger`, at most 2^53 − 1). An optional `epoch` (a non-negative safe integer, default 0) orders releases ahead of `version`: manifests are compared as the pair `(epoch, version)`. A host accepts an epoch only up to the one it trusts: a fleet host's limit is the number of the keyring it holds (section 12.4), and a plain host's limit is 0. The epoch exists so that a key rotation can outrank any version a leaked key signed.

**Protocol version.** A manifest may carry `"llp": 1` (signed). A host refuses a manifest whose `llp` is newer than it implements. An LLP 1 manifest is strict:

- Every top-level field must be one the host understands: `llp`, `app`, `version`, `epoch`, `layers`, `order`, `hosts`, `keys`, `caps`, `private`, `personal` (section 14), `channel`, `rollout` and `overlap`. Optional extensions start with `x-` and may be ignored.
- It must declare `keys` (6.2) and `caps` (section 9), so state isolation and declared capabilities are the default.

A manifest without `llp` is v0, and unknown fields in it are ignored, as before. Hosts send `"llp": 1` in `hello`.

**Host configuration.** A host is created with its `app` name and its trusted keys. It refuses every manifest when the key list is empty, and refuses manifests for any other app from the very first one. The only way to run unsigned manifests is the explicit development mode `allowUnsigned: true` (used by the AI loop's shadow check and by tests), which logs a warning when the host starts.

## 5. Stream messages

Transport-agnostic JSON messages. Reference transports: WebSocket (Node host), BroadcastChannel / in-page (browser host). QUIC/WebTransport are natural next transports.

| Direction | Message |
|---|---|
| host → publisher | `{"t":"hello","app","version","have":[hash…]}` |
| publisher → host | `{"t":"manifest","manifest":{…},"sig":"…"}` |
| host → publisher | `{"t":"want","hashes":[…]}` |
| publisher → host | `{"t":"blob","hash","data":"<base64>"}` |
| host → publisher | `{"t":"ack","version","ms","running"?}` or `{"t":"nack","version","code","reason"}` |

`reason` is for people. `code` is for programs and names the step that refused the manifest:

| Code | Meaning (section 6 step) |
|---|---|
| `malformed` | not a manifest, a bad layer hash or `order`, an unknown placement, or bad `keys`, `caps`, `private` or `overlap` |
| `untrusted` | no trusted keys, a signature no trusted key made, or no pinned app (step 1) |
| `wrong_app` | a manifest for another app (step 1) |
| `protocol` | an `llp` newer than the host, or an LLP 1 manifest breaking its strict rules (section 4) |
| `bad_version` | `version` or `epoch` out of range, beyond the trusted epoch, or too far ahead (step 2) |
| `stale` | not newer than the running `(epoch, version)` (step 2) |
| `blob` | a blob missing, too big, or not matching its hash (step 3) |
| `layer_failed` | a layer failed to load, migrate or render, or broke a sandbox limit (steps 5-6) |

Fleet status reports (12.3) use the same codes, plus `channel` and `freshness`.

## 6. Swap algorithm (host)

1. Unless the host runs with `allowUnsigned: true`: reject if it has no trusted keys or no pinned app, then verify the signature against the trusted keys → else reject. Reject a manifest for a different app.
2. Version rules (anti-rollback/replay and anti-freeze): reject unless `version` is a positive safe integer and `epoch` (default 0) is a non-negative safe integer no higher than the host's trusted epoch; reject if `(epoch, version) ≤ (running epoch, running version)`; reject if `version` is more than one year of milliseconds (`MAX_VERSION_AHEAD_MS`) ahead of the larger of the running version (same epoch) and the host's clock. So small counters and millisecond timestamps both work, and one enormous version can't leave no higher version to publish. (A device whose clock is more than a year slow refuses timestamp versions; `maxVersionAheadMs` can be raised for such hosts.)
3. Fetch missing blobs; reject any whose SHA-256 ≠ declared hash.
4. Open a copy-on-write shadow of state (writes stay in the shadow; cost is proportional to keys written, not store size).
5. For each changed slot placed on this host (10.1), in sorted slot-name order (the order the signature covers; the order keys arrive in isn't signed): instantiate → if `llp_schema()` differs from the stored schema, call `llp_migrate(from)` → call `llp_view()` and require a balanced UI tree (a headless server layer may omit `llp_view`).
6. Any failure → reject the whole manifest; the running version is untouched.
7. Commit: swap slot pointers, keep previous versions for revert, replay the shadow's writes onto state, render. Slots render in `order`; without `order`, in sorted slot-name order. A blob that passed its hash check may be kept even if the manifest is refused at a later step (it is content-addressed).

### 6.1 Sandbox limits

The rule is the table below: each limit, and what happens when a layer breaks it. How a host enforces them is up to the host. The Go host (`impl/go`) runs each layer in its own wazero instance, stops a call at a context deadline and caps linear memory in the engine; the rest of this paragraph describes how the reference host does it.

Every layer instance lives in its own worker (a Web Worker in browsers, `worker_threads` in Node). The host keeps one worker booted in advance so a swap doesn't wait for one to start. Each worker keeps a replica of host state. The host keeps a change log, and each call carries only the keys that changed since that worker's last call; a worker that is new or fell more than 65,536 changes behind gets one full copy. The worker returns the UI tree, requested effects and the keys it wrote. The host applies those writes only if the call finished cleanly. (Sending the whole state with every call cost 157 ms per event at 100k keys and broke the 100 ms limit at 1M keys; with the log an event costs 0.5 ms at any size.)

| Limit | Default | Enforced by | On breach |
|---|---|---|---|
| Time per call (`llp_view`, `llp_event`, `llp_migrate`) | 100 ms; 1000 ms for the first call in a fresh worker, which also pays lazy compilation and often lands while the device is busy | host timer; the worker is terminated | killed, writes dropped, slot reverted (at swap time: manifest rejected) |
| Time to load (compile, instantiate, start function, `llp_schema`) | 2000 ms | host timer | killed, manifest rejected |
| Linear memory | 32 MB | the host rewrites the module's memory maximum before instantiating, so `memory.grow` fails and the layer traps | trap, writes dropped, slot reverted |
| UI nodes per call | 10,000 | worker-side ABI | trap |
| Worker JS heap | 64 MB | `resourceLimits` (Node only) | killed |

A revert never runs code against data in a schema it doesn't expect: a previous version whose `llp_schema()` differs from the stored `__schema.<slot>` is skipped, and the host tries the next older one. Layer downloads are capped at `limits.blobMb` (16 MB); a bigger blob rejects the manifest before it is hashed or run.

When a slot has no previous version to revert to (or none that matches the data's schema), the host restarts the same version in a fresh worker, so it keeps working for inputs that don't hit the bad path. A page whose security policy blocks workers falls back to running layers on its own thread, logs an error saying so, and loses time-limit protection. `limits: { isolation: "inline" }` opts into the same mode on purpose, for trusted code only, such as simulating hundreds of devices in one process (`bench/sim-hosts.mjs`).

Measured on Node 22 (Linux, 2 slots): a warm swap takes about 3 ms (was about 1 ms on the main thread); the first swap takes about 40 ms because it boots the first worker; a two-layer render takes 0.13 ms (was 0.015 ms); an event with its re-render takes 0.23 ms (was 0.02 ms); each worker costs about 12 MB of memory. A stuck layer is cut off about 105 ms after the call starts (about 1 s if the stuck call is its first one, as in a swap's health check), and the host's thread never stalls more than a few milliseconds while it runs. Chromium gives the same results (`test/browser.mjs`).

### 6.2 Per-slot keys

A manifest may declare which state keys each slot owns and which it may read:

```json
"keys": { "main": { "own": ["tasks.", "draft"] }, "footer": { "own": ["geo"], "read": ["tasks."] } }
```

Entries are key prefixes. Once a manifest declares `keys`, every slot in it needs an entry. Owned prefixes of different slots may not overlap (a key has one owner), and no prefix may cover `__schema.*`; otherwise the manifest is rejected. The field is inside the signature, so a share is the publisher's decision. A slot's worker replica holds only the keys under its `own` and `read` prefixes, so it can't see anything else. A write outside its `own` prefixes fails the call like a trap: nothing it wrote is kept, and the slot is reverted. The rules come from the manifest being committed, so a release can change them without changing code. Inputs bound to state (`bind`) are written by the host, not a layer, and aren't subject to them.

`__schema.<slot>` markers belong to the host: no layer may write a `__schema.*` key, with or without declared keys. Manifests without `keys` keep the v0 behaviour, in which all slots on a host share one key space. That is still the default, so isolation is opt-in until a protocol version makes it required (red-team GOV-01).

## 7. Layer ABI (v0)

Imports, module `llp` (strings are UTF-8 `(ptr, len)` in the layer's memory; reads into a layer-provided buffer `(buf, cap)` copy at most `cap` bytes and return the full length in bytes, so a layer can tell it was cut short). A string or buffer outside the layer's memory traps. Layers should pass valid UTF-8; a host replaces invalid sequences with U+FFFD. State values are numbers (f64) or strings; `kv_get_n` on a string or a missing key returns the default, and `kv_get_s` on a number returns it written as ECMAScript `Number::toString` does (`1`, `0.5`, `1e+21`).

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

Module `env` (imported by AssemblyScript and some C toolchains; a host must provide both):

| Import | Signature | Purpose |
|---|---|---|
| `abort` | `(msg, file, line, col)` (four i32) | the layer gave up: treated as a trap |
| `seed` | `() → f64` | a random seed |

Every call has a state view: a slot with declared keys (6.2) reads a missing value for any key outside its `own` and `read` prefixes. Writes are buffered and a call reads its own writes; they reach host state only if the call returns cleanly.

Exports:

| Export | Required | Purpose |
|---|---|---|
| `memory` | yes | linear memory |
| `llp_view()` | yes | build the UI for the current state |
| `llp_event()` | no | handle the current event |
| `llp_schema() → i32` | no | state schema version this layer expects |
| `llp_migrate(from: i32)` | no | convert state from an older schema |

## 8. UI vocabulary (v0)

`col`, `row`, `card`, `heading`, `label`, `big`, `button(id, style)`, `input(bind, placeholder, submit)`, `toggle(id, on)`, `progress(value)`, `text`. Inputs with `bind` write directly into host state.

**Tree form.** `ui_begin` adds an element `{"k": kind, "a": {attrs}, "c": [children]}` to the open element and opens it; `ui_attr` sets an attribute on the open element; `ui_text` adds `{"k": "text", "t": text}`; `ui_end` closes it. A call's output is the single top-level element if there is exactly one, otherwise a `{"k": "root", "a": {}, "c": [...]}` holding them. Text and elements both count toward the UI node limit (6.1). The host renders natively for its platform (DOM in browsers, text in the headless host) and diffs to preserve focus, scroll, and input contents across swaps.

The vocabulary is deliberately small in v0. The long-term direction is a typed component catalog plus a raw canvas/GPU surface for anything custom.

## 9. Capability tiers

1. **Standard capabilities** — defined by LLP, implemented by every host on every OS (v0 demo: `haptic`, `geo`).
2. **Capability providers** — native, separately trusted host plugins exposing a typed interface for specialized hardware or OS features.
3. **Raw device channels** — generic USB / HID / serial / BLE / MIDI passthrough behind a user permission, so new devices need no new provider.

**Declared capabilities.** A manifest may list the capabilities each slot needs: `"caps": { "main": ["haptic"], "pay": ["charge"] }`. The field is signed. Once a manifest declares `caps`, a slot can use only the capabilities listed for it, and a slot with no entry gets none. The host answers any other request with `error: not granted` and logs it, even for capabilities it offers. This applies on clients (`runCapability`) and on the server (a remote call's capability loop). A `caps` entry for a slot that isn't in the manifest rejects the manifest. Manifests without `caps` keep the v0 behaviour: every slot may use every capability the host offers. The AI loop's shadow check records which capabilities the old and the new version asked for while it used them, and the approval screen flags new ones above the model's own summary.

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
| client → server | `{"t":"hello","app","version","epoch"?,"have","token","watch"?,"channel"?,"keyring"?}` (the section 5 hello plus a token, the `shared/` prefixes to mirror, and the client's channel and keyring number, 10.5) |
| server → client | `{"t":"keyring","doc","sigs"}` for each keyring newer than the client's (10.5), then `{"t":"shared","full"?,"set":[[key,value]…],"del":[key…]}`, then `manifest` if the client's channel has a newer release than the client's `(epoch, version)` |
| client → server | `{"t":"call","id","idem","slot","op","args","version"}` |
| server → client | `{"t":"reply","id","ok":true,"value"}` or `{"t":"reply","id","ok":false,"error":{"code","message","serverVersion"?}}` |
| client → server | `{"t":"skip","version","reason"}`: the client is outside a release's rollout share and stays on its version (10.5) |
| client → server | `{"t":"privacy","id","op":"export"\|"erase"}`; answered by `{"t":"privacy","id","ok","value"\|"error"}` (section 14) |
| server → client | `{"t":"erased","app","at"}`: the signed-in user's data was erased; the client clears its own copy (section 14) |

Error codes: `bad_request` (malformed call; `args` over 64 KB), `unauthorized` (no or bad token), `not_found` (no such server slot in the caller's version), `version_mismatch` (with `serverVersion`), `layer_failed` (the server layer trapped or ran past its limit; the call's writes are dropped and the worker restarts on the same version; the slot is reverted, as in principle 6, only when calls from `revertAfterUsers` (default 3) different users fail on that version within `revertWindowMs` (default 60 s), so one user's input can't change the code everyone runs), `app_error` (the layer refused the input), `overloaded` (more than `maxPending`, default 256, calls queued for the tenant), `unavailable` (the result couldn't be saved, 10.3 rule 6; or a privacy request the server doesn't offer), `erased` (the call's record was erased with the user's data, section 14, so it is not run again).

**Auth.** `hello` carries a token; the server host's `authenticate(token, app)` returns a user id or refuses (`unauthorized`, then disconnect). The reference scheme is an HMAC-signed `{user, app, expiry}` token; any function with that shape can replace it. The server layer sees the call as `llp_event` with id `<op>` and value `<user>\n<args>`: the first line is always the authenticated user, never something the client sent.

**Replies.** A server layer answers by writing `__reply` (or `__error`, which becomes `app_error`). Those two keys belong to the call and are never stored. If the layer requests a capability (for example `charge`), the server runs it outside the tenant's queue and delivers the result as event `cap:<name>` to the same layer; the last `__reply` written wins. Up to 8 such hops per call. Each hop is its own transaction.

**Shared state.** Keys under `shared/` are owned by the server host. Clients hold a read cache that the server fills (`shared` messages) after every call and every migration; a client layer's writes to `shared/`, and inputs bound to `shared/` keys, are dropped and logged. Keys under any other prefix on the server (for example `server/`) never leave it. All other client keys stay client-local. No key has two owners. A client mirrors all of `shared/` by default, or only the prefixes it lists in `watch`.

**Read rules.** A manifest may mark `shared/` prefixes private: `"private": ["shared/users/"]`. Under such a prefix, the first path segment names the only user who may read the key, so `shared/users/alice/card` reaches only alice. The server host applies this when it sends the mirror on `hello` and on every update. When a release changes the rules, it rebuilds every client's mirror, so keys a user may no longer read are dropped. An operator can add a `canRead(user, key, app)` hook that narrows reads further. Server layers still see the whole tenant store. Private prefixes must start with `shared/`.

**Trust.** Server layers treat everything from a client as untrusted input. A client may be running modified layers or speaking the protocol by hand.

**Offline.** Calls made while offline wait in the client's outbox (up to `queueMs`, default 5 minutes, then the layer gets `error: offline`). On reconnect the client resends `hello` and then every unanswered call with its original `idem` id. The server remembers the result of the last 10,000 call ids per tenant (keyed by user), so a resent call returns the first result instead of running again. Conflicts don't arise as overwrites: a write is an operation the server layer applies to the current authoritative state, in arrival order.

### 10.3 Staying consistent

1. **Server commits first.** The server host relays manifest N to clients only after it has committed N, so server slots for N exist before any client calls them. If the server refuses N, it is never relayed and clients stay on N−1.
2. **Overlap window.** The server keeps the previous version's server workers running for `windowMs` (default 30 s) after committing N (a signed `"overlap"` in ms shortens it for that release; `"overlap": 0` retires older versions at once, for example for a security fix), so clients that haven't swapped yet keep working. A call from a version outside the window gets `version_mismatch`; the client asks for the latest manifest, swaps, and retries the call once with the new version.
3. **Expand/contract migrations.** `shared/` schema changes must stay readable by N−1 during the window; removals ship in a later version. Server migrations run against a copy-on-write shadow of the tenant's store (section 6, step 4), so verifying a migration costs O(keys written).
4. **Rollback is a new version.** A local revert (principle 6) is per-host and reported as `nack`. A client that refuses N stays on N−1 and works until the window closes; after that its calls fail with a clear `version_mismatch` until the publisher ships N+1 that it can run. Rolling back the app for everyone means publishing N+1 that points at the old hashes, keeping anti-rollback intact.

5. **Outside effects.** When a remote call has an `idem`, each capability it uses gets a stable `callId` (`user:idem#hop.n`), passed to the provider so an external API can deduplicate. The server records the effect as pending before it runs and as done, with its result, after. With `dataDir` the record is durable. A re-run of the call reuses a done effect's result, and a pending one (interrupted by a crash) runs again with the same `callId`.
6. **Durable server state.** A server host created with `dataDir` keeps each tenant's store, its idempotency records and its current release on disk (`host/server-store.mjs`). Every commit is one appended log line holding the keys it changed and the idempotency records of the calls it answers, written (and by default fsync'd) **before** the reply is sent. A periodic snapshot replaces the log. On start the host loads the snapshot, replays the log (ignoring a torn last line from a crash), re-verifies the stored manifest's signature and runs it on the restored state, before it accepts clients. A call retried after a restart with the same `idem` gets the recorded answer and doesn't run again. If a commit can't be written, the call gets `unavailable` and should be retried with the same `idem`. Without `dataDir` the host warns that its state is memory-only. Older versions' overlap windows are not restored: after a restart, clients on an older version get `version_mismatch` and update. Releases pinned by a partial rollout are restored (10.5). With a data key, everything but blobs is encrypted (14.4).

The window only affects latency, not correctness: with retry-on-mismatch a client that missed the window pays one extra round trip. Measured: relaying a server-only change to 40 clients takes about 20 ms; a change that also swaps the client slot takes 350 ms (p50) to 490 ms (max). The 30 s default is about 60 times the measured worst case.

### 10.4 Device hosts and pairing

A host that serves UI to other programs on the same device (the reference `service/llpd.mjs`) follows three rules:

1. **Trust is per app.** A publisher key is trusted for named apps (`trusted.json` is `{app: [keys]}`), so a teammate's key for one app can't update another. Keys under `"*"`, or an older file that is a plain list, are trusted for every app; the reference service still accepts that and warns.
2. **UI clients prove they are this user.** The UI page, its socket and the status endpoint need a token stored in a file only this user can read (`<data>/keys/ui-token`, mode 0600). `llp open` prints the link. Other local users and other sites can't connect.
3. **The UI sets only what it shows.** A UI client may set a state key only when that key is bound to an input on the current screen. Everything else changes through layer events.

Two devices pair by comparing a fingerprint (the first 80 bits of SHA-256 over the key's `x.y`, shown as five groups of four hex digits) on both screens. A host never trusts a new key without that confirmation, not even the first key it sees.

### 10.5 Release channels on the server host

Implemented in `host/server-host.mjs` (lanes, `joinFleet`) and `host/remote-client.mjs` (`channel`, `id`, `trust`); proven by `test/channels.mjs` (red-team FL-01).

1. **One lane per channel.** A server host keeps, per tenant, one lane for each channel it has a release for: the lane's committed release, its server workers, its overlap window and its pinned releases. Manifests without `channel` go to the no-channel lane, which is what a single-channel deployment uses. A tenant has at most 32 lanes. `version` is still one counter for the whole app (12.1), so a version names exactly one release of one channel.
2. **One store.** All lanes of a tenant share one state store, one call queue, the idempotency records and the effect records. A write on any channel is seen by every channel, and calls on different channels never interleave.
3. **Clients name their channel.** A client's `hello` carries `channel`. The server relays to it only that lane's releases and resolves its calls in that lane. A client host refuses a manifest whose `channel` differs from its own (as a fleet host does, 12.1), even when its own server sends it. Read rules (`private`, 10.2) come from the client's channel's release.
4. **Schema across channels.** A server migration on one channel migrates the shared data for every channel (it runs once, in that lane's shadow). Another channel whose code expects an older schema keeps running it on the migrated data: the expand/contract rule (10.3 rule 3) applies for as long as both channels are live, exactly as it does inside an overlap window. When a lane commits code whose `llp_schema` is older than the stored schema, and another lane of the tenant is running that slot with the stored schema, the lane joins the data without migrating and without lowering the stored marker; otherwise the release is refused as before. On restart, lanes are restored newest release first, so such a lane finds the lane that migrated already running.
5. **Rollout shares.** The server applies every share of a release, whatever its percent; its clients decide whether they are in it. A client computes its bucket from its device `id` (12.2) and applies a release below 100% only if it is in the share; otherwise it sends `skip` and stays on its version. A client without an `id` stays out of every partial share and gets each release at 100%. While a lane's release is below 100%, every older release of that lane that was still served when the share started stays served (pinned), past the overlap window, because clients outside the share can't move. When the share reaches 100% (a new full release, or the same version re-signed at 100%), the pinned releases close after the normal window. A signed `overlap: 0` closes them at once, even during a partial share.
6. **Re-signed releases.** A re-signed manifest of the version a lane runs is accepted only if it differs from the running one in `rollout` alone, and only if it verifies; it is then relayed to that lane's clients. That is how a widened share reaches clients behind the server.
7. **Joining a fleet.** `joinFleet(url, channels)` opens one fleet connection per channel, each a fleet agent (section 12) with the host id `<id>/<channel>`, all sharing the server's keyring and device key. The controller therefore sees the server host as one host per channel. Keyrings the server accepts are kept in its data dir and relayed to every client behind it, which checks each one against its own trusted root before using it (12.4). Re-signed releases in the new epoch follow.
8. **Persistence.** With `dataDir`, each lane's release and its pinned releases are saved (`releases.json`). On restart every one is re-verified against the trusted keys. Pinned releases' workers start on their first call.

## 11. Known gaps in v0 (deliberately deferred)

- Time limits are wall-clock, not CPU time, so a heavily loaded device can cut off a slow but honest layer. Limits are per host, not per layer or per manifest.
- State quotas are host-wide (`limits.maxKeys`, default 2,000,000 keys; `limits.maxValueKb`, default 256 KB per value; keys up to 1,024 characters). "Characters" and "KB" here count UTF-16 code units, as the reference host does. A call that would pass them fails like a trap. There are no per-slot quotas in the manifest.
- A killed layer's `log` output for that call is lost.
- Memory blowup is caught by the engine's memory cap, so the error says `unreachable` (plus the memory reading) rather than naming an out-of-memory condition.
- Layers on the same host can't call each other; they communicate only through shared state. Across hosts, a client layer calls a server layer with `remote` (10.2).
- Manifests carry one signature, so release keys are 1-of-n; only the root role (section 12.4) supports k-of-n thresholds. No delegation to per-team or per-slot keys yet. Fleet hosts can detect staleness with freshness notes (12.3.1), but plain hosts outside a fleet have no freshness check, and the note is signed by the release key rather than a separate timestamp key.
- Bespoke JSON-free ABI instead of the WebAssembly Component Model/WIT; the ABI is designed to map onto WIT once browser support lands.
- Fleet status reports (section 12.3) come from hosts that proved their device key, but their content is still the host's own word: fine for tracking and gating rollouts, not proof of what code a host runs.
- **Run-anywhere hosts (section 10), what's still open:**
  - Channels compose with the server host (10.5), but clients behind a server report only to the server (`ack`, `nack`, `skip`; `clientStatus()`), not to the fleet controller. The controller's convergence counts and gated rollouts see the server host itself, one host per channel, not the devices behind it. Freshness notes (12.3.1) are not relayed to those clients.
  - Every lane's pinned and current server workers stay loaded while they are used. A long partial rollout on several channels multiplies server workers; idle ones are stopped and restarted on demand, as for the current release.
  - A tenant's calls run one at a time (one writer on one store): 4,000 to 7,000 simple calls per second per tenant in our runs, and a long compute call holds up that tenant's other calls. Read-only or per-key concurrency is not built.
  - One worker per server layer per active tenant costs about 9 MB. Idle tenants give theirs back, but many simultaneously busy tenants need more machines, or many tenants sharing one worker.
  - A client mirroring all of a big `shared/` store runs out of worker memory around 1M keys; clients must `watch` narrower prefixes. Per-user read rules on `shared/` exist (10.2, `private`), but they are per-prefix ownership only, not general access control lists.
  - With `dataDir` the store and idempotency records survive a restart on the same machine (10.3 rule 5). Several server nodes for one tenant (replication, failover) are not built. Outside effects of calls without an `idem` have no record (10.3 rule 5).
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

Each host computes its bucket, `uint32(sha256(seed + "\n" + hostId)[0..4]) mod 10000` (the first four bytes, big-endian; the strings as UTF-8), and applies the manifest only if `bucket < floor(percent × 100 + 0.5)`. Hosts outside the share report `skipped` and keep running the previous release. Because the bucket is fixed per host and seed, widening a share only adds hosts. To widen, the controller re-signs the same version with a higher percent. Hosts already on that version have nothing to do; newly included hosts apply it. The default seed keeps the same canary hosts from release to release; set a per-release seed to rotate them. Narrowing a share can't take a release back from hosts that already run it: that is a rollback (10.3.4).

### 12.3 Convergence

Fleet messages travel next to the section 5 stream:

| Direction | Message |
|---|---|
| controller → host | `{"t":"challenge","nonce"}` (first message on every connection) |
| host → controller | `{"t":"hello","app","host","channel","version","keyring","have","auth":{"key","sig"}}` |
| controller → host | `{"t":"keyring","doc","sigs"}` (every keyring newer than the host's, oldest first), then the channel's current manifest |
| host → controller | `{"t":"status","host","channel","version","keyring","target","percent","state","reason"}` |

**Host identity.** Each host holds a device key (ECDSA P-256), kept with its other state (`fleet-host.mjs` stores it in its trust dir). `auth.sig` signs the canonical JSON of the hello without `auth`, plus `"nonce"`: the challenge of that connection, so a hello can't be replayed on another connection. Until a connection's hello verifies, the controller ignores its `status` and `want` messages and answers `{"t":"error","code":"unauthorized"}`. A host id is bound to one device key. With enrollment `tofu` (the default) the first key that proves itself for an id is bound for good. With `closed`, only ids registered with `enroll(id, key)` may join. A hello for a bound id with any other key is refused. A host may hold several authenticated connections at once. Each one gets every message, none replaces another, and the host is offline only when all have closed. Status reports count only from authenticated connections, so rollout gates and automatic rollbacks can't be steered by an impostor. Limit: with `tofu`, whoever first claims a new id owns it; use `closed` enrollment where install-time registration is possible. Messages are not encrypted or bound to the transport, so the link must use TLS (`wss:`) against an on-path attacker.

**Cost.** The controller keeps running counts per channel and updates them when a host's record changes. It recounts a channel only when that channel's target release or the keyring changes. A status report costs the same at any fleet size. Measured: one report from each of 32,000 hosts takes 0.3 s in total (it was 10.7 s with a full scan per report).

Status reports, and clients' `ack`/`nack`, carry `running: { slot: hash }`: the code each slot really runs, which differs from the manifest after a revert. `sweepOffline(maxOfflineMs)` retires hosts offline longer than the limit; `convergence()` counts them as `lost`, not `offline`, and a lost host that reconnects is tracked again.

`state` is `live`, `skipped` (outside the share), `rejected` (refused before going live), `reverted` (went live, then trapped and was reverted, principle 6), `keyring` or `keyring-rejected`. Manifests older than the running version are ignored without a report. For each channel the controller reports how many online hosts are live on the target version, held back, rejected (with reasons), reverted, still pending, or on an old keyring, plus how many are offline. A channel has **converged** when no online host is pending, rejected, reverted or on an old keyring, and, at 100%, none is held back. It is **complete** when it has converged and no known host is offline either; anything that is unsafe while two versions run side by side (a flag flip, a change in what a message means) should wait for complete, because a converged channel can still have a host on old code that is serving traffic but can't hear the controller. An offline host catches up when it reconnects, because `hello` is always answered with the missing keyrings and the current manifest.

**Gated rollouts.** `rollout(channel, layers, { steps: [5, 25, 50, 100], maxFailRate, soakMs })` publishes at the first step, waits until every online host has reported, lets runtime failures surface for `soakMs`, and computes the failure rate (rejected + reverted, over hosts that tried it). Above `maxFailRate` (default 0) it stops widening and publishes a rollback; otherwise it widens to the next step.

### 12.3.1 Freshness

The controller signs a short-lived note with the release key: `{"kind":"llp-freshness","app","channel","epoch","version","issued","expires"}`. It sends `{"t":"fresh","doc","sig"}` before the manifest on every `hello` and every publish, and re-issues it on a timer (`startFreshness()`, every third of `freshnessTtlMs`, which defaults to 24 h). A fleet host with freshness on (`freshness: { mode }`, or `--freshness` in `fleet-host.mjs`) keeps the newest valid note. It rejects a note with a bad signature, another app or channel, an expired time, or a keyring it doesn't hold. A relay can delay notes but can't forge or extend one. With a note held, the host refuses to install any release older than the one the note names, so an old release from a cache can't be its first. When the note expires, the host reports `freshness-expired` once. In `refuse` mode it also installs nothing while it holds no valid note. What a stale host does beyond that (warn the user, stop serving) is the embedder's choice. Freshness is off by default.

### 12.4 Keys and rotation

**Custody.** Root keys only sign keyrings and are kept offline. The controller never saves them next to the release key. A new controller exports them once (`--root-out`), and a rotation loads them only for the moment it signs. A controller without them refuses to rotate. Key files the tools write are owner-only (0600). OS keystores and hardware signers are not supported yet.

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
- A host must store its latest accepted keyring. `host/fleet-host.mjs` keeps it, with its device key, in a trust dir that defaults to `trust/` beside the pinned keyring (`--trust-dir` to move it). A saved file that exists but can't be read stops the host rather than letting it fall back to the pinned keyring. `--no-trust-dir` is for tests and throwaway hosts only: such a host trusts revoked keys again after a restart until it reconnects. `test/fleet.mjs` W6 and W7 show these cases.

The core's `trustedKeys` becomes the keyring's release keys; the agent also checks the signature itself before evaluating channel or share. The agent pins the host to the keyring's `app` and sets the host's trusted epoch to the keyring number.

- **Epochs:** the controller stamps every manifest with `epoch` = its current keyring number. On a release key rotation it re-signs each channel's current manifest with the new key and the new epoch. A host that a leaked key pushed to a high version therefore moves back to the real release as soon as it accepts the new keyring, and the leaked key's release is refused from then on (its key is no longer trusted).

## 13. Conformance

An implementation conforms when it passes the vectors in `conformance/vectors/` (canonical JSON, signatures, content addresses, rollout buckets, every manifest and version rule, swaps, migrations, reverts, sandbox limits, declared keys and capabilities, keyring chains and fleet decisions). The files are language-neutral JSON; `conformance/run-js.mjs` runs them against the reference host and `impl/go/cmd/llp-conformance` against the Go host. Both pass all 161 checks, and `test/interop-go.mjs` runs the Go host against the reference publisher and fleet controller over real sockets. What writing the second host found in this spec, and what is not covered yet (the server role of section 10 has one implementation so far), is in `docs/CONFORMANCE.md`.

## 14. Personal data and data at rest

Implemented in `host/server-host.mjs` (`exportUser`, `eraseUser`, `auditLog`), `host/remote-client.mjs` (`exportMine`, `eraseMine`), `service/llpd.mjs` (`/export`, `/erase`, `llp export|erase`) and `host/at-rest.mjs` (encryption); proven by `test/privacy.mjs` and `test/at-rest-hosts.mjs` (red-team PR-02, PR-03).

### 14.1 Whose data a key is

A manifest may declare `"personal": ["server/profiles/", "shared/users/"]`: key prefixes under which the first path segment names the person the key is about (`server/profiles/alice/email` is alice's). Each prefix ends in `/` and may not start with `__`; the field is signed, at most 64 prefixes. Prefixes listed in `private` (10.2) are personal too. The prefixes in force for a tenant are the union over every release it serves, on every channel, pinned ones included.

### 14.2 Export and erase on the server host

- **Export** returns, as one consistent snapshot taken in the tenant's call queue: every key under a personal prefix owned by the person, the recorded results of their calls (the idempotency records, keyed `user:idem`), and the outside effects of those calls (10.3 rule 5).
- **Erase** deletes the same set. The tenant's log is then replaced by a fresh snapshot, so no erased value stays in the log file. Clients that mirrored an erased key get it deleted (`shared` message), and the person's own connected clients get `erased`. Each erased call id leaves a tombstone, a SHA-256 of `user:idem`, so a retried call is answered `erased` instead of running a second time (a payment is not charged twice). Tombstones are kept like idempotency records (the last 10,000 per tenant).
- **Audit log.** Every export and erase appends `{ at, op, user, by, keys, calls, effects, prev }` to the tenant's audit log: who asked, for whom, and how much, never the data. `prev` is the SHA-256 of the previous entry, so a removed or edited line breaks the chain; `auditLog(app)` returns the entries and the chain check. The audit entry names the person, because a record of an erasure must say whose it was.
- **Who may ask.** The operator, through the API (`by` names who acted). Self-service over the client link (`privacy` messages) is off unless the server host is created with `selfService: true`; a signed-in user can then export or erase only their own data. The request carries no user field: the server uses the authenticated user.

### 14.3 On the device

A client's own state (every key except the `shared/` mirror and `__schema.*` markers) belongs to the device's user. On `erased`, a client clears it by default (`onErased` overrides that), and saving the cleared state is up to the embedder as for any change. `exportMine()` and `eraseMine()` on a client link cover the server and the device together. The device service exposes the same for each app: `GET /export` and `POST /erase` with the UI token, and `llp export <app>`, `llp erase <app>`.

### 14.4 Encryption at rest

A data key is 32 random bytes. Every saved record is sealed with AES-256-GCM as `"LLPE1." + base64url(iv[12] | ciphertext | tag[16])`, with associated data naming where it belongs (for example `llp/server/<app>/log`), so a record moved to another file or tenant fails to open, and a changed byte is an error, not different data. Each log line is sealed on its own, so a torn last line from a crash is still dropped, while a bad line before it stops the start.

- **What is sealed.** Server host: each tenant's snapshot, log, releases and audit log, and its fleet keyring, keyring chain and device key. Device service: each app's state and release, and the device's publisher key. Fleet host: its device key and saved keyring. **What stays plain:** blobs (code that anyone on the stream may fetch; their hash proves them), tenant and app names, the device service's list of trusted public keys and its UI token file (0600).
- **Where the key comes from.** Never from beside the data. `dataKeyFrom` takes it from an environment variable, a file only the owner can read (other-readable files are refused), or a command that prints it; the command is how an OS keystore is reached (`secret-tool lookup …` on Linux, `security find-generic-password … -w` on macOS, a DPAPI one-liner on Windows). The command-line hosts read `LLP_DATA_KEY`, `LLP_DATA_KEY_FILE` or `LLP_DATA_KEY_CMD`.
- **Starting.** A `keycheck` record tells a wrong key from damage. A host refuses to start on sealed data without its key or with another key, and never reads sealed data as plain. Starting with a key on plaintext data seals it. A server host started with `dataKey` and `previousDataKeys` re-seals everything under the new key; afterwards the old key is refused.

### 14.5 Gaps

- Export and erase find data only by key prefix. Data a layer copies elsewhere (for example the person's id inside a shared list, or inside another person's keys) is not found; the export says so. Server layers can't yet be asked to scrub their own copies.
- Replacing the log removes erased values from the files, but not from disk blocks, backups or replicas that already hold them. Per-person keys (crypto-shredding) are not built.
- The server host's in-memory log (`history`, `onLog`) can name users; it is the embedder's to keep or drop.
- Browsers' saved state (`localStorage` in the web demo) is not encrypted: a page has no OS keystore to hold the key.
- Sensitive values are encrypted with the rest of the store; there is no per-key marking, and layers see plaintext while they run.
- OS keystores are reached through a command the operator sets up; the reference code doesn't talk to keystore APIs or hardware keys itself, and only the command path is tested (with a stand-in command), not a real keystore.

