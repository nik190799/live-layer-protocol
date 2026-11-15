# LLP review: what a worldwide standard would need fixed

Date: 2026-11-15. Reviewed `main` at d494f8b. All 141 existing checks pass.

This is a defensive review of the reference code and the spec. For each weakness it says, in plain language, what is wrong and why it matters. It gives a severity, the behaviour a safe host should have, and the recommended fix.

How sure each item is:

- **Proven**: `node test/redteam.mjs` runs the real code and shows it. When a fix lands, that line flips from `CONFIRMED` to `FIXED`.
- **Reasoned**: found by reading the code or the spec. It hasn't been run as a test yet.

Severity is about adoption: **Critical** means a security reviewer would block LLP outright. **High** means a big company wouldn't deploy it without the fix. **Medium** means it's needed before 1.0. **Low** means polish.

## Fix status

Fixes are tracked here as they land. Each fixed finding has a check in `test/security.mjs` (part of `npm test`) that asserts the safe behaviour, and its line in `npm run redteam` now prints `FIXED`.

| Finding | Status | Notes |
|---|---|---|
| RT-01 fail closed without keys | Fixed | Behaviour change: a host with no keys now refuses everything. Development hosts must pass `allowUnsigned: true`. |
| RT-02 bound versions, key-epoch ordering | Fixed | Versions must be safe integers at most one year ahead; fleet manifests carry `epoch` = keyring, so a rotation outranks a poisoned version. |
| ST-02 durable server state | Fixed (single node) | Opt-in: pass `dataDir` to `ServerHost`; without it the host warns. Replication across machines is still open. |
| RT-03 authenticate hosts to the controller | Fixed | Behaviour change: fleet connections now start with a challenge, and hosts sign `hello` with a device key. `fleet-host.mjs` keeps the key in `--trust-dir`. Default enrollment is trust-on-first-use; `enrollment: "closed"` requires `enroll()`. |
| RT-06 fleet controller counts | Fixed | Running counts per channel. 32,000 hosts: 0.3 s per round of reports, down from 10.7 s. Sharding the controller is still open. |
| RT-04 per-slot state isolation | Fixed, opt-in | Manifests that declare `keys` get isolation (filtered replicas, writes checked). `__schema.*` is protected for everyone. Manifests without `keys` still share state, so existing apps keep working. |
| ST-01 no revert across a schema change | Fixed | Behaviour change: a revert skips previous versions with a different `llp_schema`, so it can land on an older version than before (tests A13 and L5 were updated for this). |
| CO-01 no server-wide revert on one call | Fixed | The server restarts the worker on the same version. It reverts only after calls from 3 different users fail within 60 s (both configurable). |
| AI-01 host text into the AI prompt | Fixed | The publisher, the AI stream and `ai-publish` listen on 127.0.0.1 by default (`--host` to opt out). A host's refusal reason reaches the model capped at 300 characters, quoted and labelled as untrusted. Hosts reporting back are still not authenticated on these single-publisher tools. |
| SEC-06 size limits | Fixed, partial | `maxPayload` of 1 MB on the server host, fleet controller, publisher and AI stream. Layer downloads are capped at 16 MB (`limits.blobMb`). The cap is checked after a download, not while it streams, and a per-layer size field in the manifest isn't built. |
| AI-03 declared capabilities per slot | Fixed, opt-in | A signed `caps` field limits each slot's capabilities on clients and on the server. The AI approval screen shows capabilities measured in the shadow check and flags new ones. Manifests without `caps` keep every capability. |
| PR-01 read rules on shared data | Fixed, partial | A signed `private` field makes `shared/users/<user>/...` readable only by that user. There's also an operator `canRead` hook. It's prefix ownership, not full access control lists, and server layers still see everything. |
| SEC-01 freshness (timestamp role) | Fixed, opt-in | The controller signs short-lived freshness notes. Fleet hosts with freshness on refuse releases older than the note, report `freshness-expired`, and in `refuse` mode install nothing without a note. The notes use the release key, not a separate timestamp key, and plain hosts outside a fleet have none. |
| GOV-01 protocol version field | Fixed | `"llp": 1` manifests are strict (unknown fields refused unless `x-`) and must declare `keys` and `caps`. Unversioned manifests keep v0 rules. |
| SEC-02 key custody | Fixed, partial | Root keys are never saved beside the release key, and rotation loads them from offline storage. Key files are 0600. Behaviour change: the fleet CLI writes root keys to `<keys>-root` once, and `rotate` needs that folder. No keystore or PKCS#11 yet. |
| ST-03 effect before its record | Fixed (with dataDir) | Stable `callId` for providers, effects recorded pending/done, finished effects reused on retry. |
| CO-02 retire old server code | Fixed | Signed `overlap` (0 = at once). |
| CO-04 state quotas | Fixed, partial | Host-wide `maxKeys` and `maxValueKb`. No per-slot quotas in the manifest. |
| FL-03 lost hosts | Fixed | `sweepOffline()` plus a `lost` count. |
| OB-01 running hashes in reports | Fixed | `running` in status, ack and nack. |
| AI-05 old output in the prompt | Fixed, partial | The live source is framed as data. Diff highlighting of comments isn't built. |
| SEC-03 per-app trust on the local service | Fixed | `trusted.json` is `{app: [keys]}` and `llp trust <key> <app>` needs an app. Keys in an older plain-list file (or under `"*"`) still count for every app, with a warning. |
| SEC-04 local service UI writes | Fixed | Behaviour change: the UI page, its socket and `/status` need the token in `<data>/keys/ui-token` (0600); `llp open` prints the link. `bind` only sets keys bound to an input on the current screen. `/publish` is still open to local programs, but only signed releases get in. |
| SEC-05 web demo pairing | Fixed | Behaviour change: the demo always asks before trusting a key, even the first, and shows an 80-bit fingerprint to compare with "This device's key" on the other screen (browser test B8). |
| FL-02 restarted host and revoked keys | Fixed | Behaviour change: `fleet-host.mjs` keeps its trust dir by default (`trust/` beside the pinned keyring); `--no-trust-dir` opts out. An unreadable saved file stops the host. Freshness (SEC-01) remains opt-in. |
| FL-01 channels on the server host | Fixed | Each channel is a lane with its own release and workers over one store (SPEC 10.5). Releases that clients outside a partial share still run stay served past the window and across restarts. `joinFleet` follows a fleet controller and relays keyrings to clients. Behaviour changes: clients behind a server need a device `id` to join partial shares (without one they wait for 100%); the data dir's `current.json` becomes `releases.json` (read and replaced on start). Clients behind a server report to the server, not the controller. Tests C1-C14. |
| PR-02 export and erase per person | Fixed, partial | Signed `personal` prefixes (plus `private` ones) say whose a key is. `exportUser` / `eraseUser` on the server host, with a hash-chained audit log; erased call ids leave tombstones so a retry doesn't run twice; the person's devices clear their copy; `llp export|erase` on the device service; self-service opt-in. Data a layer copies outside personal prefixes isn't found, and old disk blocks or backups aren't scrubbed (SPEC 14.5). Tests P1-P14, D6-D7. |
| PR-03 encryption at rest | Fixed, partial | AES-256-GCM, per record, bound to its file and tenant, for the server data dir, the device service and fleet hosts. Key from an env var, an owner-only file or a keystore command, never beside the data; wrong or missing key refuses to start; plaintext data is sealed on first start with a key; re-keying with `previousDataKeys`. Opt-in: without a key, hosts warn and save plain JSON as before. Browser storage isn't encrypted, and no keystore API is called directly (only through a command). Tests E1-E8, C15, D1-D8, F1-F2. |
| RT-05 host pinned to an app | Fixed | Behaviour change: a host that checks signatures must be given its `app`. Fleet hosts take it from the keyring, `connectServer` from its `app` option. |

