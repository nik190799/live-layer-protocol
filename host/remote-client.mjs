// Connects a client Live Host to a server host (SPEC section 10.2):
// - receives the signed manifest stream through the server (verified here, as always),
// - keeps the shared/ read cache filled from the server,
// - implements the standard "remote" capability: cap("remote", "<slot>:<op> <args>") calls a server
//   slot and the reply arrives as event cap:remote,
// - queues calls while offline and resends them on reconnect with the same call id, so the server
//   runs each one exactly once.
// watch: shared/ prefixes to mirror (default all of shared/).
// channel (SPEC 10.5): the release channel this client is on; the server relays only that channel's
//   releases, and a manifest for any other channel is refused here too.
// id: a stable id for this device, used for percentage rollouts (12.2): a release with a share below
//   100% is applied only when bucket(seed, id) is inside it. A client without an id stays out of
//   partial shares and gets each release when it reaches 100%.
// trust: a TrustStore (host/fleet.js) when the app's releases come from a fleet controller. Keyrings
//   the server relays are checked against it, so a key rotation reaches clients behind the server.
// onErased(): called when the server erased this user's data (section 13). The default clears this
//   device's local copy of the app's state (everything except the shared/ mirror).
// Works with the browser WebSocket and Node's global WebSocket.
import { b64 } from "./llp-core.js";
import { inRollout } from "./fleet.js";

export function connectServer(host, url, { app, token, watch, channel, id, trust, onErased, retryMs = 250, queueMs = 5 * 60_000, upgradeWaitMs = 5000, WebSocketImpl = globalThis.WebSocket } = {}) {
  const outbox = new Map();          // id -> { msg, resolve, reject, retried, timer }
  const blobs = new Map();
  const privacy = new Map();         // request id -> { resolve, reject }
  const link = { online: false, outbox, received: [], sent: [], close, drop, waitOnline, exportMine, eraseMine };
  if (trust) { host.trustedKeys = trust.releaseKeys(); host.maxEpoch = trust.version; host.app ??= trust.app; }
  const hello = () => ({ t: "hello", llp: 1, app, version: host.version, epoch: host.epoch, have: [...host.blobs.keys()], token, watch, ...(channel ? { channel } : {}), ...(trust ? { keyring: trust.version } : {}) });
  let ws, closed = false, onlineWaiters = [];
  const send = (m) => { if (ws?.readyState === 1) { const s = JSON.stringify(m); link.sent.push(s); ws.send(s); return true; } return false; };
  const versionWaiters = new Set();
  if (app && !host.app) host.app = app; // the client is for this app only (it refuses manifests for others)

  function open() {
    ws = new WebSocketImpl(url);
    ws.onopen = () => {
      send(hello());
      link.online = true;
      for (const e of outbox.values()) send(e.msg);   // resend anything queued or unanswered
      onlineWaiters.splice(0).forEach((f) => f());
    };
    ws.onmessage = (ev) => {
      const raw = typeof ev.data === "string" ? ev.data : String(ev.data);
      link.received.push(raw);
      const m = JSON.parse(raw);
      // Keyrings and releases are handled one at a time, in arrival order, so a release signed by a
      // new key never races the keyring that introduces it. Replies don't wait (one may wait for a release).
      if (m.t === "keyring" || m.t === "manifest" || m.t === "shared" || m.t === "erased") { const r = ordered.then(() => handle(m)); ordered = r.catch(() => {}); return r; }
      return handle(m);
    };
    ws.onclose = () => { link.online = false; if (!closed) setTimeout(open, retryMs); };
    ws.onerror = () => {};
  }
  let ordered = Promise.resolve();
  async function handle(m) {
    {
      if (m.t === "blob") blobs.get(m.hash)?.(b64.dec(m.data));
      else if (m.t === "shared") await host.applyShared(m);
      else if (m.t === "manifest") {
        const mf = m.manifest ?? {};
        let r;
        if ((mf.channel ?? null) !== (channel ?? null)) r = { ok: false, version: mf.version, reason: `manifest is for channel ${mf.channel ?? "(none)"}, this client is on ${channel ?? "(none)"}` };
        else if (host.compareVersion(mf) > 0 && (mf.rollout?.percent ?? 100) < 100 && !(id && (await inRollout(mf, id)))) {
          send({ t: "skip", version: mf.version, reason: id ? `not in the ${mf.rollout.percent}% share` : "no device id, so not in partial shares" });
          for (const f of versionWaiters) f();
          return;
        } else r = await host.apply(m.manifest, m.sig, (h) => new Promise((res) => { blobs.set(h, res); send({ t: "want", hashes: [h] }); }));
        send(r.ok ? { t: "ack", version: r.version, ms: r.ms, running: host.running() } : { t: "nack", version: r.version, reason: r.reason, running: host.running() });
        for (const f of versionWaiters) f();
      } else if (m.t === "keyring" && trust) {
        const r = await trust.update(m.doc, m.sigs);
        if (r.ok) { host.trustedKeys = trust.releaseKeys(); host.maxEpoch = trust.version; link.keyring?.(trust.doc); }
        else host.log("error", `keyring from the server refused: ${r.reason}`);
      } else if (m.t === "privacy") { const p = privacy.get(m.id); if (p) { privacy.delete(m.id); m.ok ? p.resolve(m.value) : p.reject(new Error(`${m.error.code}: ${m.error.message}`)); } }
      else if (m.t === "erased") { await (onErased ?? eraseLocal)(); host.log("privacy", "the server erased this user's data; local copy cleared"); }
      else if (m.t === "reply") onReply(m);
      else if (m.t === "error") host.log("error", `server: ${m.code}: ${m.message}`);
    }
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
      send(hello()); // ask for the latest manifest
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

  // ---------- privacy (section 13) ----------
  function ask(op) {
    const rid = crypto.randomUUID();
    return new Promise((resolve, reject) => { privacy.set(rid, { resolve, reject }); if (!send({ t: "privacy", id: rid, op })) { privacy.delete(rid); reject(new Error("offline")); } });
  }
  // This device's own copy of the app's state: every key except the shared/ mirror (which is the server's).
  const localKeys = () => [...host.kv.keys()].filter((k) => !k.startsWith("shared/") && !k.startsWith("__schema."));
  function eraseLocal() { return host.exclusive(async () => { for (const k of localKeys()) host.kv.delete(k); await host.renderNow(); }); }
  // What the server and this device hold about the signed-in user.
  async function exportMine() {
    const server = await ask("export");
    return { server, device: { app, keys: Object.fromEntries(localKeys().map((k) => [k, host.kv.get(k)])) } };
  }
  // Erase it on the server, then on this device. Saving the cleared state is the embedder's job, as for any change.
  async function eraseMine() { const server = await ask("erase"); await eraseLocal(); return { server, device: { cleared: true } }; }

  function close() { closed = true; ws?.close(); for (const id of [...outbox.keys()]) { outbox.get(id).reject(new Error("closed")); finish(id); } }
  function drop() { ws?.close(); }        // simulate losing the network; reconnects after retryMs
  function waitOnline() { return link.online ? Promise.resolve() : new Promise((r) => onlineWaiters.push(r)); }
  open();
  return link;
}
