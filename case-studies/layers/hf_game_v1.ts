// The shipped bug: a sale multiplier was applied the wrong way round, so items cost 10x.
import { view, play } from "./hf_common";
export function llp_view(): void { view(); }
export function llp_event(): void { play((p: f64): f64 => p * 10); }
