// Baseline "traditional" app: the same tiny tasks app as the LLP demo, as a plain Node HTTP server.
// State lives in process memory, as it does in most app servers without an external store.
const TITLE = "Tasks v0"; // the benchmark rewrites this line to simulate a code change
const tasks = [];
require("http").createServer((req, res) => {
  if (req.url === "/health") return res.end("ok");
  if (req.method === "POST" && req.url.startsWith("/tasks?text=")) { tasks.push(decodeURIComponent(req.url.slice(12))); return res.end("added"); }
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ title: TITLE, tasks }));
}).listen(3000);
