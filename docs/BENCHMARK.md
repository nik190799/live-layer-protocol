# Shipping speed: LLP vs a traditional rebuild-and-restart deploy

This compares how long it takes for a code change to be running, with LLP and with a traditional flow. Every figure is labelled either **measured** (we ran it, here, with `npm run bench`) or **cited** (from a published industry report, not run by us). Raw output from the run quoted below: [`benchmark-results.json`](benchmark-results.json).

**Machine for the measured run:** 4-core Intel Xeon @ 2.10 GHz, 16 GB RAM, Linux, Node v22.23.4, Docker 29.9.2. A cloud VM, so treat absolute numbers as indicative; the ratios are what matter.

## Reproduce

```bash
npm install
docker pull node:22-alpine     # optional, for the Docker baseline
npm run bench                  # full run, about 70 s. --quick for a smoke run, --only=fleet,rollback to pick sections, --no-docker to skip Docker
```

Results land in `bench/out/results.json`. Each timing is reported as p50 / p95 over repeated trials (nearest-rank percentiles).

## The short answer

> **Update (sandbox, PR #3):** layers now run in workers with time and memory limits. With that change, a quick re-run on the same kind of machine measured a 3.0 ms swap (p50, was 1.6 ms) and 3.1 ms to revert a crashing layer (was 0.17 ms, because the revert now loads the old version into a fresh worker). File saved to live took 88 ms for 1 host, 154 ms for 100 and 597 ms for 1,000 simulated hosts. The simulated fleet runs layers inline, because hundreds of devices share one process, so its numbers don't include worker cost. The tables below are from the original run.
>
> **Update (2026-11-17):** the rollback section used a schema-2 layer as the good version and a schema-1 layer as the crashing one. Since reverts stopped crossing schemas (red-team ST-01), the host rightly declined that revert and the benchmark's own check reported `false`. It now uses a same-schema base. A full re-run on the same kind of machine measured 2.3 ms for a warm swap, 2.3 ms to revert a crashing layer and 7.0 ms to refuse a broken one (all p50). The raw output is in [`paper/results/benchmark.json`](../paper/results/benchmark.json).

| Step | Traditional | LLP |
|---|---|---|
| Build the change | **Measured** 0.30 s Docker image build, warm cache, trivial app (p50). **Cited** CI workflows average 2 min 49 s (CircleCI 2024) | **Measured** 1.4 s to compile the changed AssemblyScript layer, 0.12 s for the C layer (p50) |
| Sign and publish | Registry push (not measured, see below) | **Measured** 0.41 ms (hash + sign, p50) |
| Go live on one machine | **Measured** 0.75 s Docker rebuild and replace (p50), 46 ms bare process restart | **Measured** 1.6 ms swap in the host (p50), 87 ms from file saved to live over WebSocket (80 ms of that is the publisher's fixed file-watch debounce) |
| Go live on 100 / 1000 hosts | Not measured, and no published figure found to cite | **Measured** 0.15 s / 0.59 s until every host is live (p50), all simulated on one 4-core machine |
| Downtime during the change | **Measured** about 0.45 s unreachable per Docker replace | **Measured** none: the old version serves until the atomic commit |
| User data after the change | **Measured** lost on every trial (in-memory state) | **Measured** kept on every trial and every host, including a schema migration |
| Bad version | Caught by tests or after release; rollback is a redeploy. **Cited** average recovery 57 min (CircleCI 2024), elite teams under 1 hour (DORA 2024) | **Measured** refused before going live in 1.7 ms; a version that crashes after going live is reverted, with state restored, in 0.17 ms |

**What this shows honestly:**

- The LLP shipping step is real and fast: about 1.6 ms to swap on a device and about 0.6 s to converge 1,000 hosts on a single small machine, with no downtime and no data loss.
- On one machine, for a tiny app, a traditional deploy is **not slow either**: a bare process restart took 46 ms and a full Docker rebuild-and-replace took 0.75 s. LLP's clear measured wins on one machine are **state kept, zero downtime, and instant automatic rollback**, not raw restart speed.
- The big time gap between LLP and today is in the parts a local benchmark cannot reproduce: the CI pipeline, the image registry, staged rollouts across a fleet, and app-store review. Those figures are cited below, not measured.
- Two figures in the earlier rough comparison were too pessimistic about today's tooling. CircleCI's 2024 data puts the **average CI workflow at 2 min 49 s**, not 10 to 40 min. DORA's 2024 elite lead time is **under one day**, not under one hour (the under-one-hour figure is from older DORA reports).

## Measured: details

### 1. Compile one changed layer

| What | p50 | p95 | Trials |
|---|---|---|---|
| AssemblyScript `layers/variants/tasks_v2.ts` with `-O3` | 1,405 ms | 1,507 ms | 10 |
| C `layers/stats-c/stats.c` with clang `-O2` to wasm32 | 122 ms | 273 ms | 10 |

The recompiled `tasks_v2.wasm` was byte-identical to the committed one. Most of the AssemblyScript time is compiler start-up (it runs on Node), so a watch-mode compiler would be faster. Not measured here.

### 2. Publish and swap, stage by stage (in-process, 200 trials)

| Stage | p50 | p95 |
|---|---|---|
| Hash the layer (SHA-256) | 0.16 ms | 0.29 ms |
| Sign the manifest (ECDSA P-256) | 0.23 ms | 0.36 ms |
| **Publish total** (hash + sign) | **0.41 ms** | 0.64 ms |
| Verify the signature on the host | 0.42 ms | 0.57 ms |
| Instantiate the WebAssembly module alone | 0.67 ms | 0.91 ms |
| **Full swap**, new build of the same layer | **1.57 ms** | 2.35 ms |
| **Full swap with schema migration** (v1 to v2, real user state) | **1.41 ms** | 2.16 ms |

"Full swap" is everything `LiveHost.apply()` does: verify the signature, integrity-check the blob, instantiate, migrate if needed, render the new layer against a shadow copy of the real state, commit atomically, re-render. User state (two tasks) was kept on all 200 trials of each kind. To get a fresh build for every trial and every stage with identical behaviour, the benchmark appends a WebAssembly custom section holding a trial counter, which changes the hash but not the code.

### 3. File saved to live, over real WebSockets

A real `tools/publisher.mjs` process watches the layer file. Simulated hosts (`bench/sim-hosts.mjs`, the same `LiveHost` core and wire protocol as `host/node-host.mjs`) each hold their own WebSocket, blob store and user state. Hosts are spread over 4 processes. The timer starts just before the new `.wasm` is written to disk and stops when a host reports it is live.

| Hosts | Trials | First host live | Median host live | **All hosts live** | Rejected | State kept |
|---|---|---|---|---|---|---|
| 1 | 30 | 87 / 90 ms | 87 / 90 ms | **87 / 90 ms** | 0 | all |
| 100 | 20 | 100 / 107 ms | 127 / 137 ms | **147 / 157 ms** | 0 | all |
| 1,000 | 10 | 175 / 215 ms | 355 / 447 ms | **589 / 692 ms** | 0 | all |

Values are p50 / p95. The publisher waits a fixed 80 ms after a file change before publishing, so about 80 ms of every row is that debounce. The first update for each fleet (v1 to v2, with a schema migration) is reported separately in the JSON and was in the same range (87 ms, 178 ms and 594 ms until all hosts were live). With 1,000 hosts, all 1,000 verify and swap on the same 4 cores, so the run is CPU-bound and per-host apply time grows from 3 ms to about 220 ms from queueing. Real devices would each do their own verify in parallel, so this is a pessimistic simulation for fleet size, and an optimistic one for network (everything is on localhost). One more optimistic effect: V8 caches compiled WebAssembly by its bytes, so the hosts inside one process compile each new layer only once between them (we measured that cache saving at about 0.2 ms per instantiate). The in-process stage timings above use a distinct build per trial, so they do not get this saving.

### 4. Rollback (in-process, 200 trials)

| What | p50 | p95 |
|---|---|---|
| A normal user action on the good version, for comparison | 0.06 ms | 0.10 ms |
| A crashing version goes live, then traps on the next user action: trap caught, state restored, slot reverted, UI re-rendered | **0.17 ms** | 0.29 ms |
| A version that fails its health check is refused before it is ever live | **1.70 ms** | 2.74 ms |

On every trial the host ended on the previous good version with the task count unchanged.

### 5. Traditional baseline on the same machine

The same tiny tasks app, written as a plain Node HTTP server holding its tasks in memory (`bench/baseline/`). Each trial adds two tasks, edits the source, deploys, and waits until `/health` answers.

| Flow | Step | p50 | p95 | Trials |
|---|---|---|---|---|
| Bare process restart | stop, start, healthy | 46 ms | 58 ms | 20 |
| Docker | `docker build` (warm cache, base image already pulled) | 300 ms | 319 ms | 10 |
| Docker | remove old container | 213 ms | 262 ms | 10 |
| Docker | start new container until healthy | 237 ms | 262 ms | 10 |
| Docker | **total** | **746 ms** | 828 ms | 10 |

The tasks were lost on every trial of both flows, and the app was unreachable from the moment the old container was removed until the new one was healthy (about 0.45 s). This baseline is a best case for the traditional flow: a trivial app with no dependencies to install, no tests, no registry push or pull, and one machine.

**Not measured, and why:** a CI pipeline run, a registry push and pull, and a staged rollout to many machines all depend on a real CI service, a registry and a fleet, so we cite them instead of faking them locally.

## Cited (not measured by us)

| Figure | Value | Source |
|---|---|---|
| DORA 2024 elite: deploy frequency / lead time / change failure rate / recovery time | On demand / under 1 day / 5% / under 1 hour | 2024 Accelerate State of DevOps (DORA), [report PDF](https://services.google.com/fh/files/misc/2024_final_dora_report.pdf), cluster values as summarised by [Octopus Deploy](https://octopus.com/blog/2024-devops-performance-clusters) |
| DORA 2024 high | Daily to weekly / 1 day to 1 week / 20% / under 1 day | same |
| DORA 2024 medium | Weekly to monthly / 1 week to 1 month / 10% / under 1 day | same |
| DORA 2024 low | Monthly to every 6 months / 1 to 6 months / 40% / 1 week to 1 month | same |
| Share of organisations in the elite cluster | Under 20% | same |
| CircleCI 2024: average workflow duration | 2 min 49 s (benchmark: 10 min or less) | [CircleCI 2024 State of Software Delivery](https://circleci.com/newsroom/2024-state-of-software-delivery-report/) |
| CircleCI 2024: average recovery time | 57 min 33 s (benchmark: 60 min or less) | same |
| CircleCI 2024: average deploys per day | 1.68 | same |
| CircleCI 2024: main-branch success rate | 82.5% (benchmark: 90%) | same |

## What this does not cover

- **Real network and real devices.** All hosts ran on localhost on one machine.
- **Everything before the build.** Design, code review, human approval and end-to-end testing take the same time either way; LLP speeds up the shipping step, not those.
- **Larger apps.** The layers here are 3 to 12 KB. Swap cost grows with module size and with how much state the shadow render and migration touch; that is not measured yet.
- **Server or edge hosts** (SPEC section 10) are not built, so there is no server-side comparison yet.
