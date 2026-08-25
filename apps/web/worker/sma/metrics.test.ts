import { describe, expect, it } from "vitest";
import type { TechnicalMetricsRow } from "@stock-autotrader/contracts";
import { computeLiveSma200w } from "./metrics";

/**
 * Fixture basis: anchor week 2026-08-14 (ISO 2026-W33), 1200 completed weeks,
 * sum_199 = 19900 (199 weeks x 100.0), anchor_close = 100.0.
 * Normal live case (quote in W34): sma = (19900 + quote) / 200.
 */
function metrics(overrides: Partial<TechnicalMetricsRow> = {}): TechnicalMetricsRow {
  return {
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
  };
}

const quote = (price: number, providerTimestamp: string) => ({ price, provider_timestamp: providerTimestamp });

/** Quote inside 2026-08-17..23 (ISO 2026-W34) — the normal live case. */
const W34_QUOTE = "2026-08-19T15:00:00.000Z"; // Wednesday 11:00 ET
/** Quote on Friday 2026-08-14 (ISO 2026-W33) — same week as the anchor. */
const W33_FRIDAY_QUOTE = "2026-08-14T19:30:00.000Z"; // 15:30 ET Friday
/** Saturday — NY still in ISO week 33. */
const SATURDAY_QUOTE = "2026-08-15T16:00:00.000Z";
/** Sunday night (NY) — still ISO week 33; the latest quote is Friday's close. */
const SUNDAY_NIGHT_QUOTE = "2026-08-16T23:30:00.000Z"; // Sunday 19:30 ET

describe("computeLiveSma200w — live formula (199 completed + current quote)", () => {
  it("uses 199 basis weeks + current quote when the quote is one week past the anchor", () => {
    // sum_199 = 19900 (199 x 100); quote 110 -> sma = (19900 + 110) / 200 = 100.05
    const result = computeLiveSma200w(quote(110, W34_QUOTE), metrics());
    expect(result.sma200w).toBeCloseTo(100.05, 10);
    expect(result.distanceToSma200wPct).toBeCloseTo((110 / 100.05 - 1) * 100, 10);
    expect(result.sma200wState).toBe("Above");
    expect(result.sma200wHistoryWeeks).toBe(1200);
    expect(result.sma200wAsOf).toBe("2026-08-19T06:00:00.000Z");
  });

  it("excludes the current week from the basis (quote week == anchor week)", () => {
    // Quote from week 33 (the anchor's own week). The 199 closes STRICTLY
    // BEFORE L come from the true 200-week basis: closed_sma_200w*200 - anchor
    // = 100*200 - 100 = 19900. sma = (19900 + 110) / 200 = 100.05.
    const result = computeLiveSma200w(quote(110, W33_FRIDAY_QUOTE), metrics());
    expect(result.sma200w).toBeCloseTo(100.05, 10);
    expect(result.distanceToSma200wPct).toBeCloseTo((110 / 100.05 - 1) * 100, 10);
    expect(result.sma200wState).toBe("Above");
  });

  it("no current-week double count: Friday close equals anchor close", () => {
    // Quote == anchor_close (100): prior_199_sum = 19900; sma = (19900 + 100) / 200 = 100.
    const result = computeLiveSma200w(quote(100, W33_FRIDAY_QUOTE), metrics());
    expect(result.sma200w).toBeCloseTo(100, 10);
    expect(result.distanceToSma200wPct).toBeCloseTo(0, 10);
    expect(result.sma200wState).toBe("Near");
  });

  it("weekend anchor: Saturday quote still belongs to the anchor week", () => {
    // Saturday 16:00Z = Saturday 12:00 ET -> ISO week 33 == anchor week.
    const result = computeLiveSma200w(quote(110, SATURDAY_QUOTE), metrics());
    expect(result.sma200w).toBeCloseTo(100.05, 10);
  });

  it("Monday pre-open: Friday-close quote anchors to the previous week", () => {
    // Sunday night NY quote (Friday close) -> week 33 -> subtract using the
    // 200-week basis.
    const result = computeLiveSma200w(quote(110, SUNDAY_NIGHT_QUOTE), metrics());
    expect(result.sma200w).toBeCloseTo(100.05, 10);
    // Monday 09:00 ET quote -> week 34 -> normal case.
    const monday = computeLiveSma200w(quote(110, "2026-08-17T13:05:00.000Z"), metrics());
    expect(monday.sma200w).toBeCloseTo(100.05, 10);
  });

  it("holiday week: Thursday bucket anchor compares by ISO week, not date", () => {
    // Anchor is the Good Friday week bucket (2025-04-17, ISO 2025-W16).
    const holiday = metrics({ anchor_week: "2025-04-17", sum_199: 19900, anchor_close: 100 });
    // Quote on the following Monday 2025-04-21 (ISO 2025-W17) -> delta 1.
    const result = computeLiveSma200w(quote(110, "2025-04-21T15:00:00.000Z"), holiday);
    expect(result.sma200w).toBeCloseTo(100.05, 10);
    // Quote on Thursday 2025-04-17 itself (same week) -> delta 0.
    const sameWeek = computeLiveSma200w(quote(110, "2025-04-17T19:00:00.000Z"), holiday);
    expect(sameWeek.sma200w).toBeCloseTo(100.05, 10);
  });
});

