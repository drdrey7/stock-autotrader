import { describe, expect, it } from "vitest";
import { servedSplitScaleState } from "./read-model";
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

describe("servedSplitScaleState with a split older than the loaded window", () => {
  it("accepts a fully reconciled post-split history window without a pre-split witness", () => {
    const rows = [
      weeklyRow({ week_end_date: "2021-01-08", raw_close: 120, split_adjusted_close: 120 }),
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
