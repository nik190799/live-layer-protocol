# Five outages, replayed under LLP

This document takes four well-known production incidents, plus one everyday problem, and replays
each failure in a simulation two ways:

1. **The way it happened.** The bad change is delivered the way the incident delivered it.
2. **Through LLP.** The identical faulty code goes through the Live Layer Protocol as built in this
   repo, with signed manifests, a shadow check against real state, staged rollout with health gates,
   per-call time budgets and per-host automatic revert.

We don't recreate Windows, SMARS, Cloudflare's WAF or Fastly's edge. Each case is a small
WebAssembly layer (AssemblyScript, in `case-studies/layers/`) that reproduces the *mechanism* of the
failure: the out-of-bounds read, the reused flag, the backtracking regex, the latent divide-by-zero.
The real systems' details are here only to show that the mechanism is faithful.

Every number below comes from `npm run case-studies`, which runs all five, checks 17 claims and
writes the raw numbers to [`case-studies-results.json`](case-studies-results.json). The results
here are from one run on a 4-core Linux container with Node 22. The checks passed on every one of
5 consecutive runs. Timings vary a little from run to run; counts don't.

## Summary

| Case | The way it happened (simulated) | Through LLP (simulated) |
|---|---|---|
| CrowdStrike 2024: bad content update | 1,000 of 1,000 hosts crash, and each crashes again on reboot | Rollout halts at its 1% step. 10 hosts ran it, 0 went down, 10 events dropped. Fleet rolled back 0.9 s after publish |
| Knight Capital 2012: partial deploy | 3,676 child orders for 212 parent orders (3,490 from the 8th server). Rolling back the 7 good servers makes it 9,974 | The convergence report flags `smars-8` the moment the release goes out. With the flag gated on a complete fleet: 212 child orders, 0 unintended |
| Cloudflare 2019: backtracking regex | Throughput falls from 106,074 to 10 requests per 2 s window across 20 edges | 1 edge ran the rule. 1 request failed, 99.998% availability, and the rollout rolled back. Even a 100% global push: 20 failed requests, 99.956% availability |
| Fastly 2021: latent bug + config change | 20 of 20 edges down, 0% availability for every customer | 0 edges down. 20 requests failed (one per edge), 99.667% availability, 100% for other customers |
| Hotfix waits on a release | Not simulated (store review and user updates: days) | Fix reaches 1,000 running clients in 1.4 s through a 1 → 10 → 50 → 100% rollout. 0 sessions lost |

The rest of this document covers what each case models, what the sim found, and **where LLP would
not have helped**.

---

## 1. CrowdStrike, 19 July 2024

**What happened.** At 04:09 UTC, CrowdStrike released a Rapid Response Content update for the
Falcon sensor on Windows (Channel File 291). New template instances made the content interpreter
read a 21st input field, but the sensor code supplied only 20. The out-of-bounds read crashed the
kernel driver, and machines boot-looped. The content was reverted at 05:27 UTC, but machines that
had already crashed needed hands-on repair. Microsoft estimated about 8.5 million Windows devices
were affected. CrowdStrike's fixes include a staggered deployment for this kind of content,
"starting with a canary deployment", and deployment rings that template instances must pass before
reaching production. That means this content was not going through staged rollout before.

**Model.** `cs_sensor` reads 20 fields from each IPC event. `cs_sensor_291` reads 21 from the same
20-field input, and the out-of-range read traps. There are 1,000 simulated hosts.

**Results.**

| | Legacy | LLP |
|---|---|---|
| Hosts that ran the bad update | 1,000 (100%) | 10 (1%) |
| Hosts down | 1,000, still down after a reboot | 0 |
| Events lost | n/a (host gone) | 10, one per exposed host (the event whose transaction trapped) |
| Time to recover | Manual, per machine (real incident: days) | Fleet rolled back 939 ms after publish |

**What LLP did.** Each exposed host's trap was contained to the one event. The host threw away that
event's writes, reverted the layer to the previous version and reported `reverted`. The rollout saw
10 of 10 tried hosts fail at the 1% step, stopped widening and published a rollback.