## 1. Proven findings

### RT-01 A host with no trusted keys skips the signature check (Critical, proven) — FIXED

**Fixed:** `applyNow` refuses every manifest when `trustedKeys` is empty, unless the host was created with `allowUnsigned: true` (exactly `true`), which logs a `security` warning. Tests SEC1 to SEC3.

**In plain words:** if an app forgets to give the host its list of trusted publisher keys, or the list fails to load, the host doesn't refuse updates. It accepts all of them. It's like a door that unlocks itself whenever the key list goes missing.

**Where:** `host/llp-core.js`, `applyNow`: the check only runs `if (this.trustedKeys.length)`.

**Safe behaviour:** a host with an empty key list refuses every manifest, unless it was explicitly started in a named development mode.

**Fix:** fail closed. Add `allowUnsigned: true` as an explicit option for the shadow check and tests, and refuse otherwise. Log the mode loudly.

### RT-02 Version numbers have no limit (High, proven) — FIXED

**Fixed:** a version must be a positive safe integer, at most one year of milliseconds ahead of the larger of the running version and the host's clock. Manifests are ordered as `(epoch, version)`; a fleet host accepts an epoch only up to its trusted keyring number, and the controller stamps each manifest with its keyring and re-signs releases in the new epoch on rotation. Tests SEC6 to SEC10. Limit: a device whose clock is more than a year slow refuses timestamp versions until its clock is fixed or `maxVersionAheadMs` is raised.

**In plain words:** each release carries a version number, and hosts only accept a higher number than the one they're running. Nothing caps that number. So one signed release with a gigantic number, from a bug, a bad clock or a leaked key, leaves no higher number to use. That device then refuses every future update, and rotating keys doesn't help.

