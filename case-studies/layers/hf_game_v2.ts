// The one-line hotfix.
import { view, play } from "./hf_common";
export function llp_view(): void { view(); }
export function llp_event(): void { play((p: f64): f64 => p); }
