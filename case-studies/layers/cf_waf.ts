// WAF rules before the change: simple literal checks.
import { view, handle } from "./cf_common";
export function llp_view(): void { view(); }
export function llp_event(): void { handle(["<script", "javascript:"]); }
