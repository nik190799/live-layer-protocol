// Template instances before Channel File 291: they read the 20 fields the sensor supplies.
import { view, scan } from "./cs_common";
export function llp_view(): void { view(); }
export function llp_event(): void { scan(20); }
