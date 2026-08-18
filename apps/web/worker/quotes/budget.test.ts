import { describe, expect, it } from "vitest";
import {
  QUOTES_BOUNDED_CONCURRENCY,
  QUOTES_INVOCATION_HEADROOM,
  QUOTES_SHARD_COUNT,
  QUOTES_SHARD_WORST_CASE_EXTERNAL_SUBREQUESTS,
  QUOTES_SYMBOLS_PER_SHARD,
  QUOTES_TOTAL_SYMBOLS,
} from "./budget";
import { WORKERS_FREE_EXTERNAL_SUBREQUEST_LIMIT } from "../earnings/subrequest-budget";

describe("Screener quote invocation budget (Workers Free)", () => {
  it("budgets 10 shards × 5 symbols = 50 Core symbols", () => {
    expect(QUOTES_SHARD_COUNT).toBe(10);
    expect(QUOTES_SYMBOLS_PER_SHARD).toBe(5);
    expect(QUOTES_TOTAL_SYMBOLS).toBe(50);
  });

  it("keeps the worst-case invocation well below the 50-subrequest cap", () => {
    // 5 symbols × 2 provider attempts (retries) = 10; target ~5 normally.
    // Halving the per-minute claim on the shared Finnhub key is the point of
    // the hotfix (production observed 429 throttling at 5 shards × 10).
    expect(QUOTES_SHARD_WORST_CASE_EXTERNAL_SUBREQUESTS).toBe(10);
    expect(QUOTES_SHARD_WORST_CASE_EXTERNAL_SUBREQUESTS).toBeLessThan(WORKERS_FREE_EXTERNAL_SUBREQUEST_LIMIT);
    // Deliberate margin: never sit near the free-tier ceiling.
    expect(QUOTES_INVOCATION_HEADROOM).toBeGreaterThanOrEqual(25);
  });

  it("collects quotes serially so the shared gate paces every request 1.1 s apart", () => {
    // Concurrency > 1 makes FinnhubRequestGate fire synchronized batches (5
    // at once observed) instead of spacing individual requests. Serial is the
    // fix — one shard of 5 symbols completes in ~6 s.
    expect(QUOTES_BOUNDED_CONCURRENCY).toBe(1);
  });
});
