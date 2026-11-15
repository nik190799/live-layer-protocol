# LLP review: what a worldwide standard would need fixed

Date: 2026-11-15. Reviewed `main` at d494f8b. All 141 existing checks pass.

This is a defensive review of the reference code and the spec. For each weakness it says, in plain language, what is wrong and why it matters. It gives a severity, the behaviour a safe host should have, and the recommended fix.

How sure each item is:

- **Proven**: `node test/redteam.mjs` runs the real code and shows it. When a fix lands, that line flips from `CONFIRMED` to `FIXED`.
- **Reasoned**: found by reading the code or the spec. It hasn't been run as a test yet.

Severity is about adoption: **Critical** means a security reviewer would block LLP outright. **High** means a big company wouldn't deploy it without the fix. **Medium** means it's needed before 1.0. **Low** means polish.

## 1. Proven findings

### RT-01 A host with no trusted keys skips the signature check (Critical, proven)

**In plain words:** if an app forgets to give the host its list of trusted publisher keys, or the list fails to load, the host doesn't refuse updates. It accepts all of them. It's like a door that unlocks itself whenever the key list goes missing.

**Where:** `host/llp-core.js`, `applyNow`: the check only runs `if (this.trustedKeys.length)`.

**Safe behaviour:** a host with an empty key list refuses every manifest, unless it was explicitly started in a named development mode.

**Fix:** fail closed. Add `allowUnsigned: true` as an explicit option for the shadow check and tests, and refuse otherwise. Log the mode loudly.

### RT-02 Version numbers have no limit (High, proven)

**In plain words:** each release carries a version number, and hosts only accept a higher number than the one they're running. Nothing caps that number. So one signed release with a gigantic number, from a bug, a bad clock or a leaked key, leaves no higher number to use. That device then refuses every future update, and rotating keys doesn't help.

**Where:** `applyNow` compares `manifest.version <= this.version` and never checks the type or the range.

**Safe behaviour:** versions must be integers in a sane range, and a host refuses one that jumps too far ahead of the version it's running. A key rotation can also reset the counter.

**Fix:** require `Number.isSafeInteger(version)`. Bound the jump size, for example by refusing a release whose version is more than one year of milliseconds ahead. Tie versions to the keyring, so that ordering is checked as the pair (keyring, version) and a new keyring can start a fresh counter.

### RT-03 The fleet controller trusts a host's claimed name (High, proven)

**In plain words:** when a device connects, it says "I'm host h1" and the controller believes it. If a second connection uses the same name, the controller sends future releases and key changes to the newcomer, and the real h1 silently stops getting them. That includes key rotations, so the real device can keep trusting a key that was meant to be revoked. Fake reports can also make a rollout look healthy, or look failed and trigger an automatic rollback.

**Where:** `tools/fleet.mjs`, `attach()`: `hello` takes any `host` id and replaces that record's `send`.

**Safe behaviour:** a host proves who it is before the controller updates its record, and a second connection with the same name doesn't take the first one's place.

**Fix:** give each host its own device key at install and have it sign `hello` and `status` messages. Or use mutual TLS. Keep every authenticated connection for a host id, not just the latest. Rollout gates should count only authenticated reports.

### RT-04 Layers on one host share all their data (High, proven)

**In plain words:** every layer on a device reads and writes the same pool of saved data. A footer widget from another team can read the main app's private notes, and it can overwrite them, including the host's internal schema markers. That's fine for one team's demo. It's a blocker once layers come from different vendors or are written by AI.

**Where:** the worker's `read`/`write` in `host/llp-core.js` work on one key space. `__schema.<slot>` keys sit in that same space.

**Safe behaviour:** each slot sees only its own keys, plus keys that another slot has explicitly shared with it. Only the host can write host-internal keys.

**Fix:** give each slot its own key prefix and add a `shares` field to the manifest (for example `footer` reads `main:tasks.*`). Move `__schema.*` out of reach of layers. Filter writes the same way `shared/` writes are already filtered on clients.

## 2. Safety of AI changes and the AI publisher

### AI-01 Text from hosts is fed back to the model unfiltered (High, reasoned)

