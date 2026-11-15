// The "today" app's test suite: what a team would typically have for the features that exist.
// API tests, plus end-to-end tests in headless Chromium. Run by ci.mjs with `node --test`.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
const { chromium } = createRequire(import.meta.url)("playwright");

const port = 8100 + Math.floor(Math.random() * 800);
const data = join(mkdtempSync(join(tmpdir(), "today-test-")), "tasks.json");
const base = `http://127.0.0.1:${port}`;
let server, browser;
before(async () => {
  writeFileSync(data, JSON.stringify([{ text: "Buy milk", done: false }]));
  server = spawn(process.execPath, [new URL("../server.mjs", import.meta.url).pathname, String(port), data, "test"]);
  await new Promise((r) => server.stdout.once("data", r));
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); server?.kill(); });

test("API returns the saved tasks", async () => {
  assert.deepEqual(await (await fetch(base + "/api/tasks")).json(), [{ text: "Buy milk", done: false }]);
});
test("API saves tasks", async () => {
  await fetch(base + "/api/tasks", { method: "PUT", body: JSON.stringify([{ text: "A", done: true }]) });
  assert.deepEqual(await (await fetch(base + "/api/tasks")).json(), [{ text: "A", done: true }]);
});
test("e2e: add a task", async () => {
  const p = await browser.newPage(); await p.goto(base);
  await p.fill("#draft", "Walk the dog"); await p.click("#add");
  await p.waitForSelector("text=Walk the dog");
  await p.reload(); await p.waitForSelector("text=Walk the dog");
});
test("e2e: tick a task", async () => {
  const p = await browser.newPage(); await p.goto(base);
  const was = await p.getAttribute('.u-toggle[data-i="0"]', "aria-pressed");
  await p.click('.u-toggle[data-i="0"]');
  await p.waitForSelector(`.u-toggle[data-i="0"][aria-pressed="${was === "true" ? "false" : "true"}"]`);
  assert.equal(await p.isVisible("#crash"), false);
});
