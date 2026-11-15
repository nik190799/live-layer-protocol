// Channel File 291's new template instances: they read 21 fields; the sensor still supplies 20.
import { view, scan } from "./cs_common";
export function llp_view(): void { view(); }
export function llp_event(): void { scan(21); }
