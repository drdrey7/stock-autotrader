import { describe, expect, it } from "vitest";
import { EARNINGS_BACKFILL_DAYS, EARNINGS_WINDOW_DAYS } from "./index";
import { addDays } from "./logic";
import { secIndexQuarters } from "./providers";
import {
  EXTERNAL_SUBREQUEST_BUDGET,
  FINNHUB_RATE_PACING_MS,
  MAX_COMBINED_PRODUCTION_INVOCATION_REQUESTS,
  MAX_FINNHUB_PROFILE_REQUESTS_PER_JOB,
  MAX_HISTORICAL_RECOVERY_SYMBOLS_PER_BOOTSTRAP,
  MAX_HISTORICAL_RECOVERY_SYMBOLS_PER_JOB,
  MAX_PROVIDER_ATTEMPTS,
  MAX_SEC_FILING_LOOKUPS_PER_JOB,
  MAX_SEC_FILING_REQUESTS,
  MAX_SEC_FULL_INDEX_REQUESTS,
  MAX_SEC_INDEX_QUARTERS_PER_CALENDAR,
  MIN_PRODUCTION_INVOCATION_HEADROOM,
  WORKERS_FREE_EXTERNAL_SUBREQUEST_LIMIT,
} from "./subrequest-budget";

describe("Workers Free external subrequest budget", () => {
  it("keeps every production invocation below the account limit", () => {
    expect(MAX_PROVIDER_ATTEMPTS).toBe(2);
    expect(MAX_SEC_FILING_LOOKUPS_PER_JOB).toBe(16);
    expect(MAX_SEC_FILING_REQUESTS).toBe(32);
    expect(MAX_SEC_FULL_INDEX_REQUESTS).toBe(6);
    expect(EXTERNAL_SUBREQUEST_BUDGET).toEqual({
      monitorWithFinnhub: 39,
      monitorWithFmp: 39,
      monitorWithSec: 45,
      dailyWithFinnhub: 36,
      dailyWithFmp: 36,
      dailyWithSec: 40,
    });
    expect(MAX_COMBINED_PRODUCTION_INVOCATION_REQUESTS).toBe(45);
    expect(MIN_PRODUCTION_INVOCATION_HEADROOM).toBe(5);
    expect(MAX_COMBINED_PRODUCTION_INVOCATION_REQUESTS).toBeLessThan(WORKERS_FREE_EXTERNAL_SUBREQUEST_LIMIT);
    expect(Object.values(EXTERNAL_SUBREQUEST_BUDGET).every((value) => value < WORKERS_FREE_EXTERNAL_SUBREQUEST_LIMIT)).toBe(true);
  });

  it("budgets the daily SEC calendar window for at most three quarterly indexes", () => {
    const today = "2026-08-13";
    const dailyRange = {
      from: addDays(today, -EARNINGS_BACKFILL_DAYS),
      to: addDays(today, EARNINGS_WINDOW_DAYS),
    };
    expect(EARNINGS_BACKFILL_DAYS + EARNINGS_WINDOW_DAYS + 1).toBe(91);
    expect(secIndexQuarters(dailyRange)).toHaveLength(2);
    expect(secIndexQuarters(dailyRange).length).toBeLessThanOrEqual(MAX_SEC_INDEX_QUARTERS_PER_CALENDAR);
  });

  it("keeps recovery and metadata enrichment within the free-tier pacing envelope", () => {
    // One request per recovered symbol; empty probes rest 7 days, so the
    // steady-state candidate set never exhausts the cap.
    expect(MAX_HISTORICAL_RECOVERY_SYMBOLS_PER_JOB).toBe(5);
    expect(MAX_HISTORICAL_RECOVERY_SYMBOLS_PER_BOOTSTRAP).toBe(2);
    expect(MAX_FINNHUB_PROFILE_REQUESTS_PER_JOB).toBe(15);
    // Steady-state worst-case daily calendar run: bulk 2 + recovery 5 +
    // metadata 15 + SEC metadata 2 + filing lookups 2 = 26 requests, all
    // paced at >=1.1s each => ~29s wall, inside the 30s Worker budget.
    // Pacing keeps the shared 60/min free-tier budget: 26 requests at
    // 1100ms = ~54 calls/min, matching the production probe that saw
    // zero 429s at this spacing.
    expect(FINNHUB_RATE_PACING_MS).toBeGreaterThanOrEqual(1000);
    const steadyStateRequests = 2 + MAX_HISTORICAL_RECOVERY_SYMBOLS_PER_JOB + MAX_FINNHUB_PROFILE_REQUESTS_PER_JOB + 2 + 2;
    expect(steadyStateRequests * FINNHUB_RATE_PACING_MS).toBeLessThan(30_000);
    expect(steadyStateRequests * FINNHUB_RATE_PACING_MS).toBeLessThan(60 * 60 * 1000);
  });
});
