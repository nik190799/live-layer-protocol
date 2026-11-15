// Interop between the JavaScript tools and the independent Go host (impl/go), over real sockets.
//   node test/interop-go.mjs        (needs Go 1.24+; builds impl/go/cmd/llp-host first)
// G1-G6: the reference publisher (tools/publisher.mjs) streams to a Go host.
// G7-G14: the reference fleet controller (tools/fleet.mjs) runs a mixed fleet of Go and JS hosts.
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetController, serve } from "../tools/fleet.mjs";
import { bucketOf } from "../host/fleet.js";

const root = new URL("..", import.meta.url).pathname;
const build = (f) => join(root, "build", f);
const results = [];
const check = (name, cond, detail = "") => { results.push({ name, pass: !!cond }); console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const work = mkdtempSync(join(tmpdir(), "llp-go-interop-"));
const procs = [];

// ---------- build the Go host ----------
const bin = join(work, "llp-host");
try { execFileSync("go", ["build", "-o", bin, "./cmd/llp-host"], { cwd: join(root, "impl/go"), stdio: "inherit" }); }
catch (e) { console.error("can't build the Go host (is Go 1.24+ installed?)"); process.exit(1); }

// A child process that prints one JSON object per line.
function run(cmd, args, { cwd = work, json = true } = {}) {
  const p = spawn(cmd, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
  procs.push(p);
  const out = [];
  let buf = "", err = "";
  p.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!json) { out.push(line); continue; } try { out.push(JSON.parse(line)); } catch { out.push({ raw: line }); } } });
  p.stderr.on("data", (d) => { err += d; });
  const waitFor = async (test, ms = 8000) => { const t0 = Date.now(); for (;;) { const hit = out.find(test); if (hit) return hit; if (Date.now() - t0 > ms) return null; await sleep(20); } };
  return { p, out, waitFor, send: (line) => p.stdin.write(line + "\n"), err: () => err, kill: () => p.kill() };
}