**Where:** `applyNow` compares `manifest.version <= this.version` and never checks the type or the range.

**Safe behaviour:** versions must be integers in a sane range, and a host refuses one that jumps too far ahead of the version it's running. A key rotation can also reset the counter.

**Fix:** require `Number.isSafeInteger(version)`. Bound the jump size, for example by refusing a release whose version is more than one year of milliseconds ahead. Tie versions to the keyring, so that ordering is checked as the pair (keyring, version) and a new keyring can start a fresh counter.

### RT-03 The fleet controller trusts a host's claimed name (High, proven) — FIXED

**Fixed:** each connection starts with a challenge, and the host answers with a hello signed by its device key over that challenge. A host id is bound to one device key, by trust on first use or by pre-enrollment (`enrollment: "closed"`). A different key is refused, as is a replayed hello. An unproven connection can't change records, report status or fetch blobs. A host may keep several authenticated connections, and none replaces another. Tests SEC18 to SEC22. Still open: with trust on first use, the first claimant of a brand-new id owns it, and messages rely on TLS for integrity in transit.

**In plain words:** when a device connects, it says "I'm host h1" and the controller believes it. If a second connection uses the same name, the controller sends future releases and key changes to the newcomer, and the real h1 silently stops getting them. That includes key rotations, so the real device can keep trusting a key that was meant to be revoked. Fake reports can also make a rollout look healthy, or look failed and trigger an automatic rollback.

**Where:** `tools/fleet.mjs`, `attach()`: `hello` takes any `host` id and replaces that record's `send`.

**Safe behaviour:** a host proves who it is before the controller updates its record, and a second connection with the same name doesn't take the first one's place.

**Fix:** give each host its own device key at install and have it sign `hello` and `status` messages. Or use mutual TLS. Keep every authenticated connection for a host id, not just the latest. Rollout gates should count only authenticated reports.

### RT-04 Layers on one host share all their data (High, proven) — FIXED (opt-in)

**Fixed:** a signed `keys` field (SPEC 6.2) gives each slot `own` and `read` prefixes. The host sends a slot's worker only the keys it may read, and fails any call that writes outside the slot's own keys. Owners may not overlap. No layer can write `__schema.*`, with or without `keys`. Tests SEC25 to SEC31 use a test layer (`layers/variants/snoop.ts`) that tries to read and overwrite another slot's data. Still open: manifests without `keys` keep the shared key space, so isolation is opt-in. Making it the default needs a protocol version field (GOV-01). The report suggested owner-declared `shares`; this fix uses reader-declared `read` instead, which is equivalent because the publisher signs both.

**In plain words:** every layer on a device reads and writes the same pool of saved data. A footer widget from another team can read the main app's private notes, and it can overwrite them, including the host's internal schema markers. That's fine for one team's demo. It's a blocker once layers come from different vendors or are written by AI.

**Where:** the worker's `read`/`write` in `host/llp-core.js` work on one key space. `__schema.<slot>` keys sit in that same space.

**Safe behaviour:** each slot sees only its own keys, plus keys that another slot has explicitly shared with it. Only the host can write host-internal keys.

**Fix:** give each slot its own key prefix and add a `shares` field to the manifest (for example `footer` reads `main:tasks.*`). Move `__schema.*` out of reach of layers. Filter writes the same way `shared/` writes are already filtered on clients.

## 2. Safety of AI changes and the AI publisher

### AI-01 Text from hosts is fed back to the model unfiltered (High, reasoned) — FIXED

**Fixed:** `tools/publisher.mjs`, `ai/stream.mjs` and `tools/ai-publish.mjs` bind to 127.0.0.1 unless given `--host` / `host`. `feedback("host", …)` caps the reason at 300 characters, strips control characters and backticks, and quotes it as untrusted data. Tests SEC38 and SEC39. Still open: hosts that do connect aren't authenticated on these tools, so an ack can still be faked by a local program.

**In plain words:** when a host refuses a release, the AI loop passes the host's stated reason to the model as feedback, so the model can fix the problem. The stream server accepts connections from any machine on the network without checking who they are (`ai/stream.mjs` and `tools/publisher.mjs` listen on every interface). So anyone who can reach that port can write text that ends up in the model's prompt. They can also fake an "ack" so a release looks like it went live.

**Safe behaviour:** only known hosts can report back. Their reports are treated as data: they're short, quoted and labelled as untrusted, never presented as instructions.

**Fix:** bind the publisher to localhost by default and authenticate hosts (see RT-03). Cap reason text at a few hundred characters and wrap it as quoted data in `ai/prompt.mjs` `feedback()`.

