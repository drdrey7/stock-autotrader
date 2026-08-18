import { MAX_PROVIDER_ATTEMPTS } from "../earnings/subrequest-budget";
import { WORKERS_FREE_EXTERNAL_SUBREQUEST_LIMIT } from "../earnings/subrequest-budget";

/**
 * Screener quote budget (Screener PR1).
 *
 * One dedicated 1-minute cron invocation processes ONE deterministic shard of
 * the Core Universe (10 symbols) during regular/post-close US market hours.
 * The worst-case external-subrequest cost of that invocation is therefore
 * 10 symbols × MAX_PROVIDER_ATTEMPTS retries = 20, a deliberate margin below
 * the Workers Free 50/invocation cap — the other jobs run on different
 * invocations and are budgeted separately in earnings/subrequest-budget.ts.
 */
export const QUOTES_SHARD_COUNT = 5;
export const QUOTES_SYMBOLS_PER_SHARD = 10;
export const QUOTES_TOTAL_SYMBOLS = QUOTES_SHARD_COUNT * QUOTES_SYMBOLS_PER_SHARD;

/** Bounded outbound concurrency — Cloudflare Free allows 6 simultaneous
 * outgoing connections per invocation; keep a deliberate margin at 5. */
export const QUOTES_BOUNDED_CONCURRENCY = 5;

export const QUOTES_SHARD_WORST_CASE_EXTERNAL_SUBREQUESTS =
  QUOTES_SYMBOLS_PER_SHARD * MAX_PROVIDER_ATTEMPTS;

export const QUOTES_INVOCATION_HEADROOM =
  WORKERS_FREE_EXTERNAL_SUBREQUEST_LIMIT - QUOTES_SHARD_WORST_CASE_EXTERNAL_SUBREQUESTS;