try {
  // ---------- G: publisher -> Go host (SPEC section 5) ----------
  const pubDir = join(work, "pub");
  execFileSync("mkdir", ["-p", pubDir]);
  copyFileSync(build("tasks.wasm"), join(pubDir, "main.wasm"));
  copyFileSync(build("stats.wasm"), join(pubDir, "footer.wasm"));
  const port = 7900 + Math.floor(Math.random() * 50);
  const pub = run("node", [join(root, "tools/publisher.mjs"), "--port", String(port), "main=main.wasm", "footer=footer.wasm"], { cwd: pubDir, json: false });
  await pub.waitFor((l) => l.startsWith("publisher on"));
  const go = run(bin, ["--key", join(pubDir, "keys/publisher.pub.json"), "--quiet-render", `ws://127.0.0.1:${port}`]);
  const ack1 = await go.waitFor((m) => m.ev === "ack");
  check("G1 Go host verifies the JS publisher's signed manifest, fetches both blobs and acks", !!ack1 && (await pub.waitFor((l) => l.includes("host is live"))), ack1 ? `v${ack1.version} in ${ack1.ms} ms` : go.err());

  go.send("set draft from go"); go.send("click main add"); go.send("click main t:0"); go.send("state");
  const st1 = await go.waitFor((m) => m.ev === "state");
  check("G2 events and bound inputs run on the Go host (AssemblyScript + C layers)", st1?.kv["tasks.0.text"] === "from go" && st1?.kv["tasks.0.done"] === 1, JSON.stringify(st1?.kv));

  copyFileSync(build("tasks_v2.wasm"), join(pubDir, "main.wasm"));
  const ack2 = await go.waitFor((m) => m.ev === "ack" && m.version > ack1.version);
  go.send("state");
  const st2 = await go.waitFor((m) => m.ev === "state" && m.version === ack2?.version);
  check("G3 a file change on the publisher swaps the Go host live; state survives and the migration runs", !!ack2 && st2?.kv["tasks.0.text"] === "from go" && st2?.kv["tasks.0.pri"] === 1 && st2?.kv["__schema.main"] === 2, JSON.stringify(st2?.kv));

  copyFileSync(build("tasks_broken.wasm"), join(pubDir, "main.wasm"));
  const nack = await go.waitFor((m) => m.ev === "nack");
  const pubSaw = await pub.waitFor((l) => l.includes("host rejected"));
  check("G4 a broken release is refused with code layer_failed and the publisher hears the nack", nack?.code === "layer_failed" && !!pubSaw, nack?.reason);
  go.send("state");
  const st3 = await go.waitFor((m) => m.ev === "state" && m !== st2 && m.version === ack2.version);
  check("G5 after the refusal the Go host still runs the previous release", st3?.running.main === st2.running.main);

  // A JS host on the same stream, for comparison: same layers, same verdicts.
  copyFileSync(build("tasks_v2.wasm"), join(pubDir, "main.wasm"));
  const ack3 = await go.waitFor((m) => m.ev === "ack" && m.version > ack2.version);
  const js = run("node", [join(root, "host/node-host.mjs"), `ws://127.0.0.1:${port}`, join(pubDir, "keys/publisher.pub.json")], { json: false });
  const jsLive = await js.waitFor((l) => l.includes(`v${ack3?.version} live`));
  check("G6 the JS host and the Go host go live on the same release from one publisher", !!ack3 && !!jsLive);
  go.kill(); js.kill(); pub.kill();

  // ---------- fleet: controller -> mixed Go + JS fleet (SPEC section 12) ----------
  const refusals = [];
  const fleet = await FleetController.create({ app: "demo.tasks", roots: 1, onEvent: (e) => { if (e.kind === "refused") refusals.push(e); } });
  const fport = port + 60;
  const wss = await serve(fleet, { port: fport, host: "127.0.0.1" });
  const kdir = join(work, "fleet");
  execFileSync("mkdir", ["-p", kdir]);
  const pinned = join(kdir, "keyring.pinned.json");
  writeFileSync(pinned, JSON.stringify(fleet.keyring));
  const url = `ws://127.0.0.1:${fport}`;
  const goHosts = ["go-0", "go-1", "go-2", "go-3"].map((id) => run(bin, ["--fleet", pinned, "--id", id, "--channel", "stable", "--quiet-render", url]));
  const jsHost = run("node", [join(root, "host/fleet-host.mjs"), url, pinned, "--id", "js-0", "--channel", "stable"]);
  const ids = ["go-0", "go-1", "go-2", "go-3", "js-0"];
  const allSeen = await fleet.waitFor(() => ids.every((id) => fleet.hosts.get(id)?.online), 8000);
  check("G7 Go hosts pass the controller's device-key challenge (signed hello) next to a JS host", allSeen, [...fleet.hosts.keys()].join(","));

  const tasks = await fleet.addBlob(new Uint8Array(readFileSync(build("tasks.wasm"))));
  const v2 = await fleet.addBlob(new Uint8Array(readFileSync(build("tasks_v2.wasm"))));
  const broken = await fleet.addBlob(new Uint8Array(readFileSync(build("tasks_broken.wasm"))));
  const ver1 = await fleet.publish("stable", { main: tasks });
  const conv1 = await fleet.waitForConvergence("stable", 8000);
  const c1 = fleet.convergence("stable");
  check("G8 a release converges across the mixed fleet; every host reports live", conv1 && c1.live === 5, JSON.stringify({ live: c1.live, pending: c1.pending, rejected: c1.rejected, reasons: c1.reasons }));

  // A seed that splits the fleet: some Go hosts in the share, some out, so the check can't pass vacuously.
  let seed;
  for (let i = 0; !seed; i++) { const inShare = []; for (const id of ids) if ((await bucketOf(id, `interop-${i}`)) < 5000) inShare.push(id); const goIn = inShare.filter((id) => id.startsWith("go")).length; if (goIn >= 1 && goIn <= 3) seed = `interop-${i}`; }
  const ver2 = await fleet.publish("stable", { main: v2 }, { percent: 50, seed });
  await fleet.waitFor(() => fleet.convergence("stable").pending === 0, 8000);
  const want = new Set(await fleet.expectedShare("stable"));
  const live = ids.filter((id) => fleet.hosts.get(id).version === ver2);
  const skipped = ids.filter((id) => fleet.hosts.get(id).state === "skipped");
  check("G9 a 50% share reaches exactly the hosts the controller's bucket function picks (Go and JS agree)", want.size > 0 && want.size < 5 && live.length === want.size && live.every((id) => want.has(id)) && live.length + skipped.length === 5, `in share: ${[...want].join(",") || "none"}; live: ${live.join(",")}; skipped: ${skipped.join(",")}`);

  await fleet.setPercent("stable", 100);
  check("G10 widening to 100% brings every host to the release", await fleet.waitForConvergence("stable", 8000) && fleet.convergence("stable").live === 5);

  const kr = await fleet.rotateReleaseKey();
  const rotated = await fleet.waitFor(() => ids.every((id) => fleet.hosts.get(id).keyring === kr) && fleet.convergence("stable").converged, 8000);
  check("G11 release-key rotation: every host accepts keyring 2 and the re-signed release in the new epoch", rotated, JSON.stringify(ids.map((id) => [id, fleet.hosts.get(id).keyring, fleet.hosts.get(id).state])));

  const roll = await fleet.rollout("stable", { main: broken }, { steps: [50, 100], timeoutMs: 8000 });
  check("G12 a gated rollout of a broken release halts and rolls back; Go hosts report rejected like JS hosts", !roll.ok && roll.recovered, JSON.stringify({ haltedAt: roll.haltedAt, reason: roll.reason, reasons: roll.reasons }));

  // Restart a Go host: its trust dir keeps the device key (the controller bound go-0 to it) and keyring 2.
  goHosts[0].kill();
  await fleet.waitFor(() => !fleet.hosts.get("go-0").online, 5000);
  const saved = JSON.parse(readFileSync(join(kdir, "trust", "go-0.keyring.json"), "utf8"));
  const again = run(bin, ["--fleet", pinned, "--id", "go-0", "--channel", "stable", "--quiet-render", url]);
  const back = await fleet.waitFor(() => fleet.hosts.get("go-0").online && fleet.hosts.get("go-0").keyring === kr && fleet.convergence("stable").converged, 8000);
  check("G13 a restarted Go host keeps its device key and its latest keyring (trust dir), and rejoins", back && saved.keyring === kr);

  // A Go host with a different device key can't take over go-1's id.
  const thief = run(bin, ["--fleet", pinned, "--id", "go-1", "--channel", "stable", "--no-trust-dir", "--quiet-render", url]);
  await sleep(800);
  const refused = refusals.some((e) => e.host === "go-1" && /different device key/.test(e.reason)) && fleet.hosts.get("go-1").conns.size === 1;
  check("G14 an impostor with another device key is refused the id", refused, JSON.stringify(refusals));
  for (const h of [...goHosts, again, thief, jsHost]) h.kill();
  wss.close();
} finally {
  for (const p of procs) try { p.kill(); } catch {}
  rmSync(work, { recursive: true, force: true });
}
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed} of ${results.length} Go interop checks passed`);
process.exit(failed ? 1 : 0);
