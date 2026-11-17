// Renders tools/demo-gif/architecture.html to docs/llp-architecture.png (1080x1350, 4:5 for feeds).
// Usage: node tools/demo-gif/render-architecture.mjs [out.png]. Needs Playwright with Chromium.
import { createRequire } from "node:module";
import { resolve } from "node:path";
const { chromium } = createRequire(import.meta.url)("playwright");

const root = new URL("../..", import.meta.url).pathname;
const out = resolve(root, process.argv[2] ?? "docs/llp-architecture.png");
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 720, height: 900 }, deviceScaleFactor: 1.5 });
await page.goto("file://" + new URL("architecture.html", import.meta.url).pathname);
await page.evaluate(() => document.fonts.ready);
// Fail rather than ship a clipped image: nothing may overflow the 720x900 layout.
const over = await page.evaluate(() => [...document.querySelectorAll("body *")].filter((e) => { const r = e.getBoundingClientRect(); return r.width && (r.right > 721 || r.bottom > 901); }).map((e) => e.className || e.tagName));
if (over.length) { console.error("overflows the frame:", over); process.exit(1); }
// The comparison row must not overlap the steps above it.
const gap = await page.evaluate(() => document.querySelector(".vs").getBoundingClientRect().top - Math.max(document.querySelector(".steps").getBoundingClientRect().bottom, document.querySelector(".device").getBoundingClientRect().bottom));
if (gap < 8) { console.error(`the comparison row overlaps the diagram (gap ${gap}px)`); process.exit(1); }
await page.screenshot({ path: out });
await browser.close();
console.log("wrote", out);