**In plain words:** when a host refuses a release, the AI loop passes the host's stated reason to the model as feedback, so the model can fix the problem. The stream server accepts connections from any machine on the network without checking who they are (`ai/stream.mjs` and `tools/publisher.mjs` listen on every interface). So anyone who can reach that port can write text that ends up in the model's prompt. They can also fake an "ack" so a release looks like it went live.

**Safe behaviour:** only known hosts can report back. Their reports are treated as data: they're short, quoted and labelled as untrusted, never presented as instructions.

**Fix:** bind the publisher to localhost by default and authenticate hosts (see RT-03). Cap reason text at a few hundred characters and wrap it as quoted data in `ai/prompt.mjs` `feedback()`.

### AI-02 The reviewer sees a summary the model wrote (Medium, reasoned)

**In plain words:** the approval screen opens with a one-line summary written by the model itself. The person approving may rely on it more than on the diff. A mistaken or misleading summary passes straight through.

**Safe behaviour:** the summary the person relies on comes from the tool, not the model. It says which keys the new code writes, which capabilities it asks for, and whether its schema changed.

**Fix:** compute a "what changed" box from the compiled layer and the shadow run (keys written, capabilities requested, schema change). Show it above the model's summary, and mark the model's summary as the model's claim.

### AI-03 Layers get every capability the host offers (High, reasoned)

**In plain words:** a host grants capabilities (haptics, location, payments, calls to the server) to every layer on it. A release can't say "this layer needs only haptics", so a reviewer can't see that a change starts using something new. The host can't refuse that capability for that layer alone.

**Safe behaviour:** each slot declares the capabilities it needs in the signed manifest. The host grants only those, and newly requested capabilities are highlighted at approval time and in rollout reports.

