import { describe, expect, it } from "vitest";
import { EARNINGS_BACKFILL_DAYS, EARNINGS_WINDOW_DAYS } from "./index";
import { addDays } from "./logic";
import { secIndexQuarters } from "./providers";
import {
  EXTERNAL_SUBREQUEST_BUDGET,
  FINNHUB_RATE_PACING_MS,
  MAX_COMBINED_PRODUCTION_INVOCATION_REQUESTS,
  MAX_FINNHUB_CALENDAR_REQUESTS,
  MAX_FINNHUB_PROFILE_REQUESTS,
  MAX_FINNHUB_PROFILE_REQUESTS_PER_JOB,
  MAX_HISTORICAL_RECOVERY_REQUESTS,
  MAX_HISTORICAL_RECOVERY_SYMBOLS_PER_JOB,
  MAX_PROVIDER_ATTEMPTS,
  MAX_SEC_FILING_LOOKUPS_PER_JOB,
  MAX_SEC_FILING_REQUESTS,
  MAX_SEC_INDEX_QUARTERS_PER_CALENDAR,
  MAX_SEC_METADATA_REQUESTS,
  MIN_PRODUCTION_INVOCATION_HEADROOM,
  REAL_DAILY_WORST_CASE_EXTERNAL_SUBREQUESTS,
  WORKERS_FREE_EXTERNAL_SUBREQUEST_LIMIT,
} from "./subrequest-budget";

describe("Workers Free external subrequest budget", () => {
  it("keeps every production invocation below the account limit", () => {
    expect(MAX_PROVIDER_ATTEMPTS).toBe(2);
    expect(MAX_SEC_FILING_LOOKUPS_PER_JOB).toBe(16);
    expect(MAX_SEC_FILING_REQUESTS).toBe(32);
    expect(EXTERNAL_SUBREQUEST_BUDGET).toEqual({
      monitorWithFinnhub: 39,
      monitorWithFmp: 39,
      monitorWithSec: 45,
      // 2 SEC meta + 2 bulk Finnhub + 32 filings + 4 recovery + 4 profile = 44
      dailyWithFinnhub: 44,
      dailyWithFmp: 44,
      dailyWithSec: 48,
    });
    // Production invocations: monitor+SEC path (45) and daily Finnhub (44).
    expect(MAX_COMBINED_PRODUCTION_INVOCATION_REQUESTS).toBe(45);
    expect(MIN_PRODUCTION_INVOCATION_HEADROOM).toBe(5);
    expect(MAX_COMBINED_PRODUCTION_INVOCATION_REQUESTS).toBeLessThan(WORKERS_FREE_EXTERNAL_SUBREQUEST_LIMIT);
    expect(Object.values(EXTERNAL_SUBREQUEST_BUDGET).every((value) => value < WORKERS_FREE_EXTERNAL_SUBREQUEST_LIMIT)).toBe(true);
  });

  it("counts every real daily Finnhub path call, including recovery/profile retries", () => {
    // Optimistic "typical case" maths are forbidden: build the worst case
    // from the live constants so a future cap bump fails this test.
    const realDaily =
      MAX_SEC_METADATA_REQUESTS
      + MAX_FINNHUB_CALENDAR_REQUESTS
      + MAX_SEC_FILING_REQUESTS
      + (MAX_HISTORICAL_RECOVERY_SYMBOLS_PER_JOB * MAX_PROVIDER_ATTEMPTS)
      + (MAX_FINNHUB_PROFILE_REQUESTS_PER_JOB * MAX_PROVIDER_ATTEMPTS);
    expect(REAL_DAILY_WORST_CASE_EXTERNAL_SUBREQUESTS).toBe(realDaily);
    expect(REAL_DAILY_WORST_CASE_EXTERNAL_SUBREQUESTS).toBe(EXTERNAL_SUBREQUEST_BUDGET.dailyWithFinnhub);
    expect(REAL_DAILY_WORST_CASE_EXTERNAL_SUBREQUESTS).toBeLessThan(WORKERS_FREE_EXTERNAL_SUBREQUEST_LIMIT);
    // Useful headroom: do not sit on the free-tier ceiling.
    expect(WORKERS_FREE_EXTERNAL_SUBREQUEST_LIMIT - REAL_DAILY_WORST_CASE_EXTERNAL_SUBREQUESTS).toBeGreaterThanOrEqual(2);
    expect(MAX_HISTORICAL_RECOVERY_REQUESTS).toBe(MAX_HISTORICAL_RECOVERY_SYMBOLS_PER_JOB * MAX_PROVIDER_ATTEMPTS);
    expect(MAX_FINNHUB_PROFILE_REQUESTS).toBe(MAX_FINNHUB_PROFILE_REQUESTS_PER_JOB * MAX_PROVIDER_ATTEMPTS);
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

  it("keeps recovery and metadata enrichment in maintenance mode with free-tier pacing", () => {
    expect(MAX_HISTORICAL_RECOVERY_SYMBOLS_PER_JOB).toBe(2);
    expect(MAX_FINNHUB_PROFILE_REQUESTS_PER_JOB).toBe(2);
    // Maintenance worst-case Finnhub calls in the daily job (excluding SEC):
    // bulk 2 + recovery 4 + profile 4 = 10 retried requests, paced at >=1.1s.
    expect(FINNHUB_RATE_PACING_MS).toBeGreaterThanOrEqual(1000);
    const finnhubOnly =
      MAX_FINNHUB_CALENDAR_REQUESTS
      + MAX_HISTORICAL_RECOVERY_REQUESTS
      + MAX_FINNHUB_PROFILE_REQUESTS;
    expect(finnhubOnly * FINNHUB_RATE_PACING_MS).toBeLessThan(30_000);
    expect(finnhubOnly * FINNHUB_RATE_PACING_MS).toBeLessThan(60 * 60 * 1000);
  });
});
