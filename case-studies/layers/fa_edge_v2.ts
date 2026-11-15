// The May 12 deploy: a new feature spreads a customer's cache objects over cfg.<c>.shards shards
// (default 4). It works for every config that exists on deploy day. A shards value of 0 is a valid
// setting ("don't shard"), but the new code divides by it, which traps. Nobody has that setting yet.
import { view, served, customer, hash, getNum, eventId } from "./fa_common";
import { eventValue } from "../../sdk/assemblyscript/llp";
export function llp_view(): void { view(); }
export function llp_event(): void {
  if (eventId() != "req") return;
  const c = customer();
  const shards = <i32>getNum("cfg." + c + ".shards", 4);
  const shard = hash(eventValue()) % shards; // traps when shards == 0
  if (shard >= 0) served();
}
