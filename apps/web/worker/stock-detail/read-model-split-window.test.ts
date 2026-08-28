import { describe, expect, it } from "vitest";
import {
  hasUnexplainedHistoricalScaleTransition,
  servedSplitScaleState,
} from "./read-model";
import type { StockDetailSplitEventRow, WeeklyPriceRow } from "./storage";

function weeklyRow(overrides: Partial<WeeklyPriceRow> = {}): WeeklyPriceRow {
  return {
    symbol: "MSFT",
    week_end_date: "2020-01-03",
    raw_open: 100,
    raw_high: 110,
    raw_low: 90,
    raw_close: 105,
    volume: 1_000,
    split_adjustment_factor: 1,
    split_adjusted_close: 105,
    source: "fixture",
    source_fetched_at: "2026-08-21T12:00:00.000Z",
    ...overrides,
  };
}

const oldSplit: StockDetailSplitEventRow = {
  effective_date: "2010-06-15",
  split_factor: 2,
};

const recentSplit: StockDetailSplitEventRow = {
  effective_date: "2026-08-10",
  split_factor: 2,
};

const postSplitQuote = {
  price: 500,
  provider_timestamp: "2026-08-21T14:30:00.000Z",
};

const postSplitMetricAt = "2026-08-21T12:30:00.000Z";

function mixedScaleHistory(): WeeklyPriceRow[] {
  return [
    weeklyRow({
      week_end_date: "2024-07-05",
      raw_open: 54,
      raw_high: 61,
      raw_low: 46,
      raw_close: 56,
      split_adjusted_close: 56,
    }),
    weeklyRow({
      week_end_date: "2024-06-28",
      raw_open: 119,
      raw_high: 122,
      raw_low: 118,
      raw_close: 120,
      split_adjusted_close: 120,
    }),
    weeklyRow({
      week_end_date: "2024-06-21",
      raw_open: 117,
      raw_high: 121,
      raw_low: 115,
      raw_close: 118,
      split_adjusted_close: 118,
    }),
    weeklyRow({
      week_end_date: "2024-06-14",
      raw_open: 1170,
      raw_high: 1210,
      raw_low: 1150,
      raw_close: 1180,
      split_adjusted_close: 1180,
    }),
    weeklyRow({
      week_end_date: "2024-06-07",
      raw_open: 1190,
      raw_high: 1220,
      raw_low: 1180,
      raw_close: 1200,
      split_adjusted_close: 1200,
    }),
  ];
}

describe("legacy mixed-scale detection", () => {
  it("finds a persisted OHLC scale transition without split events or quote data", () => {
    expect(hasUnexplainedHistoricalScaleTransition(mixedScaleHistory())).toBe(true);
  });

  it("does not classify an ordinary 50% move with inconsistent OHLC ratios as a split", () => {
    const rows = [
      weeklyRow({
        week_end_date: "2024-06-28",
        raw_open: 50,
        raw_high: 60,
        raw_low: 45,
        raw_close: 55,
        split_adjusted_close: 55,
      }),
      weeklyRow({
        week_end_date: "2024-06-21",
        raw_open: 100,
        raw_high: 110,
        raw_low: 90,
        raw_close: 105,
        split_adjusted_close: 105,
      }),
      weeklyRow({
        week_end_date: "2024-06-14",
        raw_open: 102,
        raw_high: 112,
        raw_low: 92,
        raw_close: 107,
        split_adjusted_close: 107,
      }),
    ];
    expect(hasUnexplainedHistoricalScaleTransition(rows)).toBe(false);
  });

  it("does not use a non-consecutive bucket as the scale witness", () => {
    const rows = mixedScaleHistory();
    rows[1] = { ...rows[1]!, week_end_date: "2024-06-07" };
    expect(hasUnexplainedHistoricalScaleTransition(rows)).toBe(false);
  });
});

describe("servedSplitScaleState with a split older than the loaded window", () => {
  it("accepts a fully reconciled post-split history window without a pre-split witness", () => {
    const rows = [
      weeklyRow({ week_end_date: "2021-01-08", raw_high: 130, raw_close: 120, split_adjusted_close: 120 }),
      weeklyRow({ week_end_date: "2020-01-03" }),
    ];

    expect(servedSplitScaleState(postSplitQuote, postSplitMetricAt, rows, [oldSplit])).toBe("safe");
  });

  it("fails closed when a loaded post-split row carries the wrong cumulative factor", () => {
    const rows = [weeklyRow({ split_adjustment_factor: 2, split_adjusted_close: 52.5 })];

    expect(servedSplitScaleState(postSplitQuote, postSplitMetricAt, rows, [oldSplit])).toBe("mismatch");
  });

  it("fails closed when the loaded history was fetched before the split", () => {
    const rows = [weeklyRow({ source_fetched_at: "2009-12-31T12:00:00.000Z" })];

    expect(servedSplitScaleState(postSplitQuote, postSplitMetricAt, rows, [oldSplit])).toBe("mismatch");
  });
});

describe("servedSplitScaleState with reconciled weekly history", () => {
  it("keeps a post-split quote safe when technical metrics are unavailable", () => {
    const rows = [weeklyRow({
      week_end_date: "2026-08-07",
      split_adjustment_factor: 2,
      split_adjusted_close: 52.5,
      source_fetched_at: "2026-08-21T12:00:00.000Z",
    })];

    expect(servedSplitScaleState(postSplitQuote, null, rows, [recentSplit])).toBe("safe");
  });

  it("rejects a partially reconciled served window even when the newest pre-split witness is correct", () => {
    const rows = [
      weeklyRow({
        week_end_date: "2026-08-07",
        split_adjustment_factor: 2,
        split_adjusted_close: 52.5,
        source_fetched_at: "2026-08-21T12:00:00.000Z",
      }),
      weeklyRow({
        week_end_date: "2026-07-31",
        split_adjustment_factor: 1,
        split_adjusted_close: 105,
        source_fetched_at: "2026-08-07T12:00:00.000Z",
      }),
    ];

    expect(servedSplitScaleState(postSplitQuote, null, rows, [recentSplit])).toBe("mismatch");
  });
});

describe("servedSplitScaleState without weekly chart history", () => {
  it("keeps a post-split quote safe even when no metric or weekly history is available", () => {
    expect(servedSplitScaleState(postSplitQuote, null, [], [recentSplit])).toBe("safe");
  });

  it("suppresses a pre-split quote even when no weekly history is available", () => {
    expect(servedSplitScaleState(
      { price: 1_000, provider_timestamp: "2026-08-07T20:00:00.000Z" },
      null,
      [],
      [recentSplit],
    )).toBe("mismatch");
  });

  it("stays unknown when there is no quote to prove the post-split scale", () => {
    expect(servedSplitScaleState(null, postSplitMetricAt, [], [recentSplit])).toBe("unknown");
  });
});
