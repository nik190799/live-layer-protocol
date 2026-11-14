# Live Layer Protocol (LLP) — v0 draft

Status: working draft, reference implementation in `host/llp-core.js`. Every rule below is exercised by `test/run.mjs`, except section 10 (run-anywhere hosts), which is design only and not yet implemented or tested.

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
6. **Transactional events.** If a layer traps while handling an event, state is restored and the layer is reverted to its previous version.
7. **Capabilities are requested, never assumed.** Layers ask the host for effects (haptics, location, network…); the host decides and answers asynchronously.
8. **Same layer, any host.** The client is the primary host: swap, shadow verification and rollback run on-device. The same layers and the same Live Host also run on server/edge nodes for work a client can't be trusted with or can't fit. Where a slot runs is a manifest field, not a rewrite.

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
4. Copy state into a shadow store.
5. For each changed slot: instantiate → if `llp_schema()` differs from the stored schema, call `llp_migrate(from)` → call `llp_view()` and require a balanced UI tree.
6. Any failure → reject the whole manifest; the running version is untouched.
7. Commit: swap slot pointers, keep previous versions for revert, replace state with the shadow store, render.

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

## 10. Hosts: run anywhere (design, not yet implemented)

**Client host (primary).** Runs the swap engine, shadow verification and rollback on-device (sections 3 and 6). Owns UI, local state and device capabilities, and keeps working offline.

**Server/edge host.** The same Live Host, headless (no UI tree required). Used only where the client is the wrong place:

| Need | Why not the client |
|---|---|
| Shared, multi-user data | One authoritative store per app/tenant; a client can't arbitrate other users' writes. |
| Secrets and payments | API keys live in server-side capability providers; they never reach a layer's bytes or a device. |
| Heavy compute | Large models and big jobs don't fit on a phone. |

**Authority** is a publisher role, not a layer host. It holds the signing keys and decides the canonical version. Keys never sit on a node that runs layers.

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

`version` is app-wide. Each host verifies the whole manifest but fetches and instantiates only the slots placed on it (`any` = either host may run it).

### 10.2 Talking across hosts

- **Calls:** a client layer calls a server slot through a standard capability, `cap("remote", "<slot>:<op> <json>")`; the reply arrives as event `cap:remote`. Every call carries the caller's manifest version.
- **Shared state:** keys under `shared/` are owned by the server host. Clients hold a read cache and send writes as requests; all other keys stay client-local. No key has two owners.
- **Trust:** server layers treat everything from a client as untrusted input. A client may be running modified layers.

### 10.3 Staying consistent

1. **Server commits first.** Clients receive manifest N only after the server host has committed it, so server slots for N exist before any client calls them.
2. **Overlap window.** The server keeps version N−1 of its slots live for a window, so clients that haven't swapped yet keep working. A call from a version outside the window gets `version_mismatch`, and the client fetches the latest manifest.
3. **Expand/contract migrations.** `shared/` schema changes must stay readable by N−1 during the window; removals ship in a later version.
4. **Rollback is a new version.** A local revert (principle 6) is per-host and reported as `nack`. Rolling back the app for everyone means publishing N+1 that points at the old hashes, keeping anti-rollback intact.

## 11. Known gaps in v0 (deliberately deferred)

- Layers run on the host's main thread; an infinite loop can freeze the host. Fix: run layers in a worker with a time budget.
- No inter-layer calls; layers communicate only through shared state.
- Single publisher key; no key rotation, delegation, or threshold signing (TUF roles cover this).
- Bespoke JSON-free ABI instead of the WebAssembly Component Model/WIT; the ABI is designed to map onto WIT once browser support lands.
- Fleet features (channels, percentage rollouts, convergence reporting) are not implemented.
- **Run-anywhere hosts (section 10) are unproven.** None of these points are implemented or tested yet; each is an open question:
  - No commit spans client and server. Whether "server first + overlap window" is enough, and how long the window must be, is unverified.
  - Shadow-copying a large multi-user store to verify a migration (section 6, step 4) may not scale; how to verify server migrations is open.
  - Offline clients: whether `shared/` writes queue or fail, and how conflicts resolve, is undecided.
  - Server nodes run many tenants' layers. They need per-tenant sandboxes and CPU/memory limits; the main-thread gap above is worse there.
  - The `remote` capability's wire format, auth (which user is calling) and error model are not specified.
  - Key custody for the authority role (HSM, rotation) is not specified.
