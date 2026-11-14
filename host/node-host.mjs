// Headless Live Host: the same host core as the browser, rendering to a terminal.
// Usage: node host/node-host.mjs ws://localhost:7700 keys/publisher.pub.json
// Commands on stdin:  click <slot> <id>   |   set <key> <text>   |   state
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { LiveHost, b64 } from "./llp-core.js";

const [url = "ws://localhost:7700", keyFile = "keys/publisher.pub.json"] = process.argv.slice(2);
const trusted = JSON.parse(readFileSync(keyFile, "utf8"));

function draw(node, depth = 0) {
  const pad = "  ".repeat(depth);
  if (node.k === "text") return [pad + node.t];
  const a = node.a || {};
  const label = (node.c || []).filter((c) => c.k === "text").map((c) => c.t).join(" ");
  switch (node.k) {
    case "button": return [`${pad}[ ${label} ]  (#${a.id})`];
    case "toggle": return [`${pad}${a.on === "1" ? "[x]" : "[ ]"} ${label}  (#${a.id})`];
    case "input": return [`${pad}<${a.placeholder}>  (bind ${a.bind})`];
    case "progress": return [`${pad}${"█".repeat(Math.round(+a.value / 10)).padEnd(10, "░")} ${a.value}%`];
    case "heading": return [`${pad}== ${label} ==`];
    default: return (node.c || []).flatMap((c) => draw(c, node.k === "root" ? depth : depth + (["col", "card"].includes(node.k) ? 0 : 1)));
  }
}

const host = new LiveHost({
  trustedKeys: [trusted],
  capabilities: {
    haptic: async (ms) => { process.stdout.write("\x07"); }, // terminal bell
    geo: async () => "location unavailable on this host (headless)",
  },
  onRender: (slots) => {
    console.log("\n" + "─".repeat(48));
    for (const s of slots) console.log((s.error ? [`!! ${s.slot}: ${s.error}`] : draw(s.tree)).join("\n"));
    console.log("─".repeat(48));
  },
  onLog: (e) => console.log(`· ${e.kind}: ${e.msg}`),
});

const ws = new WebSocket(url);
const pending = new Map();
const send = (m) => ws.send(JSON.stringify(m));
ws.onopen = () => send({ t: "hello", app: "demo.tasks", version: host.version, have: [...host.blobs.keys()] });
ws.onmessage = async (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.t === "blob") pending.get(msg.hash)?.(b64.dec(msg.data));
  if (msg.t === "manifest") {
    const r = await host.apply(msg.manifest, msg.sig, (h) => new Promise((res) => { pending.set(h, res); send({ t: "want", hashes: [h] }); }));
    send(r.ok ? { t: "ack", version: r.version, ms: r.ms } : { t: "nack", version: r.version, reason: r.reason });
  }
};
ws.onclose = () => console.log("· stream closed");

createInterface({ input: process.stdin }).on("line", async (line) => {
  const [cmd, a, ...rest] = line.trim().split(" ");
  if (cmd === "click") await host.dispatch(a, rest[0]);
  else if (cmd === "set") { host.setBound(a, rest.join(" ")); host.render(); }
  else if (cmd === "state") console.log(Object.fromEntries(host.kv));
});
