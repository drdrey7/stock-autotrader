import { describe, expect, it } from "vitest";
import {
  automaticIntrinsicValueForScreener,
  automaticValuationAsOfDate,
  automaticValuationSplitFactor,
  calculateAutomaticIntrinsicValueFromPersistedFundamentals,
  type AutomaticValuationFundamentals,
} from "./automatic";

const HISTORY_DATE = "2026-06-30";

function fundamentals(overrides: Partial<AutomaticValuationFundamentals> = {}): AutomaticValuationFundamentals {
  return {
    eps_ttm: 4,
    fcf_per_share_ttm: 5,
    revenue_per_share_ttm: 90,
    book_value_per_share: 20,
    revenue_growth_ttm_yoy_pct: 35,
    revenue_growth_3y_pct: 15,
    revenue_growth_5y_pct: 25,
    roe_ttm_pct: 12,
    roic_pct: 10,
    fcf_margin_pct: 14,
    debt_to_equity: 0.1,
    pe_5y_p25: 60,
    pe_5y_median: 80,
    pe_5y_p75: 160,
    pe_5y_samples: 19,
    pe_5y_as_of: HISTORY_DATE,
    pfcf_5y_p25: 45,
    pfcf_5y_median: 60,
    pfcf_5y_p75: 110,
    pfcf_5y_samples: 20,
    pfcf_5y_as_of: HISTORY_DATE,
    ps_5y_p25: 5,
    ps_5y_median: 8,
    ps_5y_p75: 13,
    ps_5y_samples: 20,
    ps_5y_as_of: HISTORY_DATE,
    pb_5y_p25: 3,
    pb_5y_median: 4,
    pb_5y_p75: 6,
    pb_5y_samples: 20,
    pb_5y_as_of: HISTORY_DATE,
    market_checked_at: "2026-08-25T23:31:00Z",
    updated_at: "2026-08-25T23:31:01Z",
    ...overrides,
  };
}

describe("Automatic IV persisted-fundamentals adapter", () => {
  it("uses the persisted factual date rather than today's request date", () => {
    expect(automaticValuationAsOfDate(fundamentals())).toBe("2026-08-25");
    const result = calculateAutomaticIntrinsicValueFromPersistedFundamentals(
      "AMD",
      "Semiconductors",
      480,
      fundamentals(),
      [],
      "2026-09-10",
    );
    expect(result?.asOf).toBe("2026-08-25");
  });

  it("has no age TTL: an old last-known-good snapshot still produces IV", () => {
    const old = fundamentals({
      market_checked_at: "2026-05-01T12:00:00Z",
      updated_at: "2026-05-01T12:00:01Z",
    });
    const result = calculateAutomaticIntrinsicValueFromPersistedFundamentals(
      "AMD",
      "Semiconductors",
      480,
      old,
      [],
      "2026-08-26",
    );
    expect(result?.base).toBeGreaterThan(0);
    expect(result?.asOf).toBe("2026-05-01");
  });

  it("keeps IV when the quote is unavailable and only nulls the upside", () => {
    const result = calculateAutomaticIntrinsicValueFromPersistedFundamentals(
      "AMD",
      "Semiconductors",
      null,
      fundamentals(),
      [],
      "2026-08-26",
    );
    expect(result?.base).toBeGreaterThan(0);
    expect(result?.baseUpsidePct).toBeNull();
  });

  it("re-scales stale per-share facts for a post-snapshot split", () => {
    const stale = fundamentals({
      market_checked_at: "2026-08-01T10:00:00Z",
      updated_at: "2026-08-01T10:00:01Z",
    });
    const noSplit = calculateAutomaticIntrinsicValueFromPersistedFundamentals(
      "AMD",
      "Semiconductors",
      null,
      stale,
      [],
      "2026-08-26",
    );
    const fourForOne = calculateAutomaticIntrinsicValueFromPersistedFundamentals(
      "AMD",
      "Semiconductors",
      null,
      stale,
      [{ effective_date: "2026-08-20", split_factor: 4 }],
      "2026-08-26",
    );
    expect(noSplit).not.toBeNull();
    expect(fourForOne).not.toBeNull();
    expect(fourForOne!.base).toBeCloseTo(noSplit!.base / 4, 2);
    expect(fourForOne!.bear).toBeCloseTo(noSplit!.bear / 4, 2);
    expect(fourForOne!.bull).toBeCloseTo(noSplit!.bull / 4, 2);
  });

  it("ignores future splits and splits already reflected by the snapshot", () => {
    expect(automaticValuationSplitFactor("2026-08-10", "2026-08-26", [
      { effective_date: "2026-08-01", split_factor: 2 },
      { effective_date: "2026-08-20", split_factor: 4 },
      { effective_date: "2026-09-01", split_factor: 10 },
    ])).toBe(4);
  });

  it("converts automatic output to the existing Screener IV contract", () => {
    const result = calculateAutomaticIntrinsicValueFromPersistedFundamentals(
      "AMD",
      "Semiconductors",
      400,
      fundamentals(),
      [],
      "2026-08-26",
    );
    const screener = automaticIntrinsicValueForScreener(result, 400);
    expect(screener?.base).toBe(result?.base);
    expect(screener?.low).toBe(result?.bear);
    expect(screener?.high).toBe(result?.bull);
    expect(screener?.asOf).toBe("2026-08-25");
    expect(screener?.method).toContain("automatic-");
    expect(screener?.distancePct).not.toBeNull();
  });
});
