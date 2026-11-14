// Connects a client Live Host to a server host (SPEC section 10.2):
// - receives the signed manifest stream through the server (verified here, as always),
// - keeps the shared/ read cache filled from the server,
// - implements the standard "remote" capability: cap("remote", "<slot>:<op> <args>") calls a server
//   slot and the reply arrives as event cap:remote,
// - queues calls while offline and resends them on reconnect with the same call id, so the server
//   runs each one exactly once.
// watch: shared/ prefixes to mirror (default all of shared/).
// Works with the browser WebSocket and Node's global WebSocket.
import { b64 } from "./llp-core.js";

export function connectServer(host, url, { app, token, watch, retryMs = 250, queueMs = 5 * 60_000, upgradeWaitMs = 5000, WebSocketImpl = globalThis.WebSocket } = {}) {
  const outbox = new Map();          // id -> { msg, resolve, reject, retried, timer }
  const blobs = new Map();
  const link = { online: false, outbox, received: [], sent: [], close, drop, waitOnline };
  let ws, closed = false, onlineWaiters = [];
  const send = (m) => { if (ws?.readyState === 1) { const s = JSON.stringify(m); link.sent.push(s); ws.send(s); return true; } return false; };
  const versionWaiters = new Set();

  function open() {
    ws = new WebSocketImpl(url);
    ws.onopen = () => {
      send({ t: "hello", app, version: host.version, have: [...host.blobs.keys()], token, watch });
      link.online = true;
      for (const e of outbox.values()) send(e.msg);   // resend anything queued or unanswered
      onlineWaiters.splice(0).forEach((f) => f());
    };
    ws.onmessage = async (ev) => {
      const raw = typeof ev.data === "string" ? ev.data : String(ev.data);
      link.received.push(raw);
      const m = JSON.parse(raw);
      if (m.t === "blob") blobs.get(m.hash)?.(b64.dec(m.data));
      else if (m.t === "shared") await host.applyShared(m);
      else if (m.t === "manifest") {
        const r = await host.apply(m.manifest, m.sig, (h) => new Promise((res) => { blobs.set(h, res); send({ t: "want", hashes: [h] }); }));
        send(r.ok ? { t: "ack", version: r.version, ms: r.ms } : { t: "nack", version: r.version, reason: r.reason });
        for (const f of versionWaiters) f();
      } else if (m.t === "reply") onReply(m);
      else if (m.t === "error") host.log("error", `server: ${m.code}: ${m.message}`);
    };
    ws.onclose = () => { link.online = false; if (!closed) setTimeout(open, retryMs); };
    ws.onerror = () => {};
  }

  async function onReply(m) {
    const e = outbox.get(m.id);
    if (!e) return;
    if (m.ok) { finish(m.id); return e.resolve(m.value); }
    // The server no longer serves our version: get the latest manifest, swap, retry once.
    if (m.error.code === "version_mismatch" && !e.retried) {
      e.retried = true;
      const before = host.version;
      await waitVersion(before);
      if (host.version > before) { e.msg = { ...e.msg, version: host.version }; send(e.msg); return; }
      finish(m.id);
      return e.reject(new Error(`version_mismatch: this client can't run v${m.error.serverVersion ?? "?"} and the server no longer serves v${before}`));
    }
    finish(m.id);
    e.reject(new Error(`${m.error.code}: ${m.error.message}`));
  }
  function waitVersion(before) {
    if (host.version > before) return Promise.resolve();
    return new Promise((res) => {
      const done = () => { versionWaiters.delete(done); clearTimeout(t); res(); }; // after the next manifest, swapped or refused
      const t = setTimeout(() => { versionWaiters.delete(done); res(); }, upgradeWaitMs);
      versionWaiters.add(done);
      send({ t: "hello", app, version: host.version, have: [...host.blobs.keys()], token, watch }); // ask for the latest manifest
    });
  }
  function finish(id) { const e = outbox.get(id); if (e) { clearTimeout(e.timer); outbox.delete(id); } }

  // The "remote" capability.
  host.capabilities.remote = (arg) => {
    const sp = arg.indexOf(" ");
    const target = sp < 0 ? arg : arg.slice(0, sp), args = sp < 0 ? "" : arg.slice(sp + 1);
    const colon = target.indexOf(":");
    if (colon < 1) return Promise.reject(new Error('bad_request: remote takes "<slot>:<op> <args>"'));
    const id = crypto.randomUUID();
    const msg = { t: "call", id, idem: id, slot: target.slice(0, colon), op: target.slice(colon + 1), args, version: host.version };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { outbox.delete(id); reject(new Error(`offline: no answer from the server within ${queueMs} ms`)); }, queueMs);
      timer.unref?.();
      outbox.set(id, { msg, resolve, reject, retried: false, timer });
      send(msg); // offline: stays in the outbox and goes out on reconnect
    });
  };

  function close() { closed = true; ws?.close(); for (const id of [...outbox.keys()]) { outbox.get(id).reject(new Error("closed")); finish(id); } }
  function drop() { ws?.close(); }        // simulate losing the network; reconnects after retryMs
  function waitOnline() { return link.online ? Promise.resolve() : new Promise((r) => onlineWaiters.push(r)); }
  open();
  return link;
}
