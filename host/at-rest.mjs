// Encryption at rest (red-team PR-03). Node only.
//
// A data key is 32 random bytes (AES-256-GCM). Every sealed record is
//   "LLPE1." + base64url( iv[12] | ciphertext | tag[16] )
// and is bound to where it belongs with associated data (for example "llp/server/<app>/log"), so a
// record copied into another file or another tenant fails to open instead of being read as that one.
// GCM also makes tampering visible: a changed byte is an error, not different data.
//
// Where the key comes from is the operator's choice; it must not sit next to the data it protects:
//   dataKeyFrom({ key })            32 raw bytes or base64 (tests, or a key the embedder fetched itself)
//   dataKeyFrom({ env: "NAME" })    base64 in an environment variable
//   dataKeyFrom({ file: path })     base64 in a file only this user can read (0600 is checked on POSIX)
//   dataKeyFrom({ command: "..." }) a command that prints the base64 key, which is how an OS keystore is
//                                   reached: `secret-tool lookup service llp` (Linux),
//                                   `security find-generic-password -s llp -w` (macOS), or a PowerShell
//                                   DPAPI one-liner (Windows).
// `generateDataKey()` prints a fresh key to store in one of those places.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFileSync, statSync, writeFileSync as _w, renameSync as _r, existsSync as _e, mkdirSync as _m } from "node:fs";
import { join as _j, dirname as _d } from "node:path";
import { execSync } from "node:child_process";

export const SEALED_PREFIX = "LLPE1.";

export function generateDataKey() { return randomBytes(32).toString("base64"); }

function toKey(v, where) {
  const buf = Buffer.isBuffer(v) || v instanceof Uint8Array ? Buffer.from(v) : Buffer.from(String(v).trim(), "base64");
  if (buf.length !== 32) throw new Error(`${where}: a data key is 32 bytes (base64 of 32 random bytes); got ${buf.length} bytes`);
  return buf;
}

export function dataKeyFrom(src) {
  if (!src) return null;
  if (Buffer.isBuffer(src) || src instanceof Uint8Array || typeof src === "string") return toKey(src, "data key");
  if (src.key !== undefined) return toKey(src.key, "data key");
  if (src.env) {
    const v = process.env[src.env];
    if (!v) throw new Error(`data key: environment variable ${src.env} is not set`);
    return toKey(v, `$${src.env}`);
  }
  if (src.file) {
    if (process.platform !== "win32") {
      const mode = statSync(src.file).mode & 0o077;
      if (mode) throw new Error(`data key: ${src.file} can be read by other users (mode ${(statSync(src.file).mode & 0o777).toString(8)}); chmod 600 it`);
    }
    return toKey(readFileSync(src.file, "utf8"), src.file);
  }
  if (src.command) {
    let out;
    try { out = execSync(src.command, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15000 }); }
    catch (e) { throw new Error(`data key: "${src.command}" failed (${(e.stderr || e.message).toString().trim().slice(0, 200)})`); }
    return toKey(out, `output of "${src.command}"`);
  }
  throw new Error("data key: give one of key, env, file or command");
}

export const isSealed = (text) => typeof text === "string" && text.startsWith(SEALED_PREFIX);

// key: a 32-byte Buffer. aad: a string naming the record's place.
export function seal(key, aad, plaintext) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(aad));
  const body = Buffer.concat([c.update(Buffer.from(plaintext)), c.final()]);
  return SEALED_PREFIX + Buffer.concat([iv, body, c.getAuthTag()]).toString("base64url");
}

export class SealError extends Error {}
export function open(key, aad, sealed) {
  if (!isSealed(sealed)) throw new SealError("not an encrypted record");
  const raw = Buffer.from(sealed.slice(SEALED_PREFIX.length), "base64url");
  if (raw.length < 28) throw new SealError("encrypted record is truncated");
  const d = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(raw.subarray(raw.length - 16));
  try { return Buffer.concat([d.update(raw.subarray(12, raw.length - 16)), d.final()]); }
  catch { throw new SealError("can't decrypt: wrong data key, or the record was changed or moved"); }
}

// A codec for one file kind: plaintext when key is null (as before), sealed otherwise. Reading a
// plaintext record with a key works (so existing data can be migrated), unless strict is set.
export function codec(key, { previous = [] } = {}) {
  const keys = key ? [key, ...previous] : [];
  return {
    encrypted: !!key,
    encode(aad, text) { return key ? seal(key, aad, text) : text; },
    // -> { text, sealed, stale } (stale: opened with a previous key, so it should be rewritten)
    decode(aad, data) {
      const s = typeof data === "string" ? data : data.toString("utf8");
      if (!isSealed(s)) return { text: s, sealed: false, stale: !!key };
      if (!keys.length) throw new SealError("this data is encrypted; start with the data key (see SPEC section 14)");
      let last;
      for (let i = 0; i < keys.length; i++) {
        try { return { text: open(keys[i], aad, s).toString("utf8"), sealed: true, stale: i > 0 }; } catch (e) { last = e; }
      }
      throw last;
    },
  };
}

// The data key from the environment, for the command-line hosts (llpd, llp, fleet-host):
// LLP_DATA_KEY (base64), LLP_DATA_KEY_FILE (path), or LLP_DATA_KEY_CMD (a keystore command). null if none is set.
export function dataKeyFromEnv(env = process.env) {
  if (env.LLP_DATA_KEY) return dataKeyFrom({ env: "LLP_DATA_KEY" });
  if (env.LLP_DATA_KEY_FILE) return dataKeyFrom({ file: env.LLP_DATA_KEY_FILE });
  if (env.LLP_DATA_KEY_CMD) return dataKeyFrom({ command: env.LLP_DATA_KEY_CMD });
  return null;
}

// Small sealed files under one directory (llpd's app state, a fleet host's device key and keyring).
// Each file is sealed with its path relative to `root` as associated data, under `scope`. A
// "keycheck" file in root tells a wrong key apart from damage. Plaintext files left from before a key
// was set are still read, and are sealed the next time they are written (call reseal() to do it now).
export function fileVault(root, key, scope) {
  const aad = (rel) => `llp/${scope}/${rel.split("\\").join("/")}`;
  const c = codec(key);
  const check = _j(root, "keycheck");
  if (key) {
    if (_e(check)) { try { open(key, aad("keycheck"), readFileSync(check, "utf8")); } catch { throw new Error(`${root}: the data key doesn't match (this data was encrypted with another key)`); } }
    else { _m(root, { recursive: true }); _w(check, seal(key, aad("keycheck"), "llp-data-key-ok"), { mode: 0o600 }); }
  } else if (_e(check)) throw new Error(`${root} is encrypted at rest; set LLP_DATA_KEY, LLP_DATA_KEY_FILE or LLP_DATA_KEY_CMD`);
  const vault = {
    encrypted: !!key,
    // -> string, or `def` when the file doesn't exist
    read(rel, def = null) { const f = _j(root, rel); if (!_e(f)) return def; return c.decode(aad(rel), readFileSync(f, "utf8")).text; },
    write(rel, text, mode = 0o600) { const f = _j(root, rel); _m(_d(f), { recursive: true }); _w(f + ".tmp", c.encode(aad(rel), text), { mode }); _r(f + ".tmp", f); },
    isPlain(rel) { const f = _j(root, rel); return _e(f) && !isSealed(readFileSync(f, "utf8")); },
    reseal(rel) { if (key && vault.isPlain(rel)) vault.write(rel, vault.read(rel)); },
  };
  return vault;
}
