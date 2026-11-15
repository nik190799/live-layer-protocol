// The 2019-07-02 change added an XSS rule whose costly part was ".*(?:.*=.*)", written here as "**=*".
// On a request with no "=", a backtracking engine tries about n^3/6 ways before giving up.
import { view, handle } from "./cf_common";
export function llp_view(): void { view(); }
export function llp_event(): void { handle(["<script", "javascript:", "**=*"]); }
