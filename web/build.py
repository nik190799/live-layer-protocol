import json, base64, re, pathlib
root = pathlib.Path(__file__).resolve().parent.parent
core = (root/"host/llp-core.js").read_text()
core = re.sub(r"^export ", "", core, flags=re.M)
wasm = {k: base64.b64encode((root/f"build/{f}").read_bytes()).decode() for k, f in
        {"tasks":"tasks.wasm","v2":"tasks_v2.wasm","broken":"tasks_broken.wasm","trap":"tasks_trap.wasm","stats":"stats.wasm"}.items()}
src = {"app": (root/"layers/tasks-as/app.ts").read_text().replace("../../sdk/assemblyscript/llp", "./sdk"),
       "sdk": (root/"sdk/assemblyscript/llp.ts").read_text(),
       "c": (root/"layers/stats-c/stats.c").read_text()}
t = (root/"web/template.html").read_text()
t = t.replace("/*__CORE__*/", core).replace("/*__WASM_JSON__*/null", json.dumps(wasm)).replace("/*__SRC_JSON__*/null", json.dumps(src).replace("</", "<\\/"))
(root/"web/index.html").write_text(t)
print("index.html", len(t)//1024, "KB")
