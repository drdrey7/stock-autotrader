import { describe, expect, it } from "vitest";
import { EARNINGS_BACKFILL_DAYS, EARNINGS_WINDOW_DAYS } from "./index";
import { addDays } from "./logic";
import { secIndexQuarters } from "./providers";
import {
  EXTERNAL_SUBREQUEST_BUDGET,
  MAX_COMBINED_PRODUCTION_INVOCATION_REQUESTS,
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
});