/**
 * Non-uniform basis regression suite for DELTA=0.
 *
 * Fixture: 1200 completed weeks; the last 200 closes are 1..200 so that
 *   closed_sma_200w          = 20100 / 200 = 100.5
 *   anchor_close (week L)    = 200
 *   sum_199 (closes 2..200)  = 20099
 * With a quote price P in week L (delta 0):
 *   prior_199_sum = 100.5 * 200 - 200 = 19900   (closes 1..199)
 *   live SMA      = (19900 + P) / 200
 * The naive formula `sum_199 - anchor_close` would use 20099 - 200 = 19899
 * (only 198 prior closes) — every assertion below discriminates the two.
 */
function nonUniformMetrics(overrides: Partial<TechnicalMetricsRow> = {}): TechnicalMetricsRow {
  return {
    symbol: "NVDA",
    anchor_week: "2026-08-14",
    completed_weeks_available: 1200,
    sum_199: 20099,
    anchor_close: 200,
    closed_sma_200w: 100.5,
    historical_data_as_of: "2026-08-19T06:00:00.000Z",
    calculated_at: "2026-08-19T06:00:00.000Z",
    status: "ok",
    source: "alpha-vantage",
    ...overrides,
  };
}

describe("computeLiveSma200w — delta=0 with NON-UNIFORM values (P0 regression)", () => {
  it.each([
    // [quotePrice, expectedSma] — all non-uniform, all "no two closes alike"
    // near the anchor, so the wrong (sum_199 - anchor) formula would FAIL.
    [210, (19900 + 210) / 200],
    [150, (19900 + 150) / 200],
    [99.5, (19900 + 99.5) / 200],
    [200, (19900 + 200) / 200],
  ])("quote in the anchor week with price %p uses the true 200-week basis", (price, expected) => {
    const result = computeLiveSma200w(quote(price, W33_FRIDAY_QUOTE), nonUniformMetrics());
    expect(result.sma200w).toBeCloseTo(expected, 10);
    // The naive (sum_199 - anchor_close) formula yields a different value —
    // prove the regression on a concrete pair:
    expect(result.sma200w).not.toBeCloseTo((20099 - 200 + price) / 200, 10);
  });

  it(">=200 completed weeks + delta=0 computes from the 200-week basis", () => {
    const result = computeLiveSma200w(quote(150, W33_FRIDAY_QUOTE), nonUniformMetrics());
    expect(result.sma200w).toBeCloseTo(100.25, 10);
    expect(result.sma200wState).toBe("Above");
    expect(result.sma200wHistoryWeeks).toBe(1200);
  });

  it("delta=1 with the non-uniform basis uses sum_199 directly", () => {
    // Quote in week 34 (one past anchor): sma = (sum_199 + price) / 200.
    const result = computeLiveSma200w(quote(210, W34_QUOTE), nonUniformMetrics());
    expect(result.sma200w).toBeCloseTo((20099 + 210) / 200, 10);
    expect(result.sma200w).toBeCloseTo(101.545, 10);
  });

  it("exactly 199 completed weeks + delta=0 -> honest NotEnoughHistory (no 200-week basis)", () => {
    const result = computeLiveSma200w(
      quote(150, W33_FRIDAY_QUOTE),
      nonUniformMetrics({ completed_weeks_available: 199, closed_sma_200w: null, status: "limited" }),
    );
    expect(result.sma200w).toBeNull();
    expect(result.distanceToSma200wPct).toBeNull();
    expect(result.sma200wState).toBe("NotEnoughHistory");
    expect(result.sma200wHistoryWeeks).toBe(199);
  });

  it.each([
    // [anchorBucket, quoteTs] — true delta=1 pairs across a year boundary
    // (2026 has 53 ISO weeks; 2025-12-26 is in 2025-W52).
    ["2025-12-26", "2026-01-01T15:00:00.000Z"],
    ["2026-12-31", "2027-01-04T15:00:00.000Z"],
  ])(
    "year boundary delta=1: anchor %s with quote one ISO week later (%s)",
    (anchorBucket, quoteTs) => {
      // Anchor week 2025-W52 / 2026-W53; quote lands in the NEXT ISO week
      // (2026-W01 / 2027-W01) -> delta 1 -> normal live formula.
      const ym = nonUniformMetrics({ anchor_week: anchorBucket });
      const result = computeLiveSma200w(quote(210, quoteTs), ym);
      expect(result.sma200w).toBeCloseTo((20099 + 210) / 200, 10);
      expect(result.sma200wState).toBe("Above");
    },
  );

  it("weekend after a year boundary: Friday 2026-12-25 quote (2026-W52) is delta 0 vs anchor", () => {
    // Anchor week 2026-W52; the quote's own Friday closes that same ISO week
    // -> delta 0 -> 200-week basis (19900).
    const ym = nonUniformMetrics({ anchor_week: "2026-12-25" });
    const result = computeLiveSma200w(quote(150, "2026-12-25T19:30:00.000Z"), ym);
    expect(result.sma200w).toBeCloseTo((19900 + 150) / 200, 10);
    expect(result.sma200wState).toBe("Above");
  });

  it("holiday week delta=0 uses the 200-week basis (Good Friday Thursday bucket)", () => {
    const holiday = nonUniformMetrics({ anchor_week: "2025-04-17" });
    const result = computeLiveSma200w(quote(210, "2025-04-17T19:00:00.000Z"), holiday);
    expect(result.sma200w).toBeCloseTo((19900 + 210) / 200, 10);
  });
});

