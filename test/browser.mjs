// Browser proof for the worker sandbox: the same host core, in real Chromium.
// Needs Playwright with Chromium (not a dependency of this repo): `node test/browser.mjs`.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const { chromium } = createRequire(import.meta.url)("playwright");

const root = new URL("..", import.meta.url).pathname;
const types = { js: "text/javascript", mjs: "text/javascript", wasm: "application/wasm", html: "text/html" };
const csp = "default-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; worker-src 'none'";
const page = (strict) => `<!doctype html><meta charset="utf-8">${strict ? `<meta http-equiv="Content-Security-Policy" content="${csp}">` : ""}
<script type="module">
import { LiveHost, sha256 } from "/host/llp-core.js";
const out = {}, logs = [];
const get = async (f) => new Uint8Array(await (await fetch("/build/" + f)).arrayBuffer());
const store = new Map(); const put = async (f) => { const b = await get(f); const h = await sha256(b); store.set(h, b); return h; };
const [v2, hang, stats] = [await put("tasks_v2.wasm"), await put("tasks_hang.wasm"), await put("stats.wasm")];
let last = null; const host = new LiveHost({ allowUnsigned: true, onRender: (t) => { last = t; }, onLog: (e) => logs.push(e.kind + ": " + e.msg) });
let v = 0; const ship = (main) => host.apply({ app: "a", version: ++v, layers: { main, footer: stats }, order: ["main", "footer"] }, "", async (h) => store.get(h));
// main-thread heartbeat: the longest gap between ticks is how long the page was frozen
let gap = 0, prev = performance.now(); setInterval(() => { const n = performance.now(); gap = Math.max(gap, n - prev); prev = n; }, 4);
const timed = async (fn) => { gap = 0; prev = performance.now(); const t = performance.now(); const r = await fn(); return { r, ms: Math.round(performance.now() - t), stall: Math.round(gap) }; };
out.first = (await ship(v2)).ms;
if (${strict}) { out.logs = logs; window.__done = out; throw "stop"; } // without workers a loop would freeze this page: that is the point
host.setBound("draft", "hang view");
out.applyHang = await timed(() => ship(hang));
host.setBound("draft", ""); await ship(hang);
host.setBound("draft", "hang event");
out.eventHang = await timed(() => host.dispatch("main", "add"));
out.eventHang.n = host.kv.get("tasks.n") ?? 0; out.eventHang.main = host.slots.get("main").hash === v2 ? "v2" : "hang";
host.setBound("draft", ""); await ship(hang);
host.setBound("draft", "blow memory");
out.memory = await timed(() => host.dispatch("main", "add"));
out.memory.main = host.slots.get("main").hash === v2 ? "v2" : "hang";
out.screen = JSON.stringify(last).includes("C layer");
out.logs = logs.filter((l) => /rollback|reject|error/.test(l));
window.__done = out;
</script>`;
const server = createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/t.html" || u.pathname === "/strict.html") { res.setHeader("content-type", "text/html"); return res.end(page(u.pathname === "/strict.html")); }
  try { const b = readFileSync(root + u.pathname.slice(1)); res.setHeader("content-type", types[u.pathname.split(".").pop()] ?? "application/octet-stream"); res.end(b); }
  catch { res.statusCode = 404; res.end(); }
}).listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
const results = [];
const check = (name, cond, detail = "") => { results.push(!!cond); console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };

