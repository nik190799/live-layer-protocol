// Server slot "profile": per-person data for the privacy proof (SPEC section 13). Keys under
// shared/users/<user>/ (readable only by that user when the manifest marks the prefix private) and
// server/profiles/<user>/ (never leaves the server) are the person's; the manifest's "personal"
// field says so, which is how the server host finds them to export or erase. "post" also writes the
// author's id into a shared feed, outside any personal prefix: the case export can't see.
import { getNum, setNum, getStr, setStr, eventId } from "../../sdk/assemblyscript/llp";
import { caller, args, reply, fail } from "./common";

export function llp_event(): void {
  const op = eventId(), user = caller(), a = args();
  if (a.length > 200) { fail("at most 200 characters"); return; }
  if (op == "setname") { setStr("shared/users/" + user + "/name", a); reply("ok"); }
  else if (op == "setemail") { setStr("server/profiles/" + user + "/email", a); reply("ok"); }
  else if (op == "post") {
    const n = <i32>getNum("shared/feed.n");
    setStr("shared/feed." + n.toString() + ".text", a); setStr("shared/feed." + n.toString() + ".by", user);
    setNum("shared/feed.n", n + 1); reply(n.toString());
  }
  else if (op == "whoami") { reply(getStr("shared/users/" + user + "/name") + "|" + getStr("server/profiles/" + user + "/email")); }
  else fail("unknown op " + op);
}
