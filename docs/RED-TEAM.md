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