### AI-02 The reviewer sees a summary the model wrote (Medium, reasoned)

**In plain words:** the approval screen opens with a one-line summary written by the model itself. The person approving may rely on it more than on the diff. A mistaken or misleading summary passes straight through.

**Safe behaviour:** the summary the person relies on comes from the tool, not the model. It says which keys the new code writes, which capabilities it asks for, and whether its schema changed.

**Fix:** compute a "what changed" box from the compiled layer and the shadow run (keys written, capabilities requested, schema change). Show it above the model's summary, and mark the model's summary as the model's claim.

### AI-03 Layers get every capability the host offers (High, reasoned) — FIXED (opt-in)

**Fixed:** a signed `caps: { slot: [names] }` field (SPEC section 9). With it, `runCapability` on clients and the server's capability loop refuse any capability not listed for the slot, and log the refusal. The AI shadow check records which capabilities the live and the candidate version asked for, and `ai-publish` prints them, flagging new ones, above the model's summary, which is labelled as the model's claim. Tests SEC40 to SEC44. Still open: manifests without `caps` keep every capability, and the shadow check sees only capabilities that its clicks reach.

**In plain words:** a host grants capabilities (haptics, location, payments, calls to the server) to every layer on it. A release can't say "this layer needs only haptics", so a reviewer can't see that a change starts using something new. The host can't refuse that capability for that layer alone.

**Safe behaviour:** each slot declares the capabilities it needs in the signed manifest. The host grants only those, and newly requested capabilities are highlighted at approval time and in rollout reports.