describe("computeLiveSma200w — state classification", () => {
  it("Below when distance < 0", () => {
    // sma = (19900 + 90) / 200 = 99.95 -> distance = (90/99.95 - 1)*100 < 0
    const result = computeLiveSma200w(quote(90, W34_QUOTE), metrics());
    expect(result.sma200w).toBeCloseTo(99.95, 10);
    expect(result.distanceToSma200wPct).toBeCloseTo((90 / 99.95 - 1) * 100, 10);
    expect(result.distanceToSma200wPct).toBeLessThan(0);
    expect(result.sma200wState).toBe("Below");
  });

  it("Near at exactly +3.00 (boundary inclusive)", () => {
    // price such that (19900 + price)/200 = 100 and price/100 - 1 = 0.03 -> price = 103.
    // sma = (19900 + 103) / 200 = 100.015 -> distance = (103/100.015 - 1)*100 = 2.985... NOT 3.
    // Construct exactly: sma must be 100 -> sum = 20000 -> price = 100.
    // distance = (103 / 100 - 1) * 100 = 3.0 requires sma = 100 and price = 103:
    const basis = metrics({ sum_199: 200 * 100 - 103 }); // 19897
    const result = computeLiveSma200w(quote(103, W34_QUOTE), basis);
    expect(result.sma200w).toBeCloseTo(100, 10);
    expect(result.distanceToSma200wPct).toBeCloseTo(3.0, 10);
    expect(result.sma200wState).toBe("Near");
  });

  it("Above strictly greater than +3.00", () => {
    const basis = metrics({ sum_199: 200 * 100 - 103.01 }); // 19896.99
    const result = computeLiveSma200w(quote(103.01, W34_QUOTE), basis);
    expect(result.distanceToSma200wPct).toBeCloseTo(3.0 + 1e-9 + (103.01 / 100 - 1) * 100 - 3.0, 6);
    expect(result.distanceToSma200wPct).toBeGreaterThan(3.0);
    expect(result.sma200wState).toBe("Above");
  });

  it("Near at zero distance", () => {
    const basis = metrics({ sum_199: 200 * 100 - 100 }); // price == sma == 100
    const result = computeLiveSma200w(quote(100, W34_QUOTE), basis);
    expect(result.distanceToSma200wPct).toBeCloseTo(0, 10);
    expect(result.sma200wState).toBe("Near");
  });
});

