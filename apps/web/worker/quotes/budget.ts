import { MAX_PROVIDER_ATTEMPTS } from "../earnings/subrequest-budget";
import { WORKERS_FREE_EXTERNAL_SUBREQUEST_LIMIT } from "../earnings/subrequest-budget";

/**
 * Screener quote budget (Screener PR1 + Finnhub 429 hotfix).
 *
 * One dedicated 1-minute cron invocation processes ONE deterministic shard of
 * the Core Universe (5 symbols) during regular/post-close US market hours.
 * 10 shards × 5 symbols covers the 50-symbol universe on a ~10-minute refresh
 * cycle at a steady 5 quote requests/minute — half the previous 10 req/min
 * claim on the shared Finnhub key, chosen because production observed HTTP 429
 * throttling at 10 req/min (see PR1 hotfix).
 *
 * The worst-case external-subrequest cost of one invocation is therefore
 * 5 symbols × MAX_PROVIDER_ATTEMPTS retries = 10, a deliberate margin below
 * the Workers Free 50/invocation cap — the other jobs run on different
 * invocations and are budgeted separately in earnings/subrequest-budget.ts.
 */
export const QUOTES_SHARD_COUNT = 10;
export const QUOTES_SYMBOLS_PER_SHARD = 5;
export const QUOTES_TOTAL_SYMBOLS = QUOTES_SHARD_COUNT * QUOTES_SYMBOLS_PER_SHARD;

/**
 * Bounded outbound concurrency — deliberately 1 (serial). Finnhub physical
 * requests are paced by the shared FinnhubRequestGate (1100 ms); with
 * concurrency > 1 the gate's synchronized wake-up fires requests in batches
 * (5-at-once bursts observed in production), which trips the provider's
 * limiter harder. Serializing lets every request land 1.1 s apart. A 5-symbol
 * shard therefore completes in roughly 6 s, far inside the 60 s tick.
 */
export const QUOTES_BOUNDED_CONCURRENCY = 1;

export const QUOTES_SHARD_WORST_CASE_EXTERNAL_SUBREQUESTS =
  QUOTES_SYMBOLS_PER_SHARD * MAX_PROVIDER_ATTEMPTS;

export const QUOTES_INVOCATION_HEADROOM =
  WORKERS_FREE_EXTERNAL_SUBREQUEST_LIMIT - QUOTES_SHARD_WORST_CASE_EXTERNAL_SUBREQUESTS;