**Fix:** add `caps: { slot: [names] }` to the manifest (it's inside the signature already). Make `runCapability` and the server's capability loop check it, and have the AI loop's approval screen show capability changes.

### AI-04 The shadow check only covers what it happens to try (Medium, reasoned)

**In plain words:** before going live, the new layer runs against a copy of the state and its buttons get clicked a couple of times. Bugs that only show up later, after many events, on a particular date or with unusual input, still pass. This is the known "wrong but running" gap, and it matters most for AI-written code, because nobody wrote it line by line.

**Safe behaviour:** AI-written releases go through a staged rollout by default, and the shadow check runs longer on realistic data.

**Fix:** have the AI loop publish through `fleet.rollout()` with a small first step by default. Let apps ship property checks (invariants such as "the task count matches the number of task keys") that the shadow check and the hosts evaluate after each event.

### AI-05 Old model output becomes part of the next prompt (Low, reasoned) — FIXED (partial)

**Fixed:** `firstRequest()` frames the live source as reference material whose comments are not instructions (test SEC67). Still open: highlighting comment changes in the approval diff.

**In plain words:** the AI loop saves the live source and sends it to the model with every new request. Comments that an earlier answer left in the code are carried forward and can steer later answers.

**Safe behaviour:** the person sees and approves every comment that lands in the live source, and the prompt marks the source as data.

**Fix:** show comment changes clearly in the diff, and frame the source in `firstRequest()` as reference material, not instructions.

## 3. Security, trust and keys

### RT-05 A fresh host isn't tied to one app (Medium, proven) — FIXED

**Fixed:** `LiveHost` takes an `app` option, and a host that checks signatures refuses to run anything until it has one. Fleet agents pin it from the keyring, `connectServer` from its `app` option, server tenants from their tenant name. Tests SEC4 and SEC5.

**In plain words:** a brand-new host remembers which app it is only after the first release lands. Until then it accepts a release for any app, as long as a trusted key signed it. If one publisher key signs several apps, a device can end up running the wrong one.

**Where:** `applyNow` checks `manifest.app` only `if (this.app)`.

**Safe behaviour:** the host is told its app name at install and refuses releases for any other app.

**Fix:** make `app` a required `LiveHost` option (the fleet host already does this through its keyring) and compare it on every apply.

### SEC-01 A device can be kept on an old release (High, reasoned; known gap) — FIXED (opt-in, fleet hosts)

**Fixed:** freshness notes (SPEC 12.3.1). The controller sends a signed, short-lived "latest is (epoch, version)" note before each release and re-issues it on a timer. A fleet host with freshness on refuses any release older than its note, which covers a fresh install handed an old release. It reports `freshness-expired` once when the note runs out, and in `refuse` mode installs nothing without a valid note. Forged, extended and re-routed notes are refused. Tests SEC49 to SEC54. Still open: it's off by default, the note is signed by the release key rather than a separate timestamp key, plain hosts outside a fleet have no freshness, and what a stale host does beyond reporting is up to the embedder.

**In plain words:** releases don't expire. A relay or cache that stops passing on new releases can keep devices on an old one indefinitely, and a fresh install will accept any old signed release as its first. The device has no way to notice it's stale.

**Safe behaviour:** a host knows how fresh its information is and warns or refuses when it's too old.

**Fix:** follow TUF's timestamp role: the controller signs a short-lived "latest is version N" note, and hosts refuse to run with a note older than a set limit (for example 24 hours for servers, or a softer warning on phones that are often offline).

### SEC-02 Signing keys sit in plain files (High, reasoned) — FIXED (partial)

**Fixed:** `FleetController.save()` never writes root keys next to the release key. A new controller exports them once to `--root-out` (default `<keys>-root`) to be moved offline, and `rotate <root-dir>` loads them only to sign. A controller that holds no root keys refuses to rotate and says why. Release keys, publisher keys, device keys and `llpd`'s local key are written owner-only (0600). An old layout with `root.json` next to the release key still loads, with a warning. Tests SEC57 and SEC58. Still open: OS keystore and PKCS#11 signers, and a written custody policy (who holds which root key and how many must sign).

**In plain words:** the publisher, the AI loop, the fleet controller and `llpd` all save private keys as JSON files (`keys/publisher.json`, `keys/fleet/*.json`, the `llpd` data folder). The fleet controller even keeps root keys next to the release key. Anyone who copies those files can publish code to every device.

**Safe behaviour:** root keys stay offline and need several people to sign. Release keys live in an OS keystore or a hardware key, and the spec says how custody works.

**Fix:** stop saving root keys in `FleetController.save()` and sign keyrings with an offline tool. Support keystore and PKCS#11 signers. Document custody (who holds what, and how many signatures are needed) in the spec.

### SEC-03 A trusted key on the local service can update every app (Medium, reasoned) — FIXED

**Fixed:** `keys/trusted.json` is `{app: [keys]}`, and `llp trust <key> <app>` needs an app name. An older file that is a plain list, or keys under `"*"`, still count for every app, and `llpd` logs a warning so existing setups keep running. Tests S15 and S16 in `test/service.mjs`.

**In plain words:** `llp trust` adds a teammate's key for all apps on the device, not just the app they work on.

**Safe behaviour:** trust is per app.

**Fix:** store trusted keys per app in `llpd` (`keys/trusted.json` becomes `{app: [keys]}`), and have `llp trust` take an app name.

### SEC-04 The local service accepts writes to any state key (Medium, reasoned) — FIXED

**Fixed:** `llpd` creates a UI token in `<data>/keys/ui-token` (mode 0600). The UI page, the `/ui` socket and `/status` refuse requests without it, and `llp open` prints the link. A `bind` is applied only when its key is bound to an input on the current screen. Tests S11 to S14. Behaviour change: bookmarks of `http://127.0.0.1:7710/` need the new link from `llp open`. `/publish` stays open to local programs, since it accepts only signed releases.

**In plain words:** `llpd`'s UI socket lets a client set any key directly, not only the keys the app shows as input boxes. Any program on the same computer can connect and change saved data, including internal keys.

**Where:** `service/llpd.mjs`, the `bind` message.

**Safe behaviour:** a UI client can only set keys that are bound to an input on the current screen. Other local users can't connect at all.

**Fix:** accept `bind` only for keys in the latest render's `binds`. Require a per-session token (written to a file only this user can read) to open the UI socket.

### SEC-05 The web demo trusts the first key it sees (Medium, reasoned) — FIXED

**Fixed:** `onRemote` never trusts a key by itself. The prompt shows the key's fingerprint (80 bits, five groups of four hex digits), and the devices list shows "This device's key" to compare against. Browser test B8 (it fails on the old page). Behaviour change: the first push between two new devices now needs one tap to trust.

**In plain words:** on a device that hasn't trusted anyone yet, the browser demo automatically trusts whichever key wrote the first shared release. Whoever gets there first wins.

**Safe behaviour:** new devices pair by confirming a short code that both screens show.

**Fix:** remove the automatic trust in `web/template.html` `onRemote` and always show the trust prompt, with a key fingerprint long enough to compare.

### SEC-06 Messages and downloads have no size limits (Medium, reasoned) — FIXED (partial)

**Fixed:** a 1 MB `maxPayload` on every WebSocket server that hosts or clients talk to. An oversized message closes the socket with code 1009, and a socket error no longer crashes the server (it used to be unhandled). Layer downloads over `limits.blobMb` (16 MB) reject the manifest. Tests SEC36 and SEC37. Still open: the download cap is checked after the bytes arrive, and the signed per-layer size field isn't built.

**In plain words:** the server host, publishers and fleet controller accept WebSocket messages up to the library default (100 MB). Layer downloads have no size cap either. A misbehaving peer can make a host hold a lot of memory before anything is checked.

**Safe behaviour:** every message and download has a limit that fits its purpose.

**Fix:** set `maxPayload` on every `WebSocketServer`, add a per-layer size cap to the manifest (signed), and refuse to download more bytes than that cap.

## 4. State, data and correctness

### ST-01 A rollback after a migration runs old code on new data (High, reasoned) — FIXED

**Fixed:** `revert()` loads each previous version and skips it if its `llp_schema()` differs from the stored `__schema.<slot>`. With none left, it restarts the current version (SEC32 and SEC33). Behaviour change: a release that migrates data down to an older schema (as the `tasks_trap` fixture does) now reverts to the newest version that matches that schema, which may be older than before. `llp_migrate_down` isn't built.

**In plain words:** say version 2 changes how tasks are stored and migrates the saved data. Later, version 2 crashes on some input, and the host rolls that slot back to version 1. The data stays in version 2's format, and the schema marker still says 2. Version 1 then reads and writes data it doesn't understand, which can quietly corrupt it.

**Where:** `revert()` in `host/llp-core.js` loads the previous hash without looking at `__schema.<slot>`.

**Safe behaviour:** a host never runs code against a schema older than the one the data is in.

**Fix:** when the previous version's `llp_schema()` differs from the stored schema, don't revert. Restart the current version instead (the existing no-previous-version path) and report it. Later, the spec could allow an optional `llp_migrate_down`.

### ST-02 Server data lives only in memory (Critical for backends, reasoned; known gap) — FIXED for one node

**Fixed:** `ServerHost({ dataDir })` keeps each tenant's state, idempotency records and current release on disk: one fsync'd log line per commit, written before the reply, plus periodic snapshots. On restart the release's signature is re-checked and it runs on the restored state. Tests SEC11 to SEC17 restart a real server host, retry a call (answered from the record, not run again), survive a torn log line and compaction, and refuse a release edited on disk. Still open: it's opt-in (no `dataDir` means memory only, with a warning), it covers one machine (no replication), and ST-03 (an outside effect before its record) remains.

**In plain words:** the server host keeps every tenant's shared data and its list of already-answered calls in one process's memory. A restart loses all of it. After a restart, a phone that retries a payment call could also get it run a second time.

**Safe behaviour:** shared state and the idempotency record are durable and survive a restart or a move to another machine.

**Fix:** put a storage interface under `Store` for the server role (a log plus snapshots, or an existing database). Write the idempotency record in the same transaction as the call's writes.

### ST-03 An outside effect can happen without its record (Medium, design) — FIXED (with dataDir)

**Fixed:** each capability call in a remote call with an idempotency id gets a stable `callId` (`user:idem#hop.n`), passed to providers so payment APIs can deduplicate. The server records the effect as pending before it runs and as done (with its result) afterwards, durably when `dataDir` is set. A re-run of the call reuses a done effect's result instead of running it again. A pending one (a crash mid-effect) runs again with the same `callId`, and the host logs it. Tests SEC59 and SEC60. Calls without an idempotency id get no record.

**In plain words:** in a server call, a capability such as `charge` runs between two transactions. If the step after the charge fails, the charge has already happened, but the order record is never written.

**Safe behaviour:** every outside effect is recorded before it runs and reconciled after.

**Fix:** pass the call's idempotency id to capability providers so payment APIs can deduplicate. Write a pending record before the effect and complete it afterwards, so a failed step leaves a record that can be found and fixed.

### CO-01 One user's bad call rolls the server back for everyone (High, reasoned) — FIXED

**Fixed:** on the server, a failed call gets `layer_failed` and the worker restarts on the same version. The slot reverts only when calls from `revertAfterUsers` (default 3) different users fail on that version within `revertWindowMs` (default 60 s), and it logs why (SEC34 and SEC35). Still open: the revert isn't yet reported to the fleet controller as a status.

**In plain words:** on the server, one layer instance serves every user of an app. If a single call fails or runs too long, the server rolls that layer back to the previous version for all users. One user with an unusual input, or a slow moment on the machine, changes which code everyone runs. That can undo a fix that just shipped.

**Where:** `ServerLiveHost.invoke()` calls `revert()` on any failure of the current version.

**Safe behaviour:** a single failed call gets an error. The server reverts only when failures cross a threshold across several users, and it tells the controller when it does.

**Fix:** on the server role, answer `layer_failed` and restart the worker without reverting. Track failure rates per version and revert only above a threshold, reported as a fleet status so the controller can decide.

### CO-02 After a fix, the old server code keeps answering for a while (Medium, reasoned) — FIXED

**Fixed:** a signed `"overlap"` (ms) shortens the window for one release, and `"overlap": 0` retires every older version's server code the moment the release commits. Calls for them get `version_mismatch`. Test SEC61.

**In plain words:** to avoid breaking phones that haven't updated yet, the server keeps the previous version's code running for 30 seconds after a release. Each call says which version it wants, so during that window calls can still reach the old code, even when the new release exists to fix a security bug.

**Safe behaviour:** a release can say that the old version must stop at once.

**Fix:** add a signed `"overlap": 0` (or `"retire": [versions]`) field to the manifest, and have `committed()` honour it.

### CO-03 Time limits are wall-clock (Low, known gap)

A busy device can cut off an honest layer. The fix is already noted in the spec: use CPU-time accounting where the runtime offers it, and allow a per-manifest limit.

### CO-04 State can grow without limit (Medium, known gap) — FIXED (partial)

**Fixed:** host limits `maxKeys` (default 2,000,000) and `maxValueKb` (default 256), plus a 1,024-character key cap. A layer call that would pass them fails like a trap and keeps nothing (tests SEC65 and SEC66). Still open: quotas per slot declared in the manifest, and byte totals.

**In plain words:** a layer can keep adding keys until the device or server runs out of memory or disk.

**Fix:** set a quota per slot, counted in keys and bytes and declared in the manifest. Writes past it fail the call, the same way a trap does.

## 5. Fleet operations, scale and performance

### RT-06 The fleet controller slows down with the square of the number of hosts (High, proven) — FIXED

**Fixed:** the controller keeps running counts per channel and state, and updates them when one host's record changes. It recounts a channel only when its target release or the keyring changes. SEC23 checks that the counts always match a full scan across 400 random operations. SEC24 checks that cost grows linearly. Measured on the same VM: 4,000 hosts 25 ms, 16,000 hosts 97 ms, 32,000 hosts 0.3 s (was 132 ms, 3.6 s and 10.7 s). Still open: sharding, so that a million devices don't depend on one process.

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

### FL-01 Channels and the server host don't work together (High, known gap) — FIXED

**Fixed:** the server host keeps one lane per channel: each with its own release, workers and overlap window, all over the tenant's one store and call queue (SPEC 10.5). Clients send their channel in `hello` and get only that lane's releases, and a client refuses another channel's release even from its own server. During a partial rollout, the releases clients outside the share still run stay served past the window, and are restored after a restart. A server migration on one channel joins the other channels' older code to the migrated data under the expand/contract rule. `joinFleet` connects the server host to a fleet controller, one agent per channel, and relays accepted keyrings to clients behind it. Tests C1 to C14 in `test/channels.mjs`; switching off the pinning or the schema join makes C6 to C8 and C10 fail. Still open: those clients' status reaches the server, not the controller, and freshness notes aren't relayed.

**In plain words:** with a beta group on v8 and everyone else on v7, the server only keeps v7's server code alive for 30 seconds, so stable users' calls start failing.

**Fix:** the server keeps every channel's current server slots live, keyed by version (see SPEC section 11).

### FL-02 A restarted host can trust a revoked key again (High, known gap) — FIXED

**Fixed:** `fleet-host.mjs` keeps a trust dir by default (`trust/` beside the pinned keyring, or `--trust-dir`). A saved keyring or device key that exists but can't be read stops the host with exit code 2. `--no-trust-dir` turns it off for tests and throwaway hosts. Tests W6 (default trust dir refuses the revoked key; `--no-trust-dir` would accept it) and W7. Freshness notes (SEC-01) remain opt-in with `--freshness`. Behaviour change: hosts started without `--trust-dir` now write to `trust/` beside their keyring.

**In plain words:** a host that restarts without its saved key list goes back to the keys it was installed with, including ones that have since been revoked, until it reconnects.

**Fix:** make `--trust-dir` the default rather than an option. Refuse to start if the saved file exists but can't be read. Add SEC-01's freshness note so an out-of-date host notices.

### FL-03 Offline hosts are remembered forever (Low, reasoned) — FIXED

**Fixed:** `sweepOffline(maxOfflineMs)` retires hosts offline longer than the limit into `fleet.lost`. `convergence()` reports `lost` separately, so a channel can be complete again, and a lost host that says hello again is tracked again. Tests SEC62 and SEC63. The caller decides when to sweep; there's no timer.

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

### OB-01 Reports say "version N" while older code runs (Medium, reasoned) — FIXED

**Fixed:** fleet `status` and client `ack`/`nack` messages carry `running: { slot: hash }`, from `LiveHost.running()`. The controller and server host keep it per host or client (test SEC64).

**In plain words:** after a rollback, a host still says it's on version N, even though one slot is running an older hash. Dashboards and support staff then see the wrong picture.

**Fix:** report the running hash for each slot alongside the version, both in `status` messages and in `ack`.

### OB-02 Fleet reports can't be trusted (Medium, known gap; see RT-03)

Reports are unauthenticated, so they can't safely drive automatic decisions. RT-03's fix covers this.

### OB-03 No standard traces or metrics (Medium, design)

**In plain words:** there's no common way to see "which release was this user on when it broke", in a format existing tools can read.

**Fix:** define OpenTelemetry attributes (`llp.app`, `llp.version`, `llp.slot`, `llp.hash`) on every call and event, and export swap, rollback and rejection counts as metrics. Keep the layer logs from a failed call instead of dropping them (a known gap).

## 8. Privacy and compliance

### PR-01 Every user of an app can read all of its shared data (High, known gap) — FIXED (partial)

**Fixed:** a signed `private: ["shared/users/"]` field. Under each prefix, the next path segment names the one user who may read the key. The server host filters the mirror on `hello` and on every update, rebuilds every client's mirror when the rules change, and supports an operator `canRead(user, key, app)` hook. Tests SEC45 to SEC48 use three real clients over WebSocket. Still open: the rules are prefix ownership only (no groups or sharing), and PR-02 (export and delete per person) is not built.

**In plain words:** on the server host, any signed-in user can mirror everything under `shared/` that they ask for, including other users' data.

**Fix:** add read rules per key prefix, for example `shared/users/<user>/` readable only by that user, checked in `ServerHost.flush()` and on `hello`. Without this, LLP can't hold personal data under GDPR or similar laws.

### PR-02 Data can't be found, exported or deleted per person (High, design) — FIXED (partial)

**Fixed:** a signed `personal` field lists key prefixes whose next path segment names the person (`private` prefixes count too). The server host's `exportUser` returns the person's keys, call results and effects as one snapshot; `eraseUser` deletes them, replaces the log with a snapshot so no erased value stays in the files, deletes the keys from other clients' mirrors and tells the person's devices, which clear their own copy. An erased call id leaves a hashed tombstone, so a retried payment isn't charged twice. Every export and erase goes to a hash-chained audit log that holds no data. Users can do it themselves only if the operator turns on `selfService`. The device service has `llp export|erase <app>`. Tests P1 to P14 in `test/privacy.mjs` and D6, D7 in `test/at-rest-hosts.mjs`. Still open: data a layer copies outside personal prefixes isn't found (the export says so), disk blocks and backups aren't scrubbed, and there are no per-person keys for crypto-shredding.

**In plain words:** privacy laws give people the right to see and delete their data. LLP's key/value store has no notion of whose data a key is.

**Fix:** make key ownership part of the schema (an owner prefix), and give the server host export and delete-by-owner operations with an audit log.

### PR-03 Data on disk isn't encrypted (Medium, reasoned) — FIXED (partial)

**Fixed:** `host/at-rest.mjs` seals each saved record with AES-256-GCM, bound to its file and tenant, so moved or edited records fail to open. The server host's data dir (state, log, releases, audit log, fleet keyring and device key), the device service (app state and releases, the device's publisher key) and fleet hosts (device key, saved keyring) are covered. The key comes from an environment variable, an owner-only file, or a command, which is how an OS keystore is reached. A host refuses to start without its key or with another one, seals plaintext data the first time it starts with a key, and the server host re-keys with `previousDataKeys`. Tests E1 to E8, C15, D1 to D8, F1, F2. Behaviour: opt-in, so without a key hosts warn and save plain JSON as before. Still open: browser storage, per-key sensitivity marks, and direct keystore or hardware-key APIs (only the command path is tested, with a stand-in command).

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
| Someone with a copy of the disk or a backup | Read saved files | App and personal data can't be read without a key kept elsewhere | Added after the review: opt-in encryption (PR-03) |
| A person whose data the app holds | Ask to see or delete it | Their data can be found, exported and erased, with a record of it | Added after the review: by key prefix (PR-02) |

## 10. Governance, versioning and interoperability

### GOV-01 The protocol has no version of its own (High, design) — FIXED

**Fixed:** manifests may carry a signed `"llp": 1`, and fleet and client `hello`s send `llp: 1`. A host refuses versions newer than it implements. Version 1 is strict: any unknown top-level field rejects the manifest (fields starting `x-` are ignorable), and a v1 manifest must declare `keys` and `caps`, so isolation (RT-04) and declared capabilities (AI-03) are the default for v1. Tests SEC55 and SEC56. Unversioned manifests are v0 and keep the v0 rules, so existing publishers are unaffected. The reference publishers still emit v0 because `keys` are app-specific. The server doesn't refuse old `hello`s yet.

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

- Browser-specific behaviour: `test/browser.mjs` was not re-run for the original review. It was re-run after the fixes (7/7 pass in Chromium, including the rebuilt demo page).
- Denial of service against the publisher and controller, beyond the size limits in SEC-06.
- A formal check of the keyring rotation logic. It was read and its tests pass, but no model checker was used.