**Where LLP wouldn't help.**
- The shadow check didn't catch this. It renders the layer against real state, and this layer only
  fails on an event. It was caught at the first live event instead. A layer whose view also touched
  the content (for example, "last detection") would have been rejected before going live.
- Falcon runs in the Windows kernel. LLP layers run in a WebAssembly sandbox in user space.
  Getting the same protection for a kernel component would mean interpreting the content in a
  sandbox (the role eBPF's verifier plays on Linux). That isn't something an LLP host can do from outside.
- For a security product, one dropped event can be one missed detection.

## 2. Knight Capital, 1 August 2012

**What happened.** (SEC order, October 2013.) Knight deployed new code for the Retail Liquidity
Program to its SMARS order router. A technician copied it to only 7 of the 8 servers, with no
second review and no written deployment procedure. The new code reused a flag that, on the old code,
switched on "Power Peg", a feature retired years earlier but never removed. In 2005 Knight had moved
Power Peg's cumulative-quantity check and never retested it, so Power Peg no longer saw its orders as
filled. Flagged orders sent to the 8th server set off Power Peg, which "continuously sent child
orders". Knight's attempted fix uninstalled the new code from the 7 good servers, which
"worsened the problem". The result was 4 million executions in 154 stocks for more than 397 million
shares in about 45 minutes, over 4 million orders sent while trying to fill 212 customer orders, and
a loss of more than $460 million.

**Model.** There are 8 servers, 45 simulated minutes in 10-second ticks, and 212 flagged 1,000-share
parent orders spread over the window. On `kn_smars_old`, a flagged order starts Power Peg, which
sends a 100-share child order every tick and never stops. On `kn_smars_rlp`, a flagged order sends
one child order. Under LLP, the stand-in for "the copy never happened" is that the 8th server's
control channel is down when the release goes out. It keeps taking orders but can't hear the
controller, and it reconnects at minute 5.

**Results.**

| Run | Child orders (212 intended) | Shares (212,000 intended) |
|---|---|---|
| Legacy: 7 of 8 deployed | 3,676 (server 8: 3,490) | 535,000 |
| Legacy, plus rolling the 7 back at minute 22.5 (timing illustrative) | 9,974 | 1,081,100 |
| LLP, flag gated on `complete` | **212** | **212,000** |
| LLP, flag gated on `converged` | 243 | 212,400 |
| LLP, no gate | 243 | 212,400 |

**What LLP did.** No copying by hand: every server pulls the signed release. The moment the release
went out, the convergence report showed 7 live, 1 offline, and named `smars-8` as the laggard. When
the 8th server reconnected, it was handed the current release automatically. With the flag held
until the fleet was complete, Power Peg never ran.

**A bug this case found in LLP.** The fleet report's `converged` flag ignored offline hosts, by
design for device fleets (a phone that's switched off shouldn't block a release). But a host can
be offline to the controller while still serving traffic, and that is exactly Knight's 8th server.
Gating on `converged` gave the same result as no gate at all. This study added a `complete` field
(converged, and no known host offline) in `tools/fleet.mjs`, with a note in SPEC section 12.
Anything that breaks when two versions run side by side should wait for `complete`.

**Where LLP wouldn't help.**
- The root bug is semantic: a reused flag and dead code. Nothing traps or hangs, so the time budget,
  shadow check and auto revert see nothing wrong. LLP limits the damage only through convergence
  tracking plus a gate that someone has to use.
- If the flag is flipped early, the 8th server runs Power Peg until it catches up. That was 31
  unintended orders in 5 minutes here. If it never caught up, it would be the full incident again.
- "One swap rolls everything back" is no help here. Rolling back to the old code with the flag
  still on is exactly the move that made Knight's morning worse.

## 3. Cloudflare, 2 July 2019

**What happened.** (Cloudflare's postmortem.) At 13:42 UTC, an engineer deployed a minor change to
the WAF's XSS rules. Rule changes were allowed to go to the whole network at once. One regex
contained `.*(?:.*=.*)` and "backtracked enormously". CPUs serving HTTP/HTTPS hit nearly 100%
across the network, and Cloudflare lost about 80% of its traffic. At 14:07 a "global terminate"
disabled the WAF worldwide, and traffic was back by 14:09, 27 minutes of downtime. The fixes
included bringing back CPU protection, profiling rule performance, a regex engine with run-time
guarantees (re2 or Rust's), and staged rollout for rule changes.

**Model.** `cf_waf` checks requests against literal rules. `cf_waf_bad` adds the costly part of the
pattern, written as `**=*`, run by a small backtracking matcher like the PCRE-style engine the WAF
used. On a ~1 KB request body with no `=`, one call takes about 3 s. There are 20 edges, each in a
closed loop (the next request when the last is answered), with half GETs with a query string and
half ~1 KB JSON POSTs. Legacy edges each run on their own thread with no time limit. LLP edges run
each layer in a worker with the default 100 ms call budget.

**Results.**

| | Legacy (global push) | LLP (10 → 50 → 100%) | LLP (100% at once) |
|---|---|---|---|
| Edges that ran the rule | 20 | 1 | 20 |
| Requests served per 2 s window | 106,074 → 10 | no measurable drop | no measurable drop |
| Failed requests | everything still queued | 1 | 20 |
| Availability while the rule was out | ~0% | 99.998% | 99.956% |
| Recovery | a human runs a global kill (real: 25 min) | auto, rollback done ~2.3 s after publish (mostly the 2 s traffic window) | same |

**What LLP did.** The first POST on each exposed edge hit the 100 ms budget. The worker was killed,
the call's writes were dropped, and the edge reverted to the previous rule set and kept serving.
That happened once per edge, costing about 100 ms of one core each. The rollout saw the revert and
rolled back. The 100% push matters because Cloudflare kept an emergency global path for rule
changes. Without staging, the time budget and per-host revert alone still kept the fleet up.

**Where LLP wouldn't help, or helps less.**
- The rule never got to do its job. Reverting keeps the edge serving, but with the old rules. If the
  rule was blocking a live attack, that protection is gone until someone fixes the regex.
- If there's no earlier version to revert to (a brand-new rule layer), the host restarts the same
  layer. Every bad request then costs 100 ms and fails, so throughput drops a lot, but not to zero.
- 100 ms per call is a blunt tool. A regex engine with linear-time guarantees, as Cloudflare
  adopted, removes the failure mode itself. LLP only contains it.

## 4. Fastly, 8 June 2021

**What happened.** (Fastly's summary.) A software deployment that began on 12 May introduced a bug.
At 09:47 UTC on 8 June, a customer pushed "a valid configuration change" that set off the bug under
specific circumstances, and 85% of Fastly's network returned errors. Fastly detected it within a
minute, and 95% of the network was back within 49 minutes. Fastly's own follow-ups included
building more resilience into the platform using WebAssembly isolation (Compute@Edge).

**Model.** `fa_edge_v1` is the edge before 12 May. `fa_edge_v2` adds a feature that spreads a
customer's objects over `cfg.<customer>.shards` shards (default 4). Zero is a valid setting, but the
new code divides by it, and that traps. There are 20 edges and 10 customers. Legacy: a trap
crashes the edge process, taking every customer on it with it. LLP: `v2` goes out on "12 May"
through a 10 → 50 → 100% rollout under traffic, and on "8 June" customer `acme` sets `shards` to 0.
The config is data, so it reaches every edge at once.

**Results.**

| | Legacy | LLP |
|---|---|---|
| The 12 May release's staged rollout | n/a | **passed** (nobody had the trigger yet) |
| Edges down after the config change | 20 of 20 | 0 |
| Availability, all customers | 0% | 99.667% (20 failed of 6,000) |
| Availability, customers other than `acme` | 0% | 100% |
| `acme` served after the revert | no | yes |
| What the operator sees | errors everywhere | the controller shows all 20 edges `reverted` on the current release |

**What LLP did.** Each edge's first `acme` request trapped. That one request failed, the edge
reverted to the release before the bug, and it kept serving everyone, `acme` included. The
controller's report turned into a fleet-wide alarm: every host reverted the current release.

**Where LLP wouldn't help, or helps less.**
- **Staged rollout didn't catch it.** The latent bug passed its own rollout weeks earlier, and LLP
  rolls out code, not customer config. Config is data, so it reached every edge at once. LLP has no
  shadow check for a data change today. That is a real gap, and the obvious next feature.
- The recovery works only because the previous release didn't have the bug. If the bug had been in
  every kept version (LLP keeps 5 by default), the slot restarts the same version, and every
  triggering request fails while other requests still work.
- The edges now run the release the controller didn't ask for. An edge that restarts fetches `v2`
  again and reverts again on the next trigger. Someone still has to ship the fix.
- The legacy column is worse than reality (0% vs Fastly's 15% still working), because every
  simulated edge receives the triggering traffic.

## 5. The hotfix that waits on a release

**The problem.** This is not one incident but a pattern. A one-line bug ships in a live app or game,
the fix takes minutes to write, and then it waits on a build, store review and users updating.
Google has at times told developers to expect Play review to take 7 days or longer, and even after
approval, users only get the fix when they update.

**Model.** There are 1,000 live game clients, each mid-session (coins, level, items). `hf_game_v1`
charges 10x for shop items, so a player with 100 to 300 coins can't buy an 80-coin item.
`hf_game_v2` is the one-line fix, rolled out 1 → 10 → 50 → 100%.

**Results.** The fix reached all 1,000 running clients **1,361 ms** after publish, with no restart.
1,000 of 1,000 sessions were identical before and after the swap, and the same purchase that failed
for every player before the fix succeeded for every player after.

**Where LLP wouldn't help, or needs care.**
- We didn't simulate the store path, so there's no measured comparison. The "days" figure is
  Google's own guidance, not our measurement.
- **Store rules.** Google Play doesn't let an app download executable code (such as dex, JAR or .so
  files) from outside Play. It exempts code that runs in a virtual machine or interpreter with only
  indirect access to Android APIs. LLP layers are sandboxed WebAssembly with capability-mediated
  access, which looks like the exempt case. That's our reading of the policy, not a ruling, and it
  needs checking before anyone ships this in a Play app.
- The time is a lower bound. All 1,000 clients and the controller share one process, with 1 to 10 ms
  of simulated latency per hop. Real networks add round trips, though each client still only
  fetches one small blob.

---

## Limits that apply to every case

- **Simulated fleets.** All the hosts in a case run in one Node process (the legacy Cloudflare edges
  each get a thread), and messages carry 1 to 10 ms of random delay. Counts (hosts, requests,
  orders) are exact. Times are what this machine measured, not what a global fleet would see.
- **Inline isolation in cases 1 and 5.** Running 1,000 hosts with a worker per layer would need
  1,000 threads, so these cases run layers on the host's thread (`isolation: "inline"`). A trap is
  caught exactly the same way inline. Only the time budget needs a worker, and cases 3 and 4 use
  workers with the default 100 ms limit.
- **Mechanisms, not systems.** Each layer is a few dozen lines that reproduce one failure's
  mechanism. The real systems have far more going on. Read these as "this failure mode, delivered
  this way", not "Knight running on LLP".
- **LLP catches crashes and hangs, not wrong answers.** The time budget, the trap handling and the
  revert catch layers that fail. A layer that runs fine but does the wrong thing (Knight) gets through
  until something else notices, such as a gate on convergence or a metric someone watches.
- **Fleet size.** A 10,000-host run of case 1 didn't finish in 8 minutes on this machine (1,000
  hosts take about 2.5 s), so the results stop at 1,000. The likely cause, not yet profiled, is that
  the fleet controller re-scans every host on every status message. That needs fixing before LLP
  drives a large fleet.

## Reproduce

```sh
npm ci
npm run build          # optional: the .wasm files are committed in build/
npm run case-studies   # runs all five, prints 17 checks, writes docs/case-studies-results.json
CASE_HOSTS=200 npm run case-studies   # smaller fleet for cases 1 and 5
```

`npm test` runs the same checks (without writing the results file).

## Sources

- CrowdStrike, [Remediation and Guidance Hub: Channel File 291 Incident](https://www.crowdstrike.com/en-us/blog/statement-on-falcon-content-update-for-windows-hosts/) (release 04:09 UTC, revert 05:27 UTC, preliminary PIR), and the [Root Cause Analysis, executive summary](https://crowdstrike.com/wp-content/uploads/2024/08/Executive-Summary_Root-Cause-Analysis_Channel-File-291.pdf) (20 vs 21 fields, deployment rings).
- TechCrunch, [Microsoft says 8.5M Windows devices were affected by CrowdStrike outage](https://techcrunch.com/2024/07/20/microsoft-says-8.5m-windows-devices-were-affected-by-crowdstrike-outage), quoting Microsoft's David Weston.
- U.S. SEC, [press release 2013-222](https://www.sec.gov/news/press-release/2013-222), and the [order against Knight Capital Americas LLC](https://contracts.justia.com/companies/kcg-holdings-inc-18985/contract/555902) (7 of 8 servers, the repurposed flag, Power Peg, the rollback that made it worse, 4 million executions, more than $460 million).
- Cloudflare, [Details of the Cloudflare outage on July 2, 2019](https://blog.cloudflare.com/details-of-the-cloudflare-outage-on-july-2-2019).
- Fastly, [Summary of June 8 outage](https://fastly.com/blog/summary-of-june-8-outage).
- Google, [Play policy: Device and Network Abuse](https://support.google.com/googleplay/android-developer/answer/9888379?hl=en). Android Police, [Google Play Store app reviews will take 7 days or longer](https://www.androidpolice.com/2020/03/16/google-play-store-app-reviews-will-take-7-days-or-longer) (2020).

---

## Draft post

> **We replayed 4 famous outages through a live-code protocol. Here's what changed, and what didn't.**
>
> CrowdStrike 2024, Knight Capital 2012, Cloudflare 2019 and Fastly 2021 all have one thing in
> common: a change reached a lot of machines before anything checked that it worked.
>
> We built LLP (Live Layer Protocol), which streams signed WebAssembly "layers" into running apps
> and servers. There's no restart and no CI/CD pipeline. Each layer is checked against real state
> before it goes live, rolled out in stages, given a time budget per call, and reverted on the
> host the moment it fails.
>
> Then we rebuilt each incident's failure as a small simulation and ran it both ways:
>
> - **CrowdStrike:** a content update that reads past its input. Pushed to all 1,000 hosts: 1,000
>   crash. Through LLP: it halts at the 1% step. 10 hosts saw it, 0 went down, and the fleet rolled
>   back in under a second.
> - **Cloudflare:** a backtracking regex. Pushed globally: throughput goes to ~0. Through LLP,
>   *even pushed to 100% at once*: the 100 ms budget kills the stuck call, each edge falls back to
>   the old rules, and availability stays at 99.96%.
> - **Fastly:** a latent bug set off by a customer's config. The buggy release had passed staged
>   rollout weeks earlier, so LLP didn't catch it either. But no edge went down: each one dropped one
>   request, reverted and kept serving, at 99.7% availability.
> - **Knight Capital:** a deploy that missed 1 of 8 servers. LLP's fleet report named the missing
>   server at once. Our sim also found a bug in LLP: its "converged" signal ignored offline hosts,
>   which is exactly Knight's failure. We fixed it.
>
> Where it doesn't help: logic that's wrong but doesn't crash (Knight's reused flag), config
> changes (Fastly's trigger), and kernel code (CrowdStrike runs where no WASM sandbox can reach).
>
> Every number comes from a script you can run: `npm run case-studies`. Write-up, sources and
> limits: [link]
