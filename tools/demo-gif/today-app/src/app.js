// Tasks app, conventional version: plain JS in the browser, tasks saved on the server.
let tasks = [];
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
async function load() { tasks = await (await fetch("/api/tasks")).json(); render(); }
function save() { return fetch("/api/tasks", { method: "PUT", body: JSON.stringify(tasks) }); }

function render() {
  const draft = document.getElementById("draft")?.value ?? "";
  const done = tasks.filter((t) => t.done).length;
  document.getElementById("app").innerHTML = `
    <h3 class="u-heading">Tasks</h3>
    <div class="u-label">${done} of ${tasks.length} done</div>
    <div class="u-row"><input class="u-input" id="draft" placeholder="Add a task…"><button class="u-button primary" id="add">Add</button></div>
    ${tasks.map((t, i) => `<div class="u-row"><button class="u-toggle" data-i="${i}" aria-pressed="${t.done}"><span class="box"></span><span class="t">${esc(t.text)}</span></button></div>`).join("")}`;
  document.getElementById("draft").value = draft;
  document.getElementById("add").onclick = add;
  document.getElementById("draft").onkeydown = (e) => { if (e.key === "Enter") add(); };
  document.querySelectorAll(".u-toggle").forEach((b) => (b.onclick = () => toggle(+b.dataset.i)));
}
function add() {
  const d = document.getElementById("draft");
  if (!d.value) return;
  tasks.push({ text: d.value, done: false }); d.value = "";
  save(); render();
}
function toggle(i) { tasks[i].done = !tasks[i].done; save(); render(); }
load();
