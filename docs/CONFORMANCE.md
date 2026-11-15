# Conformance: a second, independent implementation

LLP now has two hosts that share no code:

| | Reference host | Second host |
|---|---|---|
| Language | JavaScript (browsers and Node) | Go |
| Code | `host/llp-core.js`, `host/fleet.js` | `impl/go/llp/` |
| WebAssembly engine | V8, one worker per layer | wazero (pure Go), one sandboxed instance per layer |
| Time limits | worker killed by a timer | context deadline; the instance is closed |
| Memory cap | the module's memory maximum is rewritten | engine page limit, plus a load-time check of the module's initial memory |
| CLI | `host/node-host.mjs`, `host/fleet-host.mjs` | `impl/go/cmd/llp-host` (both modes in one binary) |

The Go host was written from `SPEC.md`, not ported from the JavaScript. Where the spec didn't say enough to write it, that gap is listed below and the spec now says it.

## Running it

```
npm run test:conformance     # the vectors against the JS reference host
npm run test:go              # the vectors against the Go host, then the over-the-wire interop test
```

`npm run test:go` needs Go 1.24 or newer. Its two parts can also run alone:

```
cd impl/go && go run ./cmd/llp-conformance ../../conformance
node test/interop-go.mjs
```

## The vectors

`conformance/vectors/` holds language-neutral JSON. A host passes when its runner reports every check passing. Both runners (`conformance/run-js.mjs` and `impl/go/cmd/llp-conformance`) read the same files.

| File | What it covers | Checks |
|---|---|---|
| `canonical.json` | Canonical JSON: key order by UTF-16 code units, ECMAScript number formatting, string escapes, duplicate keys, lone surrogates refused | 10 |
| `crypto.json` | SHA-256 content addresses, key ids, signature verification (valid, unpadded base64, high-S, edited document, wrong key, DER refused, truncated, r = 0, point off the curve, wire key order), rollout buckets | 22 |
| `scenarios.json` | 28 host scenarios, 102 checked steps: signatures and app pinning, fail closed, every version rule (replay, equal, non-integer, unsafe integer, string, too far ahead, epochs), blobs (tampered, missing, malformed hash), LLP 1 strictness, declared keys and caps, placement, `shared/` ownership, live swap with migration, health-check refusal, trap and revert past a schema mismatch, restart with nothing to revert to, time limits in events and migrations, exact UI trees | 102 |
| `keyrings.json` | Keyring chain rules: thresholds, double signatures, release keys can't sign keyrings, skipped and stale numbers, root rotation needing old and new roots, walking a missed chain | 10 |
| `fleet.json` | Fleet agent decisions: live, already-on-version, ignored replays, channel pinning, untrusted and wrong-app releases, shares, the epoch limit, revocation on a new keyring | 14 |

Every vector runs with the clock fixed at 2026-01-01T00:00:00Z. Expected results were written by hand from the spec, except four UI trees marked `recorded`, which were taken from the reference host and then matched by the Go host.

`node conformance/gen.mjs` regenerates the vectors (new signatures, same meaning); `node conformance/run-js.mjs --record` then fills the recorded trees. The keys in `conformance/keys.json` are test keys and must never be trusted anywhere.

**The suite can fail.** Before trusting a green run, each runner was run against deliberate bugs: a revert that ignores the stored schema, a slot that can read keys it wasn't given, Go's own number formatting in canonical JSON, and an edited expected value. Each one turned a check red, in both runners where it applied.

## Results

| | Vectors | Over the wire |
|---|---|---|
| JS reference host | 158 of 158 | — |
| Go host | 158 of 158 | 14 of 14 (`test/interop-go.mjs`) |

The interop test runs the unmodified JavaScript tools against the Go binary over real sockets:

- G1-G6: `tools/publisher.mjs` streams to the Go host. It verifies, fetches, acks, runs events, swaps live on a file change (state kept, migration run), refuses a broken release with `layer_failed`, keeps running the previous one, and goes live on the same release as a JS host on the same stream.
- G7-G14: `tools/fleet.mjs` runs a fleet of four Go hosts and one JS host. The Go hosts pass the device-key challenge, converge, get exactly the share the controller's bucket function predicts at 50%, widen to 100%, accept a release-key rotation and the re-signed release in the new epoch, report a broken rollout as rejected so the gate halts and rolls back, keep their device key and keyring across a restart, and an impostor with another device key is refused.

## What the second implementation found

Each item was either a place where the spec could be read two ways, or a place where the reference host did something the spec didn't say. All are fixed in `SPEC.md` and, where the reference was wrong, in the reference host.

