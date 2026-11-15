// The "today" tasks app: a plain Node server. Tasks are saved to a JSON file, so they survive a
// restart, like a real app with a database. Usage: node server.mjs <port> <data.json> <release-id>
import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
const [port, dataFile, release] = process.argv.slice(2);
const here = new URL(".", import.meta.url).pathname;
const files = { "/": ["index.html", "text/html"], "/app.js": ["app.js", "text/javascript"], "/app.css": ["app.css", "text/css"] };
const server = createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  res.setHeader("cache-control", "no-store");
  if (u.pathname === "/version") return res.end(release);
  if (u.pathname === "/api/tasks" && req.method === "GET") return res.end(existsSync(dataFile) ? readFileSync(dataFile) : "[]");
  if (u.pathname === "/api/tasks" && req.method === "PUT") {
    let body = ""; req.on("data", (c) => (body += c));
    return req.on("end", () => { writeFileSync(dataFile, JSON.stringify(JSON.parse(body))); res.end("ok"); });
  }
  const f = files[u.pathname];
  if (!f) { res.statusCode = 404; return res.end(); }
  res.setHeader("content-type", f[1]); res.end(readFileSync(here + f[0]));
});
server.listen(+port, "127.0.0.1", () => console.log("listening", port, release));
process.on("SIGTERM", () => server.close(() => process.exit(0)) || setTimeout(() => process.exit(0), 50));
