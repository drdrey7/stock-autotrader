import { describe, expect, it } from "vitest";
import {
  QUOTES_BOUNDED_CONCURRENCY,
  QUOTES_EXECUTION_DEADLINE_MS,
  QUOTES_INVOCATION_HEADROOM,
  QUOTES_PROVIDER_TIMEOUT_MS,
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

  it("uses a quotes-only timeout well under the earnings 8s", () => {
    expect(QUOTES_PROVIDER_TIMEOUT_MS).toBe(3_000);
  });

  it("keeps the worst-case wall (deadline + one retried symbol) under 30 s", () => {
    // One retried symbol: 2 attempts × (gate pacing 1100 + timeout) + 100ms
    // backoff. Per-symbol worst is 2×3s + 2×1.1s + 0.1s = 8.3s; 15s + 8.3s ≈ 23s.
    const earningsTimeout = 8_000; // they must stay decoupled
    expect(QUOTES_PROVIDER_TIMEOUT_MS).toBeLessThan(earningsTimeout);
    const perSymbolWorstMs = 2 * (QUOTES_PROVIDER_TIMEOUT_MS + 1_100) + 100;
    expect(QUOTES_EXECUTION_DEADLINE_MS + perSymbolWorstMs).toBeLessThan(30_000);
  });
});