describe("computeLiveSma200w — honest null handling", () => {
  it("NotEnoughHistory with fewer than 199 completed weeks", () => {
    const result = computeLiveSma200w(quote(110, W34_QUOTE), metrics({ completed_weeks_available: 150, sum_199: null, anchor_close: null }));
    expect(result.sma200w).toBeNull();
    expect(result.distanceToSma200wPct).toBeNull();
    expect(result.sma200wState).toBe("NotEnoughHistory");
    expect(result.sma200wHistoryWeeks).toBe(150);
  });

  it("Unavailable without a quote (never fabricates a live SMA)", () => {
    const result = computeLiveSma200w(null, metrics());
    expect(result.sma200w).toBeNull();
    expect(result.distanceToSma200wPct).toBeNull();
    expect(result.sma200wState).toBe("Unavailable");
    expect(result.sma200wHistoryWeeks).toBe(1200);
  });

  it("Unavailable without a metrics row", () => {
    const result = computeLiveSma200w(quote(110, W34_QUOTE), null);
    expect(result.sma200w).toBeNull();
    expect(result.sma200wState).toBe("Unavailable");
    expect(result.sma200wHistoryWeeks).toBeNull();
  });

  it("Unavailable when the quote is older than the basis (inconsistent)", () => {
    // Quote in 2026-W32, anchor 2026-W33 -> delta < 0.
    const result = computeLiveSma200w(quote(110, "2026-08-07T15:00:00.000Z"), metrics());
    expect(result.sma200w).toBeNull();
    expect(result.sma200wState).toBe("Unavailable");
  });

  it("LAST-KNOWN-GOOD: quote more than one week past anchor but a valid closed SMA exists", () => {
    // Quote in 2026-W35, anchor 2026-W33 -> delta 2 (weekly refresh lagged one
    // week but a previously-valid basis exists). The stored closed SMA (100) is
    // the last known good value and MUST keep being served — never nulled.
    const result = computeLiveSma200w(quote(110, "2026-08-28T15:00:00.000Z"), metrics());
    expect(result.sma200w).toBeCloseTo(100, 10);
    expect(result.distanceToSma200wPct).toBeCloseTo((110 / 100 - 1) * 100, 10);
    expect(result.distanceToSma200wPct).toBeCloseTo(10, 10);
    expect(result.sma200wState).toBe("Above");
    expect(result.sma200wHistoryWeeks).toBe(1200);
    expect(result.sma200wAsOf).toBe("2026-08-19T06:00:00.000Z");
  });

  it("LAST-KNOWN-GOOD: delta>1 with no valid closed SMA -> honest NotEnoughHistory", () => {
    // A symbol that never accumulated a valid 200-week basis has no closed SMA
    // to fall back to; it is NotEnoughHistory, not a fabricated value.
    const stunted = metrics({
      completed_weeks_available: 250,
      sum_199: 19900,
      anchor_close: 100,
      closed_sma_200w: null,
      status: "ok",
    });
    const result = computeLiveSma200w(quote(110, "2026-08-28T15:00:00.000Z"), stunted);
    expect(result.sma200w).toBeNull();
    expect(result.sma200wState).toBe("NotEnoughHistory");
    expect(result.sma200wHistoryWeeks).toBe(250);
  });

  it("LAST-KNOWN-GOOD does NOT apply on a split-scale mismatch (regression)", () => {
    // The stale-SMA fallback must NEVER serve the previously-valid value when
    // the current state is Unavailable due to a split-scale mismatch. The
    // mismatch guard runs before the delta>1 branch, so even a stored closed
    // SMA with delta>1 must read Unavailable — not the value from a different
    // split scale.
    const splitMap = new Map([["NVDA", "2026-08-20"]]);
    const result = computeLiveSma200w(
      quote(110, "2026-08-28T15:00:00.000Z"),                                        // W35, post-split
      metrics({ anchor_week: "2026-08-14", closed_sma_200w: 100, calculated_at: "2026-08-19T06:00:00.000Z" }), // pre-split metrics, W33 anchor
      splitMap,
    );
    expect(result.sma200w).toBeNull();
    expect(result.sma200wState).toBe("Unavailable");
  });

  it("Unavailable on unparseable quote timestamp or anchor", () => {
    expect(computeLiveSma200w(quote(110, "garbage"), metrics()).sma200wState).toBe("Unavailable");
    expect(computeLiveSma200w(quote(110, W34_QUOTE), metrics({ anchor_week: "not-a-date" })).sma200wState).toBe("Unavailable");
  });

  it("Unavailable on non-positive quote price", () => {
    expect(computeLiveSma200w(quote(0, W34_QUOTE), metrics()).sma200wState).toBe("Unavailable");
    expect(computeLiveSma200w(quote(-5, W34_QUOTE), metrics()).sma200wState).toBe("Unavailable");
  });
});

