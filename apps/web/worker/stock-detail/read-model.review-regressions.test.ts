import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TechnicalMetricsRow } from "@stock-autotrader/contracts";
import type { Env } from "../index";
import type { StockDetailStorageSnapshot, WeeklyPriceRow } from "./storage";

const storageMock = vi.hoisted(() => ({
  readStockDetailStorageSnapshot: vi.fn(),
  persistSplitScaleMismatch: vi.fn(),
}));

vi.mock("./storage", () => ({
  ...storageMock,
  STOCK_DETAIL_VISIBLE_WEEKS: 260,
  STOCK_DETAIL_SMA_WARMUP_WEEKS: 199,
  STOCK_DETAIL_HISTORY_LIMIT: 459,
}));

import { buildHistoricalSma200w, readStockDetailApi } from "./read-model";

const NOW = new Date("2026-08-21T15:00:00.000Z");
const env = { DB: {} as D1Database } as Env;

function weeklyHistory(count: number): WeeklyPriceRow[] {
  const last = Date.parse("2026-08-14T00:00:00.000Z");
  return Array.from({ length: count }, (_, index): WeeklyPriceRow => {
    const close = count - index;
    const date = new Date(last - index * 7 * 86_400_000).toISOString().slice(0, 10);
    return {
      symbol: "MSFT",
      week_end_date: date,
      raw_open: close,
      raw_high: close + 1,
      raw_low: Math.max(0.5, close - 1),
      raw_close: close,
      volume: 1_000 + index,
      split_adjustment_factor: 1,
      split_adjusted_close: close,
      source: "alpha-vantage",
      source_fetched_at: "2026-08-15T06:00:00.000Z",
    };
  });
}

function metric(): TechnicalMetricsRow {
  return {
    symbol: "MSFT",
    anchor_week: "2026-08-14",
    completed_weeks_available: 459,
    sum_199: 199 * 400,
    anchor_close: 400,
    closed_sma_200w: 400,
    historical_data_as_of: "2026-08-14T20:00:00.000Z",
    calculated_at: "2026-08-15T06:00:00.000Z",
    status: "ok",
    source: "alpha-vantage",
  };
}

function splitReconciledHistory(): WeeklyPriceRow[] {
  return weeklyHistory(459).map((row) => row.week_end_date < "2026-08-10"
    ? {
        ...row,
        split_adjustment_factor: 2,
        split_adjusted_close: row.raw_close / 2,
      }
    : row);
}

function snapshot(weeklyRows: WeeklyPriceRow[]): StockDetailStorageSnapshot {
  return {
    company: { symbol: "MSFT", company: "Microsoft Corporation", logo_url: null },
    quote: {
      symbol: "MSFT",
      price: 250,
      change_abs: 2,
      change_pct: 0.8,
      day_high: null,
      day_low: null,
      day_open: null,
      previous_close: null,
      provider: "finnhub",
      provider_timestamp: "2026-08-21T14:59:00.000Z",
      updated_at: "2026-08-21T14:59:05.000Z",
    },
    metric: metric(),
    supports: undefined,
    intrinsicValue: undefined,
    fundamentals: null,
    weeklyRows,
    splitEvents: [{ effective_date: "2026-08-10", split_factor: 2 }],
    splitHistoryVerified: true,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Stock Detail review regressions", () => {
  it("suppresses chart and historical SMA while any served split row is unreconciled", async () => {
    const rows = splitReconciledHistory();
    const staleIndex = rows.findIndex((row) => row.week_end_date < "2026-08-10");
    rows[staleIndex] = {
      ...rows[staleIndex]!,
      split_adjustment_factor: 1,
      split_adjusted_close: rows[staleIndex]!.raw_close,
      source_fetched_at: "2026-08-07T20:00:00.000Z",
    };
    storageMock.readStockDetailStorageSnapshot.mockResolvedValue(snapshot(rows));

    const detail = await readStockDetailApi(env, "MSFT", NOW);

    expect(detail.quote.scaleState).toBe("mismatch");
    expect(detail.quote.price).toBeNull();
    expect(detail.chart.priceHistory).toEqual([]);
    expect(detail.technical.sma200wHistory).toEqual([]);
    expect(detail.freshness.historyAsOf).toBeNull();
  });

  it("does not emit a 200W SMA across a missing ISO week", () => {
    const start = Date.parse("2020-01-03T00:00:00.000Z");
    const history = Array.from({ length: 200 }, (_, index) => {
      const calendarWeekIndex = index < 100 ? index : index + 1;
      return {
        time: new Date(start + calendarWeekIndex * 7 * 86_400_000).toISOString().slice(0, 10),
        close: index + 1,
      };
    });

    expect(buildHistoricalSma200w(history)).toEqual([]);
  });
});
