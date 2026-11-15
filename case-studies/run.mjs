// Runs the five case studies (docs/CASE-STUDIES.md), checks the claims the write-up makes, prints a
// summary and writes every measured number to docs/case-studies-results.json.
// Usage: npm run case-studies            (CASE_HOSTS=n changes the CrowdStrike and hotfix fleet size)
//        node case-studies/run.mjs --no-write   (check only, used by npm test)
import { writeFileSync } from "node:fs";
import * as crowdstrike from "./crowdstrike.mjs";
import * as knight from "./knight.mjs";
import * as cloudflare from "./cloudflare.mjs";
import * as fastly from "./fastly.mjs";
import * as hotfix from "./hotfix.mjs";

const N = +(process.env.CASE_HOSTS || 1000);
const results = [];
const check = (name, cond, detail = "") => { results.push(!!cond); console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };
const out = { generated: new Date().toISOString(), node: process.version, cases: {} };

console.log(`\n== 1. CrowdStrike 2024: bad content update, ${N} hosts ==`);
const cs = out.cases.crowdstrike = await crowdstrike.run({ hosts: N });
check("C1 legacy: the update pushed to everyone crashes every host, and a reboot crashes it again", cs.legacy.crashed === N && cs.legacy.stillDownAfterReboot === N, `${cs.legacy.crashed}/${N} down`);
check("C2 LLP: the staged rollout halts at its first step that reaches hosts and rolls the fleet back", cs.llp.rolledBack && cs.llp.recovered && cs.llp.onBadUpdateAtEnd === 0, `halted at ${cs.llp.haltedAt}% (${cs.llp.reason}); fleet rolled back ${cs.llp.msPublishToFleetRolledBack} ms after publish`);
check("C3 LLP: no host goes down; only the first cohort ever runs the update; each drops one event", cs.llp.hostsDown === 0 && cs.llp.hostsThatRanBadPct <= 2 && cs.llp.eventsDropped === cs.llp.hostsThatRanBadUpdate,
  `${cs.llp.hostsThatRanBadUpdate} hosts (${cs.llp.hostsThatRanBadPct}%) ran it, ${cs.llp.eventsDropped} events dropped, ${cs.llp.hostsDown} down`);

console.log("\n== 2. Knight Capital 2012: partial deploy, 8 servers, 45 simulated minutes ==");
const kn = out.cases.knight = await knight.run();
check("K1 legacy: the 8th server on old code floods the market with child orders", kn.legacy.unintendedChildOrders > 10 * kn.legacy.parentOrders, `${kn.legacy.childOrders} child orders for ${kn.legacy.parentOrders} parent orders (server 8: ${kn.legacy.perServer[7]})`);
check("K2 legacy: rolling the 7 good servers back to old code makes it worse", kn.legacyWithRollback.childOrders > kn.legacy.childOrders, `${kn.legacyWithRollback.childOrders} child orders`);
check("K3 LLP: the convergence report flags the 8th server as offline the moment the release goes out", kn.llpGatedOnComplete.convergenceAtRelease.offline === 1 && kn.llpGatedOnComplete.convergenceAtRelease.laggards[0] === "smars-8" && !kn.llpGatedOnComplete.convergenceAtRelease.complete);
check("K4 LLP: gating the flag on a complete fleet sends exactly one child order per parent order", kn.llpGatedOnComplete.unintendedChildOrders === 0, `flag on at minute ${kn.llpGatedOnComplete.flagOnAtMinute}, ${kn.llpGatedOnComplete.childOrders} child orders`);
check("K5 honest limit: gating on 'converged' (ignores offline hosts) or not gating still lets the 8th server run Power Peg until it catches up",
  kn.llpGatedOnConverged.unintendedChildOrders > 0 && kn.llpUngated.unintendedChildOrders > 0 && kn.llpUngated.unintendedChildOrders < kn.legacy.unintendedChildOrders,
  `${kn.llpUngated.unintendedChildOrders} unintended child orders, stopped when it caught up at minute ${kn.llpUngated.allServersOnNewCodeAtMinute}`);

console.log("\n== 3. Cloudflare 2019: backtracking regex in a WAF rule ==");
const cf = out.cases.cloudflare = await cloudflare.run();
check("F1 legacy: the rule pushed to every edge at once takes throughput to ~0", cf.legacy.throughputPctOfNormal < 1, `${cf.legacy.servedPerWindowAfter} vs ${cf.legacy.servedPerWindowBefore} requests per ${cf.windowMs} ms window`);
check("F2 LLP: the 100 ms budget kills the stuck call, the edge reverts, the rollout halts and rolls back", cf.llp.rolledBack && cf.llp.recovered && cf.llp.callsKilledByTimeBudget === cf.llp.edgesThatRanBadRule && cf.llp.requestsFailedDuringRollout === cf.llp.edgesThatRanBadRule,
  `${cf.llp.edgesThatRanBadRule} of ${cf.edges} edges ran it, ${cf.llp.requestsFailedDuringRollout} requests failed, availability ${cf.llp.availabilityDuringRolloutPct}%`);
check("F3 LLP even with a global push (no staging): one failed request per edge, then the old rule serves", cf.llpGlobalPush.edgesThatRanBadRule === cf.edges && cf.llpGlobalPush.requestsFailedDuringRollout === cf.edges && cf.llpGlobalPush.availabilityDuringRolloutPct > 99,
  `availability ${cf.llpGlobalPush.availabilityDuringRolloutPct}%`);

console.log("\n== 4. Fastly 2021: latent bug, set off by a customer's config change ==");
const fa = out.cases.fastly = await fastly.run();
check("S1 legacy: the config change crashes every edge, so every customer gets errors", fa.legacy.edgesDown === fa.edges && fa.legacy.otherCustomersAvailabilityPct === 0);
check("S2 honest limit: the buggy release passed its own staged rollout weeks earlier", fa.llp.may12RolloutPassed && fa.llp.edgesOnV2BeforeTrigger === fa.edges);
check("S3 LLP: each edge drops one request, reverts to the release before the bug and keeps serving everyone", fa.llp.edgesDown === 0 && fa.llp.requestsFailed === fa.edges && fa.llp.otherCustomersAvailabilityPct === 100 && fa.llp.acmeServedAfterRevert,
  `availability ${fa.llp.availabilityPct}%, ${fa.llp.requestsFailed} failed requests`);
check("S4 LLP: the controller sees every edge revert the current release (the alarm)", fa.llp.controllerSees.reverted === fa.edges && !fa.llp.controllerSees.converged);

console.log(`\n== 5. Hotfix without a release: ${N} live game clients ==`);
const hf = out.cases.hotfix = await hotfix.run({ clients: N });
check("H1 the fix reaches every running client through a staged rollout, no restart", hf.rolloutOk && hf.converged && hf.clientsOnFix === N, `${hf.msFixPublishedToAllClients} ms from publish to 100%`);
check("H2 no player loses their session, and the broken purchase now works", hf.sessionsLost === 0 && hf.purchaseWorksBefore === 0 && hf.purchaseWorksAfter === N);

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
if (!process.argv.includes("--no-write")) {
  writeFileSync(new URL("../docs/case-studies-results.json", import.meta.url), JSON.stringify(out, null, 1) + "\n");
  console.log("wrote docs/case-studies-results.json");
}
process.exit(passed === results.length ? 0 : 1);