describe("computeLiveSma200w — symmetric split scale guard (P1)", () => {
  // Helper to build a per-symbol Map (NVDA only)
  const splitMap = (date: string) => new Map([["NVDA", date]]);

  it("A) Unavailable: quote post-split + metrics pre-split", () => {
    const result = computeLiveSma200w(
      quote(110, "2026-08-21T15:00:00.000Z"),  // after split
      metrics({ calculated_at: "2026-08-19T06:00:00.000Z" }),  // before split
      splitMap("2026-08-20"),
    );
    expect(result.sma200w).toBeNull();
    expect(result.sma200wState).toBe("Unavailable");
  });

  it("B) Unavailable: quote pre-split + metrics post-split (Monday-effective split)", () => {
    // Monday early maintenance recalculated basis post-split at 05:10 UTC,
    // but latest Finnhub quote is still Friday's pre-split close.
    const result = computeLiveSma200w(
      quote(110, "2026-08-14T20:00:00.000Z"),  // Friday pre-split
      metrics({ calculated_at: "2026-08-17T05:10:00.000Z" }),  // Monday post-split
      splitMap("2026-08-17"),
    );
    expect(result.sma200w).toBeNull();
    expect(result.sma200wState).toBe("Unavailable");
  });

  it("C) Normal SMA: both pre-split", () => {
    const result = computeLiveSma200w(
      quote(110, "2026-08-14T20:00:00.000Z"),  // pre-split
      metrics({ calculated_at: "2026-08-14T06:00:00.000Z" }),  // pre-split
      splitMap("2026-08-20"),
    );
    expect(result.sma200w).not.toBeNull();
    expect(result.sma200wState).not.toBe("Unavailable");
  });

  it("D) Normal SMA: both post-split", () => {
    const result = computeLiveSma200w(
      quote(110, "2026-08-21T15:00:00.000Z"),  // post-split
      metrics({ calculated_at: "2026-08-21T06:00:00.000Z" }),  // post-split
      splitMap("2026-08-20"),
    );
    expect(result.sma200w).not.toBeNull();
    expect(result.sma200wState).not.toBe("Unavailable");
  });

  it("E) Monday effective-date: metrics recalculated 05:10 UTC, Friday quote still old -> Unavailable", () => {
    const result = computeLiveSma200w(
      quote(110, "2026-08-14T20:00:00.000Z"),  // Friday pre-split
      metrics({ calculated_at: "2026-08-17T05:10:00.000Z" }),  // Monday post-split
      splitMap("2026-08-17"),
    );
    expect(result.sma200w).toBeNull();
    expect(result.sma200wState).toBe("Unavailable");
  });

  it("F) First valid Monday post-split Finnhub print arrives -> SMA available", () => {
    const result = computeLiveSma200w(
      quote(110, "2026-08-17T14:00:00.000Z"),  // Monday post-split quote
      metrics({ calculated_at: "2026-08-17T05:10:00.000Z" }),  // Monday post-split
      splitMap("2026-08-17"),
    );
    expect(result.sma200w).not.toBeNull();
    expect(result.sma200wState).not.toBe("Unavailable");
  });

  it("per-symbol: NVDA has split, AAPL has none -> AAPL unaffected", () => {
    // NVDA metrics should be unavailable (post-split quote, pre-split metrics)
    const nvdaResult = computeLiveSma200w(
      quote(110, "2026-08-21T15:00:00.000Z"),
      metrics({ symbol: "NVDA", calculated_at: "2026-08-19T06:00:00.000Z" }),
      splitMap("2026-08-20"),
    );
    expect(nvdaResult.sma200wState).toBe("Unavailable");

    // AAPL metrics: no split in map -> normal SMA
    const aaplResult = computeLiveSma200w(
      quote(110, W34_QUOTE),
      metrics({ symbol: "AAPL", calculated_at: "2026-08-19T06:00:00.000Z" }),
      splitMap("2026-08-20"),
    );
    expect(aaplResult.sma200w).not.toBeNull();
    expect(aaplResult.sma200wState).not.toBe("Unavailable");
  });

  it("computes normally when no split map is provided", () => {
    const result = computeLiveSma200w(quote(110, W34_QUOTE), metrics());
    expect(result.sma200w).not.toBeNull();
    expect(result.sma200wState).not.toBe("Unavailable");
  });
});

describe("computeLiveSma200w — exactly 199 weeks", () => {
  it("works with exactly 199 completed weeks (limited status)", () => {
    const result = computeLiveSma200w(
      quote(110, W34_QUOTE),
      metrics({ completed_weeks_available: 199, status: "limited" }),
    );
    expect(result.sma200w).toBeCloseTo(100.05, 10);
    expect(result.sma200wState).toBe("Above");
  });
});