**Fix:** add `caps: { slot: [names] }` to the manifest (it's inside the signature already). Make `runCapability` and the server's capability loop check it, and have the AI loop's approval screen show capability changes.

### AI-04 The shadow check only covers what it happens to try (Medium, reasoned)

**In plain words:** before going live, the new layer runs against a copy of the state and its buttons get clicked a couple of times. Bugs that only show up later, after many events, on a particular date or with unusual input, still pass. This is the known "wrong but running" gap, and it matters most for AI-written code, because nobody wrote it line by line.

**Safe behaviour:** AI-written releases go through a staged rollout by default, and the shadow check runs longer on realistic data.

**Fix:** have the AI loop publish through `fleet.rollout()` with a small first step by default. Let apps ship property checks (invariants such as "the task count matches the number of task keys") that the shadow check and the hosts evaluate after each event.

### AI-05 Old model output becomes part of the next prompt (Low, reasoned)

**In plain words:** the AI loop saves the live source and sends it to the model with every new request. Comments that an earlier answer left in the code are carried forward and can steer later answers.

**Safe behaviour:** the person sees and approves every comment that lands in the live source, and the prompt marks the source as data.

**Fix:** show comment changes clearly in the diff, and frame the source in `firstRequest()` as reference material, not instructions.

## 3. Security, trust and keys

### RT-05 A fresh host isn't tied to one app (Medium, proven)

**In plain words:** a brand-new host remembers which app it is only after the first release lands. Until then it accepts a release for any app, as long as a trusted key signed it. If one publisher key signs several apps, a device can end up running the wrong one.

**Where:** `applyNow` checks `manifest.app` only `if (this.app)`.

**Safe behaviour:** the host is told its app name at install and refuses releases for any other app.

**Fix:** make `app` a required `LiveHost` option (the fleet host already does this through its keyring) and compare it on every apply.

### SEC-01 A device can be kept on an old release (High, reasoned; known gap)

**In plain words:** releases don't expire. A relay or cache that stops passing on new releases can keep devices on an old one indefinitely, and a fresh install will accept any old signed release as its first. The device has no way to notice it's stale.

**Safe behaviour:** a host knows how fresh its information is and warns or refuses when it's too old.

**Fix:** follow TUF's timestamp role: the controller signs a short-lived "latest is version N" note, and hosts refuse to run with a note older than a set limit (for example 24 hours for servers, or a softer warning on phones that are often offline).

### SEC-02 Signing keys sit in plain files (High, reasoned)

**In plain words:** the publisher, the AI loop, the fleet controller and `llpd` all save private keys as JSON files (`keys/publisher.json`, `keys/fleet/*.json`, the `llpd` data folder). The fleet controller even keeps root keys next to the release key. Anyone who copies those files can publish code to every device.

**Safe behaviour:** root keys stay offline and need several people to sign. Release keys live in an OS keystore or a hardware key, and the spec says how custody works.

**Fix:** stop saving root keys in `FleetController.save()` and sign keyrings with an offline tool. Support keystore and PKCS#11 signers. Document custody (who holds what, and how many signatures are needed) in the spec.

### SEC-03 A trusted key on the local service can update every app (Medium, reasoned)

**In plain words:** `llp trust` adds a teammate's key for all apps on the device, not just the app they work on.

**Safe behaviour:** trust is per app.

**Fix:** store trusted keys per app in `llpd` (`keys/trusted.json` becomes `{app: [keys]}`), and have `llp trust` take an app name.

### SEC-04 The local service accepts writes to any state key (Medium, reasoned)

**In plain words:** `llpd`'s UI socket lets a client set any key directly, not only the keys the app shows as input boxes. Any program on the same computer can connect and change saved data, including internal keys.

**Where:** `service/llpd.mjs`, the `bind` message.

**Safe behaviour:** a UI client can only set keys that are bound to an input on the current screen. Other local users can't connect at all.

**Fix:** accept `bind` only for keys in the latest render's `binds`. Require a per-session token (written to a file only this user can read) to open the UI socket.

### SEC-05 The web demo trusts the first key it sees (Medium, reasoned)

**In plain words:** on a device that hasn't trusted anyone yet, the browser demo automatically trusts whichever key wrote the first shared release. Whoever gets there first wins.

**Safe behaviour:** new devices pair by confirming a short code that both screens show.

**Fix:** remove the automatic trust in `web/template.html` `onRemote` and always show the trust prompt, with a key fingerprint long enough to compare.

### SEC-06 Messages and downloads have no size limits (Medium, reasoned)

**In plain words:** the server host, publishers and fleet controller accept WebSocket messages up to the library default (100 MB). Layer downloads have no size cap either. A misbehaving peer can make a host hold a lot of memory before anything is checked.

**Safe behaviour:** every message and download has a limit that fits its purpose.

**Fix:** set `maxPayload` on every `WebSocketServer`, add a per-layer size cap to the manifest (signed), and refuse to download more bytes than that cap.

## 4. State, data and correctness

### ST-01 A rollback after a migration runs old code on new data (High, reasoned)

**In plain words:** say version 2 changes how tasks are stored and migrates the saved data. Later, version 2 crashes on some input, and the host rolls that slot back to version 1. The data stays in version 2's format, and the schema marker still says 2. Version 1 then reads and writes data it doesn't understand, which can quietly corrupt it.

**Where:** `revert()` in `host/llp-core.js` loads the previous hash without looking at `__schema.<slot>`.

**Safe behaviour:** a host never runs code against a schema older than the one the data is in.

**Fix:** when the previous version's `llp_schema()` differs from the stored schema, don't revert. Restart the current version instead (the existing no-previous-version path) and report it. Later, the spec could allow an optional `llp_migrate_down`.

### ST-02 Server data lives only in memory (Critical for backends, reasoned; known gap)

**In plain words:** the server host keeps every tenant's shared data and its list of already-answered calls in one process's memory. A restart loses all of it. After a restart, a phone that retries a payment call could also get it run a second time.

**Safe behaviour:** shared state and the idempotency record are durable and survive a restart or a move to another machine.

**Fix:** put a storage interface under `Store` for the server role (a log plus snapshots, or an existing database). Write the idempotency record in the same transaction as the call's writes.

### ST-03 An outside effect can happen without its record (Medium, design)

**In plain words:** in a server call, a capability such as `charge` runs between two transactions. If the step after the charge fails, the charge has already happened, but the order record is never written.

**Safe behaviour:** every outside effect is recorded before it runs and reconciled after.

**Fix:** pass the call's idempotency id to capability providers so payment APIs can deduplicate. Write a pending record before the effect and complete it afterwards, so a failed step leaves a record that can be found and fixed.

### CO-01 One user's bad call rolls the server back for everyone (High, reasoned)

**In plain words:** on the server, one layer instance serves every user of an app. If a single call fails or runs too long, the server rolls that layer back to the previous version for all users. One user with an unusual input, or a slow moment on the machine, changes which code everyone runs. That can undo a fix that just shipped.

**Where:** `ServerLiveHost.invoke()` calls `revert()` on any failure of the current version.

**Safe behaviour:** a single failed call gets an error. The server reverts only when failures cross a threshold across several users, and it tells the controller when it does.

**Fix:** on the server role, answer `layer_failed` and restart the worker without reverting. Track failure rates per version and revert only above a threshold, reported as a fleet status so the controller can decide.

### CO-02 After a fix, the old server code keeps answering for a while (Medium, reasoned)

**In plain words:** to avoid breaking phones that haven't updated yet, the server keeps the previous version's code running for 30 seconds after a release. Each call says which version it wants, so during that window calls can still reach the old code, even when the new release exists to fix a security bug.

**Safe behaviour:** a release can say that the old version must stop at once.

**Fix:** add a signed `"overlap": 0` (or `"retire": [versions]`) field to the manifest, and have `committed()` honour it.

### CO-03 Time limits are wall-clock (Low, known gap)

A busy device can cut off an honest layer. The fix is already noted in the spec: use CPU-time accounting where the runtime offers it, and allow a per-manifest limit.

### CO-04 State can grow without limit (Medium, known gap)

**In plain words:** a layer can keep adding keys until the device or server runs out of memory or disk.

**Fix:** set a quota per slot, counted in keys and bytes and declared in the manifest. Writes past it fail the call, the same way a trap does.

## 5. Fleet operations, scale and performance

### RT-06 The fleet controller slows down with the square of the number of hosts (High, proven)

**In plain words:** while a rollout waits for hosts to report, every status message makes the controller recount every host. Doubling the fleet roughly quadruples the work. Measured on this VM, one status report from each host took:

| Hosts | Time |
|---|---|
| 4,000 | 132 ms |
| 16,000 | 3.6 s |
| 32,000 | 10.7 s |

At that growth rate, one round of reports from a million devices would take hours. This is one proven cause of slowness at scale. It doesn't fully explain the earlier 10,000-host run that didn't finish, which also ran every host as a real connection.

**Where:** `tools/fleet.mjs`, where `tick()` runs on every `hello` and `status` and calls `convergence()`, which loops over all hosts.

**Safe behaviour:** each report costs the same no matter how big the fleet is.

**Fix:** keep running counts per channel and state, update them when a host's record changes, and have `convergence()` read the counts. Shard the controller by channel or host-id prefix, so a million devices don't depend on one process.

### FL-01 Channels and the server host don't work together (High, known gap)

**In plain words:** with a beta group on v8 and everyone else on v7, the server only keeps v7's server code alive for 30 seconds, so stable users' calls start failing.

**Fix:** the server keeps every channel's current server slots live, keyed by version (see SPEC section 11).

### FL-02 A restarted host can trust a revoked key again (High, known gap)

**In plain words:** a host that restarts without its saved key list goes back to the keys it was installed with, including ones that have since been revoked, until it reconnects.

**Fix:** make `--trust-dir` the default rather than an option. Refuse to start if the saved file exists but can't be read. Add SEC-01's freshness note so an out-of-date host notices.

### FL-03 Offline hosts are remembered forever (Low, reasoned)

**In plain words:** every host id ever seen stays in the controller's list, so one long-dead device keeps a channel from ever counting as "complete".

**Fix:** retire host records after a configurable time offline, and report them separately as "lost".

### PERF-01 Per-tenant and per-worker costs (Medium, known gap)

A tenant runs one call at a time (4,000 to 7,000 simple calls per second), and each busy tenant's layer worker costs about 9 MB. One user can fill a tenant's queue of 256 calls and push everyone else into `overloaded`.

**Fix:** add per-user queue limits inside a tenant, read-only concurrent calls, and a way for many small tenants to share a worker.

## 6. Coverage of app types

| App type | Works today | What's missing |
|---|---|---|
| Forms and list UIs | Yes (11 UI kinds) | Typed component catalogue, accessibility labels, text input other than plain strings |
| Rich or custom UI (charts, maps, editors) | No | A canvas or GPU surface (SPEC section 8 names it as the direction) |
| Games | Partly (the hotfix case study) | A frame loop: LLP has no tick or animation event and calls are capped at 100 ms. It also lacks input streams and audio |
| Backends and APIs | Partly | Durable state (ST-02), several server nodes, concurrency (PERF-01), HTTP ingress that doesn't go through a client |
| IoT and embedded | No | A host for small devices (the host needs JavaScript and workers today). A WAMR or wasm3 host in C would be needed |
| Offline-first and peer-to-peer | Partly | Client calls queue offline, but there's no conflict-free merge for data edited on two devices and no peer-to-peer release sharing with freshness checks (SEC-01) |
| Kernel, drivers and config | No | Out of scope for LLP. Config changes need their own shadow check (the Fastly case study) |

**Plain-language takeaway:** LLP is ready for small UIs and simple server logic today. "Every app" needs a richer UI surface, a frame loop, a small-device host and durable server state.

## 7. Observability

### OB-01 Reports say "version N" while older code runs (Medium, reasoned)

**In plain words:** after a rollback, a host still says it's on version N, even though one slot is running an older hash. Dashboards and support staff then see the wrong picture.

**Fix:** report the running hash for each slot alongside the version, both in `status` messages and in `ack`.

### OB-02 Fleet reports can't be trusted (Medium, known gap; see RT-03)

Reports are unauthenticated, so they can't safely drive automatic decisions. RT-03's fix covers this.

### OB-03 No standard traces or metrics (Medium, design)

**In plain words:** there's no common way to see "which release was this user on when it broke", in a format existing tools can read.

**Fix:** define OpenTelemetry attributes (`llp.app`, `llp.version`, `llp.slot`, `llp.hash`) on every call and event, and export swap, rollback and rejection counts as metrics. Keep the layer logs from a failed call instead of dropping them (a known gap).

## 8. Privacy and compliance

### PR-01 Every user of an app can read all of its shared data (High, known gap)

**In plain words:** on the server host, any signed-in user can mirror everything under `shared/` that they ask for, including other users' data.

**Fix:** add read rules per key prefix, for example `shared/users/<user>/` readable only by that user, checked in `ServerHost.flush()` and on `hello`. Without this, LLP can't hold personal data under GDPR or similar laws.

### PR-02 Data can't be found, exported or deleted per person (High, design)

**In plain words:** privacy laws give people the right to see and delete their data. LLP's key/value store has no notion of whose data a key is.

**Fix:** make key ownership part of the schema (an owner prefix), and give the server host export and delete-by-owner operations with an audit log.

### PR-03 Data on disk isn't encrypted (Medium, reasoned)

`llpd` saves each app's state as plain JSON in the user's data folder, and browsers save it in local storage.

**Fix:** encrypt at rest with a key from the OS keystore, and let apps mark keys as sensitive.

### PR-04 Changing code without an app-store review (Medium, design)

**In plain words:** regulators and platform owners want to know who changed what, and when. LLP can change code many times a day.

**Fix:** keep a signed, append-only release log (who signed, what changed, which capabilities) that can be published, in the style of Sigstore's Rekor transparency log. Google Play's interpreter rule probably covers LLP, but that is not yet verified; see `docs/CASE-STUDIES.md`.

## 9. Threat model (what LLP must survive)

A standard needs this written down. Here is a first version. Each row names the attacker, what LLP promises against them today, and which findings close the gap.

| Who | Can do | LLP should guarantee | Today |
|---|---|---|---|
| Someone on the network | Read and change traffic | No code runs unless a trusted key signed it; tampering is detected | Yes (signatures and hashes), except RT-01 and AI-01 |
| A relay, CDN or server host | Delay, drop or replay releases | Hosts notice when they're stale | No: SEC-01 |
| A user of the app | Send any input or call | Their input can't change code or read other users' data | No: CO-01, PR-01 |
| A third-party layer | Run code inside the host | Sandboxed time, memory and UI; only its own data and declared capabilities | Partly: sandbox yes, RT-04 and AI-03 no |
| An AI publisher, mistaken or misled | Write any layer | Shadow check, human approval, staged rollout, visible capability changes | Partly: AI-02 to AI-04 |
| A leaked release key | Sign releases | Rotation revokes it everywhere, quickly, with no permanent damage | Partly: RT-02, RT-03, FL-02 |
| A leaked root key | Sign keyrings | Needs a threshold of keys; root keys are offline | Supported in code, but SEC-02 |
| A program on the same computer | Talk to `llpd` | Can't change apps or read their data | No: SEC-04 |

## 10. Governance, versioning and interoperability

### GOV-01 The protocol has no version of its own (High, design)

**In plain words:** manifests and messages don't say which version of LLP they follow. Once two versions exist, a host can't tell whether it understands a message.

**Fix:** add `"llp": 1` to the manifest (signed) and to `hello`. Define which fields can be ignored and which must be understood, so an unknown required field means "refuse".

### GOV-02 Only one implementation, and the spec isn't precise enough for a second (High, design)

**In plain words:** standards bodies want two independent implementations that agree. The spec leaves things out: canonical JSON for unusual numbers and Unicode, the full worker ABI behaviour on edge cases, error strings, and what "balanced UI" means exactly.

**Fix:** use RFC 8785 (JSON Canonicalization Scheme) instead of the home-grown `canonical()`. Publish a conformance suite of test vectors (manifests, signatures, layers and expected results) that any host can run (`test/interop.mjs` is a start). Then build a second host in another language, for example Rust with Wasmtime.

### GOV-03 A custom ABI instead of the WebAssembly Component Model (Medium, known gap)

**Fix:** define the ABI in WIT now, even if the browser host keeps the current shim, so other toolchains can generate bindings.

### GOV-04 No open governance (Medium, design)

**In plain words:** companies adopt protocols they can influence and that won't change under them. The repository is private and unlicensed (`"license": "UNLICENSED"`).

**Fix:** pick an open licence (Apache-2.0 is common for protocols), publish the spec separately from the code, and write a change process with numbered proposals. Later, bring it to a neutral foundation such as OpenSSF, CNCF or the Bytecode Alliance.

## 11. Developer and LLM experience, and the adoption story

- **DX-01 (Medium):** debugging a live layer is hard. A failed call's logs are dropped and errors point at wasm, not source. **Fix:** keep logs on failure and ship source maps with the layer (hashed with it).
- **DX-02 (Medium):** the AssemblyScript SDK is the only first-class one; C has a header. **Fix:** generate SDKs from WIT (GOV-03) for Rust, Go (TinyGo) and JavaScript (via a JS-in-wasm engine).
- **DX-03 (Low):** the AI system prompt hard-codes the demo app (`tasks.n`). **Fix:** describe the state keys and invariants per app in a file the loop reads.
- **ADOPT-01:** the relatable pitch is "update a running app the way you edit a shared document: it changes in place, nobody loses their work, and a bad change undoes itself." The strongest proof is `docs/CASE-STUDIES.md`. To be accepted worldwide it needs the open licence and second implementation (GOV-02, GOV-04), a hosted controller people can try in minutes, and one real app in production.

## 12. Priorities

Fix in this order. The first group blocks any serious security review.

| Order | Finding | Severity | Proof | Effort |
|---|---|---|---|---|
| 1 | RT-01 fail closed without keys | Critical | Proven | Small |
| 2 | ST-02 durable server state | Critical (backends) | Reasoned, known | Large |
| 3 | RT-02 bound versions, key-epoch ordering | High | Proven | Small |
| 4 | RT-03 authenticate hosts to the controller | High | Proven | Medium |
| 5 | RT-04 per-slot state isolation | High | Proven | Medium |
| 6 | AI-03 declared capabilities per slot | High | Reasoned | Medium |
| 7 | CO-01 no server-wide revert on one call | High | Reasoned | Small |
| 8 | ST-01 no revert across a schema change | High | Reasoned | Small |
| 9 | AI-01 localhost by default, treat host text as data | High | Reasoned | Small |
| 10 | PR-01 read rules on shared data | High | Reasoned, known | Medium |
| 11 | SEC-01 freshness (timestamp role) | High | Reasoned, known | Medium |
| 12 | RT-06 fleet controller counts | High | Proven | Small |
| 13 | GOV-01 protocol version field | High | Design | Small |
| 14 | SEC-02 key custody | High | Reasoned | Medium |
| 15 | Everything else | Medium/Low | Mixed | Mixed |

## Not covered

- Browser-specific behaviour: `test/browser.mjs` was not re-run for this review.
- Denial of service against the publisher and controller, beyond the size limits in SEC-06.
- A formal check of the keyring rotation logic. It was read and its tests pass, but no model checker was used.
