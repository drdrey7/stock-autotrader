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
  it("budgets 5 shards × 10 symbols = 50 Core symbols", () => {
    expect(QUOTES_SHARD_COUNT).toBe(5);
    expect(QUOTES_SYMBOLS_PER_SHARD).toBe(10);
    expect(QUOTES_TOTAL_SYMBOLS).toBe(50);
  });

  it("keeps the worst-case invocation well below the 50-subrequest cap", () => {
    // 10 symbols × 2 provider attempts (retries) = 20; target ~10 normally.
    expect(QUOTES_SHARD_WORST_CASE_EXTERNAL_SUBREQUESTS).toBe(20);
    expect(QUOTES_SHARD_WORST_CASE_EXTERNAL_SUBREQUESTS).toBeLessThan(WORKERS_FREE_EXTERNAL_SUBREQUEST_LIMIT);
    // Deliberate margin: never sit near the free-tier ceiling.
    expect(QUOTES_INVOCATION_HEADROOM).toBeGreaterThanOrEqual(25);
  });

  it("keeps bounded outbound concurrency under the 6-connection limit", () => {
    expect(QUOTES_BOUNDED_CONCURRENCY).toBeLessThanOrEqual(5);
  });
});