const browser = await chromium.launch();
try {
  const p = await browser.newPage();
  for (const pg of [p]) { pg.on("console", (m) => process.env.DEBUG && console.log("[page]", m.text())); pg.on("pageerror", (e) => console.log("[page error]", e.message)); if (process.env.DEBUG) { pg.on("response", (r) => console.log("[resp]", r.status(), r.url())); pg.on("requestfailed", (r) => console.log("[fail]", r.url())); } }
  await p.goto(base + "/t.html");
  const o = await p.waitForFunction(() => window.__done, null, { timeout: 30000 }).then((h) => h.jsonValue());
  const workers = p.workers().length;
  check("B1 layers run in Web Workers", workers >= 2, `${workers} workers on the page`);
  check("B2 infinite loop in view at swap time: killed, swap refused, page not frozen", !o.applyHang.r.ok && /time limit/.test(o.applyHang.r.reason) && o.applyHang.stall < 50, `${o.applyHang.ms} ms, longest stall ${o.applyHang.stall} ms`);
  check("B3 infinite loop in event: killed, state discarded, reverted, page not frozen", o.eventHang.n === 0 && o.eventHang.main === "v2" && o.eventHang.stall < 50, `${o.eventHang.ms} ms, longest stall ${o.eventHang.stall} ms`);
  check("B4 memory blowup: capped, reverted", o.memory.main === "v2" && o.logs.some((l) => /memory at \d+ of 32 MB/.test(l)), o.logs.find((l) => /memory at/.test(l)));
  check("B5 other layer kept rendering", o.screen);

  const s = await browser.newPage();
  await s.goto(base + "/strict.html");
  const so = await s.waitForFunction(() => window.__done, null, { timeout: 30000 }).then((h) => h.jsonValue());
  check("B6 page that forbids workers falls back to its own thread and says so", s.workers().length === 0 && so.first > 0 && so.logs.some((l) => /blocks workers/.test(l)), so.logs.find((l) => /blocks workers/.test(l)));

  const d = await browser.newPage();
  await d.goto(base + "/web/index.html");
  await d.waitForFunction(() => document.getElementById("screen")?.textContent.includes("Tasks"), null, { timeout: 30000 });
  await d.click('[data-push="v2"]');
  await d.waitForFunction(() => document.getElementById("screen").textContent.includes("Tasks v2"), null, { timeout: 10000 });
  check("B7 demo page boots and swaps to v2 with layers in workers", d.workers().length >= 2, `${d.workers().length} workers`);

  // A release lands while the person is mid-word in a bound input: no keystroke may be lost.
  const typed = [];
  for (let i = 0; i < 5; i++) {
    const t = await browser.newPage();
    await t.goto(base + "/web/index.html");
    await t.waitForFunction(() => document.getElementById("screen")?.textContent.includes("Tasks"), null, { timeout: 30000 });
    const input = '#screen input[data-bind="draft"]';
    await t.click(input); await t.type(input, "Buy mi");
    const push = t.evaluate(() => document.querySelector('[data-push="v2"]').click());
    await t.type(input, "lk", { delay: 15 });
    await push;
    await t.waitForFunction(() => document.getElementById("screen").textContent.includes("Tasks v2"), null, { timeout: 10000 });
    await t.type(input, " today", { delay: 5 });
    typed.push(await t.inputValue(input));
    await t.close();
  }
  check("B9 text typed while a swap is in flight is kept (5 runs)", typed.every((v) => v === "Buy milk today"), [...new Set(typed)].join(" / "));

  // SEC-05: a release from a key this device doesn't trust is never trusted automatically, not even
  // the first one; the page asks, and shows a fingerprint to compare with the other device's screen.
  const w = await browser.newPage();
  await w.addInitScript(() => {
    const doc = (path) => ({
      onSnapshot: (cb) => { if (path === "llp/manifest") setTimeout(async () => {
        const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
        const pub = await crypto.subtle.exportKey("jwk", kp.publicKey);
        cb({ exists: true, data: () => ({ manifest: { app: "demo", version: Date.now() + 1000, layers: {}, order: [] }, sig: "AAAA", pub, from: "other" }) });
      }, 300); },
      get: async () => ({ exists: false }), set: async () => {},
    });
    window.claude = { use: async (n) => (n === "db" ? { doc } : null) };
  });
  await w.goto(base + "/web/index.html");
  await w.waitForFunction(() => document.getElementById("screen")?.textContent.includes("Tasks"), null, { timeout: 30000 });
  const prompt = await w.waitForFunction(() => document.querySelector("#trust-box .fp")?.textContent, null, { timeout: 10000 }).then((h) => h.jsonValue()).catch(() => null);
  const pinned = await w.evaluate(() => localStorage.getItem("llp.trusted"));
  check("B8 the web demo never trusts a new key by itself: it asks, and shows a fingerprint to compare", /^Key fingerprint: (\w{4} ){4}\w{4}$/.test(prompt ?? "") && !(pinned && JSON.parse(pinned).length), prompt ?? "no prompt");
} finally { await browser.close(); server.close(); }
const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
