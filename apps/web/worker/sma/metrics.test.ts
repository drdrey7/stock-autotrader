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
    // Quote from week 33 (the anchor's own week): basis must drop anchor_close
    // (100) so the quote is counted exactly once as the 200th term.
    // sma = (19900 - 100 + 110) / 200 = 99.55
    const result = computeLiveSma200w(quote(110, W33_FRIDAY_QUOTE), metrics());
    expect(result.sma200w).toBeCloseTo(99.55, 10);
  });

  it("no current-week double count: Friday close equals anchor close", () => {
    // Quote == anchor_close (100): sma = (19900 - 100 + 100) / 200 = 99.5
    const result = computeLiveSma200w(quote(100, W33_FRIDAY_QUOTE), metrics());
    expect(result.sma200w).toBeCloseTo(99.5, 10);
  });

  it("weekend anchor: Saturday quote still belongs to the anchor week", () => {
    // Saturday 16:00Z = Saturday 12:00 ET -> ISO week 33 == anchor week.
    const result = computeLiveSma200w(quote(110, SATURDAY_QUOTE), metrics());
    expect(result.sma200w).toBeCloseTo(99.55, 10);
  });

  it("Monday pre-open: Friday-close quote anchors to the previous week", () => {
    // Sunday night NY quote (Friday close) -> week 33 -> subtract anchor close.
    const result = computeLiveSma200w(quote(110, SUNDAY_NIGHT_QUOTE), metrics());
    expect(result.sma200w).toBeCloseTo(99.55, 10);
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
    // Quote on Thursday 2025-04-17 itself (same week) -> delta 0 -> subtract.
    const sameWeek = computeLiveSma200w(quote(110, "2025-04-17T19:00:00.000Z"), holiday);
    expect(sameWeek.sma200w).toBeCloseTo(99.55, 10);
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

  it("Unavailable on a maintenance data gap (quote more than one week past anchor)", () => {
    // Quote in 2026-W35, anchor 2026-W33 -> delta 2 (missing week 34 basis).
    const result = computeLiveSma200w(quote(110, "2026-08-28T15:00:00.000Z"), metrics());
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
