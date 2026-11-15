// The edge code before the May 12 deploy.
import { view, served, eventId } from "./fa_common";
export function llp_view(): void { view(); }
export function llp_event(): void { if (eventId() == "req") served(); }