| # | Finding | Before | Now |
|---|---|---|---|
| 1 | **Canonical JSON was underspecified.** "Sorted keys, no whitespace" doesn't say how to sort (bytes, code points or UTF-16 units give different orders), how to write numbers, or which characters to escape. A Go host using its standard library got `1e+21`, key order and escapes wrong, so signatures wouldn't verify. | Unstated | RFC 8785 (JCS), the same thing the reference host already produced. Vectors in `canonical.json`. |
| 2 | **Lone surrogates.** The reference host signed and verified strings holding a lone UTF-16 surrogate. Most JSON decoders (Go's included) replace them, so such a manifest verified on one host and failed on another. | Accepted by JS only | Refused by both (I-JSON, RFC 7493). `canonical()` throws on them. |
| 3 | **`undefined` members.** The reference `canonical()` wrote a member whose value is `undefined` as the bare word `undefined`, which isn't JSON. A fleet hello sent without a channel would have been signed over text the controller could never rebuild. | Bug, not yet hit | Members with no value are left out, as `JSON.stringify` does. |
| 4 | **Signature encoding.** "base64-encoded" didn't say which ECDSA form. WebCrypto emits 64-byte `r‖s`; most other libraries default to DER. | Unstated | 64-byte `r‖s` (IEEE P1363), standard base64, padded when written, padding optional when read. DER is refused. No low-S rule. |
| 5 | **Staging order wasn't signed.** The reference host staged slots, and rendered them when `order` is absent, in the order the keys arrived on the wire. The signature covers the canonical (sorted) form, so a relay could re-order keys and change which slot migrates first without breaking the signature. | Wire order | Sorted slot order, which is what the signature covers. |
| 6 | **Layer hashes weren't checked.** `"layers": {"main": 42}` crashed the reference host's `apply()` with a TypeError instead of refusing the manifest; an uppercase hash was reported as a missing blob. | Crash | Each must be 64 lowercase hex digits, else `malformed`. |
| 7 | **`order` wasn't checked.** A non-list `order` would throw. | Crash | A list of slot names from `layers`, else `malformed`. |
| 8 | **No machine-readable rejection codes.** Reasons were free text, so a second implementation couldn't be checked against the first, and a publisher couldn't tell "stale" from "broken". | Text only | `nack`, `apply()` results and fleet `status` carry a `code`: `malformed`, `untrusted`, `wrong_app`, `protocol`, `bad_version`, `stale`, `blob`, `layer_failed`, and in fleets `channel` and `freshness`. |
| 9 | **`hello` didn't carry `llp`.** The spec says hosts send `"llp": 1` in hello; `node-host.mjs` didn't. | Missing | Sent. |
| 10 | **Undocumented imports.** Every AssemblyScript layer imports `env.abort`, and some toolchains import `env.seed`, but the ABI table listed only module `llp`. A host built from the spec couldn't instantiate any AssemblyScript layer. | Unstated | Both are in the ABI section. |
| 11 | **UI tree wire form.** The shape of a rendered tree (`{k, a, c}`, text nodes `{k: "text", t}`, a lone root child unwrapped) wasn't written down. | Unstated | Specified; four exact trees are vectors. |
| 12 | **String forms of numbers.** `kv_get_s` on a number returns the number as text, which in the reference host is ECMAScript `Number::toString`. Another language's default float formatting differs. | Unstated | ECMAScript `Number::toString`. |
| 13 | **"Characters" in limits.** Key length (1,024) and value size limits count UTF-16 code units in the reference host. | Unstated | UTF-16 code units. |
| 14 | **Mechanism mixed with rules.** Section 6.1 described workers, replicas, change logs and module rewriting as if they were the protocol. The Go host meets the same limits with none of that. | Mixed | The limits and what happens on a breach are the rule; the worker design is marked as how the reference host does it. |
| 15 | **Blob retention.** Both hosts keep a blob that passed its hash check even when the manifest it came with is refused later. That is safe (it's content-addressed) and saves a fetch, but wasn't stated. | Unstated | Stated as allowed. |
| 16 | **Rollout rounding.** `Math.round(percent × 100)`; another language's `round` can differ at .5 for negatives. | Implicit | `floor(percent × 100 + 0.5)`. |

## Not covered yet

- **The Go host is a client host.** It does not implement the server/edge role (SPEC section 10: server slots, `remote` calls, the `shared/` mirror, durable server state) or the device service of 10.4. Those still have one implementation each, so they aren't standard yet.
- **Freshness notes** (12.3.1) are implemented in the Go agent but not covered by vectors.
- **Invalid UTF-8 from a layer** is replaced with U+FFFD by both hosts, but the reference replaces each maximal invalid sequence (WHATWG) and the Go host each invalid byte, so the number of replacement characters can differ. Layers should only emit valid UTF-8; the spec now says so.
- **Wall-clock limits.** Both hosts use wall-clock time limits, so a vector about the 100 ms limit uses a layer that never returns, not one that takes 150 ms.
- **The Go host has no per-layer cap on host-side memory** beyond linear memory and the UI node limit, because there is no worker heap to cap.
