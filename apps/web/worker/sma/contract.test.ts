import { describe, expect, it } from "vitest";
import {
  screenerApiResponseSchema,
  screenerRowSchema,
  technicalMetricsRowSchema,
} from "@stock-autotrader/contracts";

/** A valid pre-PR2 ScreenerRow (old contract) plus the new SMA fields. */
function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    symbol: "AAPL",
    company: "Apple Inc.",
    price: 232.5,
    changeAbs: 1.2,
    changePct: 0.52,
    dayHigh: 234.0,
    dayLow: 230.0,
    dayOpen: 231.0,
    previousClose: 231.3,
    provider: "finnhub-websocket",
    asOf: "2026-08-19T15:00:00.000Z",
    updatedAt: "2026-08-19T15:00:00.000Z",
    state: "Live",
    sma200w: 200.0,
    distanceToSma200wPct: 3.0,
    sma200wState: "Near",
    sma200wHistoryWeeks: 1200,
    sma200wAsOf: "2026-08-19T06:00:00.000Z",
    ...overrides,
  };
}

function response(rows: Record<string, unknown>[] = [row()]): Record<string, unknown> {
  return {
    universe: { version: 1, total: rows.length },
    marketState: "regular",
    quotes: {
      state: "Live",
      provider: "finnhub-websocket",
      lastSuccessAt: "2026-08-19T15:00:00.000Z",
      lastAttemptAt: "2026-08-19T15:00:00.000Z",
      error: null,
      counts: { total: rows.length, live: rows.length, cached: 0, stale: 0, unavailable: 0 },
    },
    rows,
    asOf: "2026-08-19T15:00:00.000Z",
  };
}

describe("screener contract (PR2 extension)", () => {
  it("accepts the extended row contract (old fields + SMA fields)", () => {
    expect(screenerRowSchema.safeParse(row()).success).toBe(true);
  });

  it("accepts null SMA fields (honest unavailability)", () => {
    expect(screenerRowSchema.safeParse(row({
      sma200w: null,
      distanceToSma200wPct: null,
      sma200wState: "NotEnoughHistory",
      sma200wHistoryWeeks: 90,
      sma200wAsOf: null,
    })).success).toBe(true);
  });

  it("accepts every sma200wState value", () => {
    for (const state of ["Above", "Near", "Below", "NotEnoughHistory", "Unavailable"]) {
      expect(screenerRowSchema.safeParse(row({ sma200wState: state })).success).toBe(true);
    }
  });

  it("rejects unknown sma200wState values", () => {
    expect(screenerRowSchema.safeParse(row({ sma200wState: "AboveTheClouds" })).success).toBe(false);
  });

  it("rejects non-finite SMA numbers", () => {
    expect(screenerRowSchema.safeParse(row({ sma200w: Number.NaN })).success).toBe(false);
    expect(screenerRowSchema.safeParse(row({ distanceToSma200wPct: Number.POSITIVE_INFINITY })).success).toBe(false);
    expect(screenerRowSchema.safeParse(row({ sma200w: -1 })).success).toBe(false); // SMA must be positive
  });

  it("rejects negative history weeks", () => {
    expect(screenerRowSchema.safeParse(row({ sma200wHistoryWeeks: -1 })).success).toBe(false);
  });

  it("accepts the full API response shape", () => {
    expect(screenerApiResponseSchema.safeParse(response()).success).toBe(true);
  });

  it("keeps the pre-PR2 contract valid (backward compatibility)", () => {
    // A response whose rows carry the old fields but null SMA fields parses.
    const legacy = response([row({
      sma200w: null, distanceToSma200wPct: null, sma200wState: null,
      sma200wHistoryWeeks: null, sma200wAsOf: null,
    })]);
    expect(screenerApiResponseSchema.safeParse(legacy).success).toBe(true);
  });
});

describe("technical_metrics contract", () => {
  const metrics = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    symbol: "NVDA",
    anchor_week: "2026-08-14",
    completed_weeks_available: 1200,
    sum_199: 19900,
    anchor_close: 100,
    closed_sma_200w: 100,
    historical_data_as_of: "2026-08-19T06:00:00.000Z",
    calculated_at: "2026-08-19T06:00:00.000Z",
    status: "ok",
    source: "alpha-vantage",
    ...overrides,
  });

  it("accepts a valid row", () => {
    expect(technicalMetricsRowSchema.safeParse(metrics()).success).toBe(true);
  });

  it("accepts the not_enough_history shape (null basis)", () => {
    expect(technicalMetricsRowSchema.safeParse(metrics({
      anchor_week: null,
      sum_199: null,
      anchor_close: null,
      closed_sma_200w: null,
      completed_weeks_available: 90,
      status: "not_enough_history",
    })).success).toBe(true);
  });

  it("accepts every status value", () => {
    for (const status of ["ok", "limited", "not_enough_history", "no_data"]) {
      expect(technicalMetricsRowSchema.safeParse(metrics({ status })).success).toBe(true);
    }
  });

  it("rejects unknown status and malformed anchor", () => {
    expect(technicalMetricsRowSchema.safeParse(metrics({ status: "bogus" })).success).toBe(false);
    expect(technicalMetricsRowSchema.safeParse(metrics({ anchor_week: "next friday" })).success).toBe(false);
    expect(technicalMetricsRowSchema.safeParse(metrics({ anchor_week: "2026/08/14" })).success).toBe(false);
    // A well-formed-but-impossible date passes the format schema; the worker
    // runtime rejects it via isoWeekOfDateKey (-> Unavailable), which is
    // covered in sma/metrics.test.ts.
    expect(technicalMetricsRowSchema.safeParse(metrics({ anchor_week: "2026-13-99" })).success).toBe(true);
  });
});
