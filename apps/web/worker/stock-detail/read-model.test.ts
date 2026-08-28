import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../index";
import type { TechnicalMetricsRow } from "@stock-autotrader/contracts";
import type { StockDetailStorageSnapshot, WeeklyPriceRow } from "./storage";

const storageMock = vi.hoisted(() => ({
  readStockDetailStorageSnapshot: vi.fn(),
  clearQuoteHistoryScaleMismatch: vi.fn(),
  persistSplitScaleMismatch: vi.fn(),
}));

vi.mock("./storage", () => ({
  ...storageMock,
  STOCK_DETAIL_VISIBLE_WEEKS: 260,
  STOCK_DETAIL_SMA_WARMUP_WEEKS: 199,
  STOCK_DETAIL_HISTORY_LIMIT: 459,
}));

import {
  buildHistoricalSma200w,
  calculateAccountingCardMetrics,
  hasUnexpectedQuoteScaleMismatch,
  readStockDetailApi,
  servedSplitScaleState,
  toSplitAdjustedPricePoint,
} from "./read-model";

const NOW = new Date("2026-08-21T15:00:00.000Z");
const env = { DB: {} as D1Database } as Env;

function metric(overrides: Partial<TechnicalMetricsRow> = {}): TechnicalMetricsRow {
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
    ...overrides,
  };
}

function weeklyHistory(count: number, symbol = "MSFT"): WeeklyPriceRow[] {
  const last = Date.parse("2026-08-14T00:00:00.000Z");
  const chronological = Array.from({ length: count }, (_, index): WeeklyPriceRow => {
    const close = index + 1;
    const date = new Date(last - (count - 1 - index) * 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    return {
      symbol,
      week_end_date: date,
      raw_open: close,
      raw_high: close + 2,
      raw_low: Math.max(0.5, close - 2),
      raw_close: close,
      volume: 1000 + index,
      split_adjustment_factor: 1,
      split_adjusted_close: close,
      source: "alpha-vantage",
      source_fetched_at: "2026-08-15T06:00:00.000Z",
    };
  });
  return chronological.reverse();
}

function applySplitToHistory(
  rows: WeeklyPriceRow[],
  effectiveDate: string,
  factor: number,
  fetchedAt = "2026-08-15T06:00:00.000Z",
): WeeklyPriceRow[] {
  return rows.map((row) => row.week_end_date < effectiveDate
    ? {
        ...row,
        split_adjustment_factor: row.split_adjustment_factor * factor,
        split_adjusted_close: row.raw_close / (row.split_adjustment_factor * factor),
        source_fetched_at: fetchedAt,
      }
    : { ...row, source_fetched_at: fetchedAt });
}

function baseSnapshot(overrides: Partial<StockDetailStorageSnapshot> = {}): StockDetailStorageSnapshot {
  return {
    company: {
      symbol: "MSFT",
      company: "Microsoft Corporation",
      logo_url: "https://example.com/msft.png",
    },
    quote: {
      symbol: "MSFT",
      price: 500,
      change_abs: 5,
      change_pct: 1,
      day_high: 505,
      day_low: 490,
      day_open: 492,
      previous_close: 495,
      provider: "finnhub",
      provider_timestamp: "2026-08-21T14:59:00.000Z",
      updated_at: "2026-08-21T14:59:05.000Z",
    },
    metric: metric(),
    supports: {
      symbol: "MSFT",
      levels: [
        { symbol: "MSFT", method: "manual", level: 1, price: 450, as_of_date: "2026-08-03" },
        { symbol: "MSFT", method: "manual", level: 2, price: 520, as_of_date: "2026-08-03" },
      ],
    },
    intrinsicValue: {
      symbol: "MSFT",
      values: {
        symbol: "MSFT",
        method: "manual",
        low_value: 550,
        base_value: 600,
        high_value: 650,
        as_of_date: "2026-08-03",
      },
    },
    fundamentals: null,
    weeklyRows: weeklyHistory(459),
    splitEvents: [],
    splitHistoryVerified: true,
    ...overrides,
  };
}

function accountingFundamentals(
  overrides: Partial<NonNullable<StockDetailStorageSnapshot["fundamentals"]>> = {},
): NonNullable<StockDetailStorageSnapshot["fundamentals"]> {
  return {
    symbol: "MSFT",
    market_cap: null,
    pe_ttm: null,
    revenue_ttm: 250_000,
    operating_income_ttm: 100_000,
    pretax_income_ttm: 98_000,
    income_tax_ttm: 18_000,
    operating_cash_flow_ttm: 110_000,
    capex_ttm: 20_000,
    free_cash_flow_ttm: null,
    cash: 50_000,
    short_term_investments: 10_000,
    total_debt: 40_000,
    shareholders_equity: 200_000,
    roic_pct: 1,
    fcf_margin_pct: 2,
    debt_to_equity: 3,
    accounting_periods_compatible: 1,
    accounting_as_of: "2026-06-30",
    market_as_of: null,
    market_checked_at: null,
    accounting_source: "edgartools",
    market_source: "finnhub",
    updated_at: "2026-08-21T15:01:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  storageMock.readStockDetailStorageSnapshot.mockResolvedValue(baseSnapshot());
});

describe("split-adjusted weekly OHLC", () => {
  it("adjusts every OHLC field onto the current scale and cross-checks close", () => {
    expect(toSplitAdjustedPricePoint({
      symbol: "MSFT",
      week_end_date: "2020-01-03",
      raw_open: 200,
      raw_high: 220,
      raw_low: 180,
      raw_close: 210,
      volume: 123,
      split_adjustment_factor: 2,
      split_adjusted_close: 105,
      source: "alpha-vantage",
      source_fetched_at: "2026-08-15T06:00:00.000Z",
    })).toEqual({ time: "2020-01-03", open: 100, high: 110, low: 90, close: 105, volume: 123 });
  });

  it("rejects a persisted adjusted close that disagrees outside tolerance", () => {
    const row = weeklyHistory(1)[0]!;
    expect(toSplitAdjustedPricePoint({ ...row, split_adjusted_close: row.raw_close + 5 })).toBeNull();
  });
});

describe("historical SMA200W", () => {
  it("uses a rolling 200-week window with deterministic math", () => {
    const history = Array.from({ length: 201 }, (_, index) => ({
      time: new Date(Date.UTC(2020, 0, 3 + index * 7)).toISOString().slice(0, 10),
      close: index + 1,
    }));
    const sma = buildHistoricalSma200w(history);
    expect(sma).toHaveLength(2);
    expect(sma[0]!.value).toBeCloseTo(100.5, 10);
    expect(sma[1]!.value).toBeCloseTo(101.5, 10);
  });

  it("returns no series with fewer than 200 completed weeks", () => {
    const history = weeklyHistory(199).reverse().map((row) => ({ time: row.week_end_date, close: row.split_adjusted_close }));
    expect(buildHistoricalSma200w(history)).toEqual([]);
  });
});

describe("split scale safety", () => {
  it("is safe without an effective split", () => {
    expect(servedSplitScaleState(
      { price: 500, provider_timestamp: "2026-08-21T14:59:00.000Z" },
      "2026-08-15T06:00:00.000Z",
      weeklyHistory(459),
      [],
      true,
    )).toBe("safe");
  });

  it("fails closed when history has no split events and no durable verification", () => {
    expect(servedSplitScaleState(
      { price: 500, provider_timestamp: "2026-08-21T14:59:00.000Z" },
      "2026-08-15T06:00:00.000Z",
      weeklyHistory(459),
      [],
      false,
    )).toBe("unknown");
  });

  it("accepts a no-split history only after durable verification", () => {
    expect(servedSplitScaleState(
      { price: 500, provider_timestamp: "2026-08-21T14:59:00.000Z" },
      "2026-08-15T06:00:00.000Z",
      weeklyHistory(459),
      [],
      true,
    )).toBe("safe");
  });

  it("accepts a split only after weekly history, quote and metrics all show post-split evidence", () => {
    const history = applySplitToHistory(weeklyHistory(459), "2026-08-10", 2);
    expect(servedSplitScaleState(
      { price: 250, provider_timestamp: "2026-08-21T14:59:00.000Z" },
      "2026-08-15T06:00:00.000Z",
      history,
      [{ effective_date: "2026-08-10", split_factor: 2 }],
    )).toBe("safe");
  });

  it("fails closed while weekly history has not yet incorporated an effective split", () => {
    expect(servedSplitScaleState(
      { price: 250, provider_timestamp: "2026-08-21T14:59:00.000Z" },
      "2026-08-15T06:00:00.000Z",
      weeklyHistory(459),
      [{ effective_date: "2026-08-10", split_factor: 2 }],
    )).toBe("mismatch");
  });

  it("fails closed while quote or metrics still predate the effective split", () => {
    const history = applySplitToHistory(weeklyHistory(459), "2026-08-10", 2);
    expect(servedSplitScaleState(
      { price: 500, provider_timestamp: "2026-08-07T20:00:00.000Z" },
      "2026-08-15T06:00:00.000Z",
      history,
      [{ effective_date: "2026-08-10", split_factor: 2 }],
    )).toBe("mismatch");
    expect(servedSplitScaleState(
      { price: 250, provider_timestamp: "2026-08-21T14:59:00.000Z" },
      "2026-08-07T20:00:00.000Z",
      history,
      [{ effective_date: "2026-08-10", split_factor: 2 }],
    )).toBe("mismatch");
  });

  it("blocks an unannounced structural 10:1 scale transition", () => {
    const rows = weeklyHistory(3).map((row) => ({
      ...row,
      raw_close: 1_200,
      raw_open: 1_190,
      raw_high: 1_220,
      raw_low: 1_180,
      split_adjusted_close: 1_200,
    }));
    expect(hasUnexpectedQuoteScaleMismatch(
      {
        price: 120,
        previous_close: 1_200,
        provider_timestamp: "2026-08-21T14:59:00.000Z",
        quote_session_date: "2026-08-21",
        previous_close_session_date: "2026-08-20",
        daily_change_valid: 1,
      },
      rows,
      [],
    )).toBe(true);
  });

  it("allows ordinary drift in the prior old-scale week when the latest week proves the transition", () => {
    const rows = weeklyHistory(3).map((row, index) => ({
      ...row,
      raw_close: index === 0 ? 100 : index === 1 ? 95 : 90,
      raw_open: index === 0 ? 99 : index === 1 ? 94 : 89,
      raw_high: index === 0 ? 102 : index === 1 ? 97 : 92,
      raw_low: index === 0 ? 98 : index === 1 ? 93 : 88,
      split_adjusted_close: index === 0 ? 100 : index === 1 ? 95 : 90,
    }));
    expect(hasUnexpectedQuoteScaleMismatch(
      {
        price: 10,
        previous_close: 100,
        provider_timestamp: "2026-08-21T14:59:00.000Z",
        quote_session_date: "2026-08-21",
        previous_close_session_date: "2026-08-20",
        daily_change_valid: 1,
      },
      rows,
      [],
    )).toBe(true);
  });

  it("does not turn a normal 50% move without multi-week scale evidence into a split", () => {
    const rows = weeklyHistory(3).map((row, index) => ({
      ...row,
      raw_close: index === 0 ? 200 : 170,
      raw_open: index === 0 ? 198 : 168,
      raw_high: index === 0 ? 205 : 175,
      raw_low: index === 0 ? 195 : 165,
      split_adjusted_close: index === 0 ? 200 : 170,
    }));
    expect(hasUnexpectedQuoteScaleMismatch(
      {
        price: 100,
        previous_close: 200,
        provider_timestamp: "2026-08-21T14:59:00.000Z",
        quote_session_date: "2026-08-21",
        previous_close_session_date: "2026-08-20",
        daily_change_valid: 1,
      },
      rows,
      [],
    )).toBe(false);
  });

  it("does not infer a split from ordinary-scale quote data and near-factor history alone", () => {
    const rows = weeklyHistory(3).map((row, index) => ({
      ...row,
      raw_close: index === 0 ? 100 : index === 1 ? 98 : 96,
      raw_open: index === 0 ? 99 : index === 1 ? 97 : 95,
      raw_high: index === 0 ? 102 : index === 1 ? 100 : 98,
      raw_low: index === 0 ? 98 : index === 1 ? 96 : 94,
      split_adjusted_close: index === 0 ? 100 : index === 1 ? 98 : 96,
    }));
    expect(hasUnexpectedQuoteScaleMismatch(
      {
        price: 50,
        previous_close: 50,
        provider_timestamp: "2026-08-21T14:59:00.000Z",
        quote_session_date: "2026-08-21",
        previous_close_session_date: "2026-08-20",
        daily_change_valid: 1,
      },
      rows,
      [],
    )).toBe(false);
  });

  it("does not treat a sustained near-one ratio as a split without OHLC regime evidence", () => {
    const rows = weeklyHistory(3).map((row, index) => ({
      ...row,
      raw_close: index === 0 ? 118 : index === 1 ? 116 : 114,
      raw_open: index === 0 ? 117 : index === 1 ? 115 : 113,
      raw_high: index === 0 ? 120 : index === 1 ? 118 : 116,
      raw_low: index === 0 ? 115 : index === 1 ? 113 : 111,
      split_adjusted_close: index === 0 ? 118 : index === 1 ? 116 : 114,
    }));
    expect(hasUnexpectedQuoteScaleMismatch(
      {
        price: 100,
        previous_close: 100,
        provider_timestamp: "2026-08-21T14:59:00.000Z",
        quote_session_date: "2026-08-21",
        previous_close_session_date: "2026-08-20",
        daily_change_valid: 1,
      },
      rows,
      [],
    )).toBe(false);
  });

  it("detects a quote already normalized while two recent historical closes remain raw", () => {
    const rows = weeklyHistory(3).map((row, index) => ({
      ...row,
      raw_open: index === 0 ? 1_190 : index === 1 ? 1_188 : 1_186,
      raw_high: index === 0 ? 1_220 : index === 1 ? 1_218 : 1_216,
      raw_low: index === 0 ? 1_180 : index === 1 ? 1_178 : 1_176,
      raw_close: index === 0 ? 1_200 : index === 1 ? 1_198 : 1_196,
      split_adjusted_close: index === 0 ? 1_200 : index === 1 ? 1_198 : 1_196,
    }));
    expect(hasUnexpectedQuoteScaleMismatch(
      {
        price: 122,
        previous_close: 120,
        provider_timestamp: "2026-08-21T14:59:00.000Z",
        quote_session_date: "2026-08-21",
        previous_close_session_date: "2026-08-20",
        daily_change_valid: 1,
      },
      rows,
      [],
    )).toBe(true);
  });

  it("allows ordinary drift in the prior week of a strong normalized-quote transition", () => {
    const rows = weeklyHistory(3).map((row, index) => ({
      ...row,
      raw_open: index === 0 ? 99 : index === 1 ? 94 : 89,
      raw_high: index === 0 ? 102 : index === 1 ? 97 : 92,
      raw_low: index === 0 ? 98 : index === 1 ? 93 : 88,
      raw_close: index === 0 ? 100 : index === 1 ? 95 : 90,
      split_adjusted_close: index === 0 ? 100 : index === 1 ? 95 : 90,
    }));
    expect(hasUnexpectedQuoteScaleMismatch(
      {
        price: 10,
        previous_close: 10,
        provider_timestamp: "2026-08-21T14:59:00.000Z",
        quote_session_date: "2026-08-21",
        previous_close_session_date: "2026-08-20",
        daily_change_valid: 1,
      },
      rows,
      [],
    )).toBe(true);
  });

  it("does not infer a split from two non-consecutive weekly rows", () => {
    const rows = weeklyHistory(3).map((row) => ({
      ...row,
      raw_close: 1_200,
      raw_open: 1_190,
      raw_high: 1_220,
      raw_low: 1_180,
      split_adjusted_close: 1_200,
    }));
    rows[1] = { ...rows[1]!, week_end_date: "2026-07-24" };
    expect(hasUnexpectedQuoteScaleMismatch(
      {
        price: 120,
        previous_close: 1_200,
        provider_timestamp: "2026-08-21T14:59:00.000Z",
        quote_session_date: "2026-08-21",
        previous_close_session_date: "2026-08-20",
        daily_change_valid: 1,
      },
      rows,
      [],
    )).toBe(false);
  });

  it("recognizes a structurally evidenced reverse split without guessing from a move alone", () => {
    const rows = weeklyHistory(3).map((row) => ({
      ...row,
      raw_close: 100,
      raw_open: 99,
      raw_high: 102,
      raw_low: 98,
      split_adjusted_close: 100,
    }));
    expect(hasUnexpectedQuoteScaleMismatch(
      {
        price: 200,
        previous_close: 100,
        provider_timestamp: "2026-08-21T14:59:00.000Z",
        quote_session_date: "2026-08-21",
        previous_close_session_date: "2026-08-20",
        daily_change_valid: 1,
      },
      rows,
      [],
    )).toBe(true);
  });

  it("detects a new scale transition after an older known split", () => {
    const rows = weeklyHistory(3).map((row) => ({
      ...row,
      raw_close: 120,
      raw_open: 119,
      raw_high: 122,
      raw_low: 118,
      split_adjusted_close: 120,
    }));
    expect(hasUnexpectedQuoteScaleMismatch(
      {
        price: 12,
        previous_close: 120,
        provider_timestamp: "2026-08-21T14:59:00.000Z",
        quote_session_date: "2026-08-21",
        previous_close_session_date: "2026-08-20",
        daily_change_valid: 1,
      },
      rows,
      [{ effective_date: "2024-06-10", split_factor: 10 }],
    )).toBe(true);
  });

  it("does not disable normal scale checks just because an older split is known", () => {
    expect(hasUnexpectedQuoteScaleMismatch(
      {
        price: 500,
        previous_close: 495,
        provider_timestamp: "2026-08-21T14:59:00.000Z",
        quote_session_date: "2026-08-21",
        previous_close_session_date: "2026-08-20",
        daily_change_valid: 1,
      },
      weeklyHistory(3),
      [{ effective_date: "2024-06-10", split_factor: 10 }],
    )).toBe(false);
  });

  it("honors authoritative BLOCKED even when effective split events are present", () => {
    const history = applySplitToHistory(weeklyHistory(459), "2026-08-10", 2);
    expect(servedSplitScaleState(
      { price: 250, provider_timestamp: "2026-08-21T14:59:00.000Z" },
      "2026-08-15T06:00:00.000Z",
      history,
      [{ effective_date: "2026-08-10", split_factor: 2 }],
      true,
      "BLOCKED",
    )).toBe("mismatch");
  });
});

describe("Stock Detail D1 read model", () => {
  it("expires only market-dependent fundamentals while retaining accounting cards", async () => {
    storageMock.readStockDetailStorageSnapshot.mockResolvedValue(baseSnapshot({
      fundamentals: {
        symbol: "MSFT",
        market_cap: 3_000_000_000_000,
        pe_ttm: 35.5,
        revenue_ttm: 250_000,
        operating_income_ttm: 100_000,
        pretax_income_ttm: 98_000,
        income_tax_ttm: 18_000,
        operating_cash_flow_ttm: 110_000,
        capex_ttm: 20_000,
        free_cash_flow_ttm: 90_000,
        cash: 50_000,
        short_term_investments: 10_000,
        total_debt: 40_000,
        shareholders_equity: 200_000,
        roic_pct: 27.5,
        fcf_margin_pct: 36,
        debt_to_equity: 0.2,
        accounting_periods_compatible: 1,
        accounting_as_of: "2026-08-17",
        market_as_of: "2026-08-17T15:00:00.000Z",
        market_checked_at: null,
        accounting_source: "edgartools",
        market_source: "finnhub",
        updated_at: "2026-08-17T15:01:00.000Z",
      },
    }));

    const detail = await readStockDetailApi(env, "MSFT", NOW);
    expect(detail.fundamentals).toEqual({
      marketCap: null,
      peTtm: null,
        roicPct: 45.3514739229025,
      fcfMarginPct: 36,
      debtToEquity: 0.2,
    });
  });

  it("serves the five fundamentals cards without provider calls", async () => {
    storageMock.readStockDetailStorageSnapshot.mockResolvedValue(baseSnapshot({
      fundamentals: {
        symbol: "MSFT",
        market_cap: 3_000_000_000_000,
        pe_ttm: 35.5,
        revenue_ttm: 250_000,
        operating_income_ttm: 100_000,
        pretax_income_ttm: 98_000,
        income_tax_ttm: 18_000,
        operating_cash_flow_ttm: 110_000,
        capex_ttm: 20_000,
        free_cash_flow_ttm: 90_000,
        cash: 50_000,
        short_term_investments: 10_000,
        total_debt: 40_000,
        shareholders_equity: 200_000,
        roic_pct: 27.5,
        fcf_margin_pct: 36,
        debt_to_equity: 0.2,
        accounting_periods_compatible: 1,
        accounting_as_of: "2026-06-30",
        market_as_of: "2026-08-21T15:00:00.000Z",
        market_checked_at: null,
        accounting_source: "edgartools",
        market_source: "finnhub",
        updated_at: "2026-08-21T15:01:00.000Z",
      },
    }));

    const detail = await readStockDetailApi(env, "MSFT", NOW);
    expect(detail.fundamentals).toEqual({
      marketCap: "$3.00T",
      peTtm: 35.5,
        roicPct: 45.3514739229025,
      fcfMarginPct: 36,
      debtToEquity: 0.2,
    });
  });

  it("fails closed when market metrics have no known as-of timestamp", async () => {
    storageMock.readStockDetailStorageSnapshot.mockResolvedValue(baseSnapshot({
      fundamentals: {
        symbol: "MSFT",
        market_cap: 3_000_000_000_000,
        pe_ttm: 35.5,
        revenue_ttm: 250_000,
        operating_income_ttm: 100_000,
        pretax_income_ttm: 98_000,
        income_tax_ttm: 18_000,
        operating_cash_flow_ttm: 110_000,
        capex_ttm: 20_000,
        free_cash_flow_ttm: 90_000,
        cash: 50_000,
        short_term_investments: 10_000,
        total_debt: 40_000,
        shareholders_equity: 200_000,
        roic_pct: 27.5,
        fcf_margin_pct: 36,
        debt_to_equity: 0.2,
        accounting_periods_compatible: 1,
        accounting_as_of: "2026-06-30",
        market_as_of: null,
        market_checked_at: null,
        accounting_source: "edgartools",
        market_source: "finnhub",
        updated_at: "2026-08-21T14:59:00.000Z",
      },
    }));

    const detail = await readStockDetailApi(env, "MSFT", NOW);
    expect(detail.fundamentals?.marketCap).toBeNull();
    expect(detail.fundamentals?.peTtm).toBeNull();
  });

  it("uses the direct Finnhub check timestamp when the legacy timestamp is absent", async () => {
    storageMock.readStockDetailStorageSnapshot.mockResolvedValue(baseSnapshot({
      fundamentals: {
        symbol: "MSFT",
        market_cap: 3_000_000_000_000,
        pe_ttm: 35.5,
        revenue_ttm: 250_000,
        operating_income_ttm: 100_000,
        pretax_income_ttm: 98_000,
        income_tax_ttm: 18_000,
        operating_cash_flow_ttm: 110_000,
        capex_ttm: 20_000,
        free_cash_flow_ttm: 90_000,
        cash: 50_000,
        short_term_investments: 10_000,
        total_debt: 40_000,
        shareholders_equity: 200_000,
        roic_pct: 27.5,
        fcf_margin_pct: 36,
        debt_to_equity: 0.2,
        accounting_periods_compatible: 1,
        accounting_as_of: "2026-06-30",
        market_as_of: null,
        market_checked_at: "2026-08-21T15:00:00.000Z",
        accounting_source: "edgartools",
        market_source: "finnhub",
        updated_at: "2026-08-21T15:01:00.000Z",
      },
    }));

    const detail = await readStockDetailApi(env, "MSFT", NOW);
    expect(detail.fundamentals?.marketCap).toBe("$3.00T");
    expect(detail.fundamentals?.peTtm).toBe(35.5);
  });

  it("composes company, quote, manual IV, supports, live SMA and weekly history", async () => {
    const detail = await readStockDetailApi(env, "MSFT", NOW);
    expect(detail.company).toEqual({
      name: "Microsoft Corporation",
      exchange: null,
      sector: null,
      logoUrl: "https://example.com/msft.png",
    });
    expect(detail.quote.price).toBe(500);
    expect(detail.quote.provider).toBe("finnhub");
    expect(detail.quote.state).toBe("Live");
    expect(detail.quote.scaleState).toBe("safe");
    expect(detail.valuation.intrinsicValue?.base).toBe(600);
    expect(detail.valuation.intrinsicValue?.upsidePct).toBeCloseTo(20, 10);
    expect(detail.technical.supports.map((support) => support.level)).toEqual([1, 2]);
    expect(detail.technical.supports.map((support) => support.triggered)).toEqual([false, true]);
    expect(detail.technical.sma200w).toBeCloseTo(400.5, 10);
  });

  it("uses 199 warm-up weeks but returns at most 260 visible candles and SMA points", async () => {
    const detail = await readStockDetailApi(env, "MSFT", NOW);
    expect(detail.chart.priceHistory).toHaveLength(260);
    expect(detail.chart.priceHistory[0]!.close).toBe(200);
    expect(detail.chart.priceHistory.at(-1)!.close).toBe(459);
    expect(detail.technical.sma200wHistory).toHaveLength(260);
    expect(detail.technical.sma200wHistory.at(-1)!.value).toBeCloseTo(359.5, 10);
  });

  it("LAST-KNOWN-GOOD: previously-valid SMA stays visible when the weekly anchor is stale", async () => {
    // Anchor is 2026-08-14 (W33, from the fixture metric), but the quote is now
    // 2026-08-28 (W35) — the weekly refresh LAGGED by one week (no W34 stored).
    // The previously-valid closed SMA (400) MUST keep being served — never
    // flipped to Unavailable/null because the latest week is missing.
    const STALE_NOW = new Date("2026-08-28T15:00:00.000Z");
    storageMock.readStockDetailStorageSnapshot.mockResolvedValue(baseSnapshot({
      quote: {
        ...baseSnapshot().quote!,
        price: 550,
        provider_timestamp: "2026-08-28T14:59:00.000Z",
        updated_at: "2026-08-28T14:59:05.000Z",
      },
      metric: metric(), // anchor_week 2026-08-14, closed_sma_200w 400
    }));
    const detail = await readStockDetailApi(env, "MSFT", STALE_NOW);
    // delta 2 (quote W35 vs anchor W33) -> last-known-good serves closed_sma.
    expect(detail.technical.sma200w).toBeCloseTo(400, 10);
    expect(detail.technical.sma200wState).not.toBe("Unavailable");
    expect(detail.technical.sma200wState).not.toBe("NotEnoughHistory");
    expect(detail.technical.sma200wHistoryWeeks).toBe(459);
  });

  it("omits the split-week candle once the split has been reconciled", async () => {
    const rows = applySplitToHistory(weeklyHistory(459), "2026-08-10", 2);
    storageMock.readStockDetailStorageSnapshot.mockResolvedValue(baseSnapshot({
      weeklyRows: [{ ...rows[0]!, raw_open: 450, raw_high: 475, raw_low: 220 }, ...rows.slice(1)],
      splitEvents: [{ effective_date: "2026-08-10", split_factor: 2 }],
      quote: { ...baseSnapshot().quote!, price: 250 },
      metric: metric({ calculated_at: "2026-08-15T06:00:00.000Z" }),
    }));
    const detail = await readStockDetailApi(env, "MSFT", NOW);
    expect(detail.quote.scaleState).toBe("safe");
    expect(detail.chart.priceHistory.some((point) => point.time === "2026-08-14")).toBe(false);
    expect(detail.technical.sma200wHistory.at(-1)?.time).toBe("2026-08-14");
  });

  it("never fabricates the current weekly candle or historical IV", async () => {
    const detail = await readStockDetailApi(env, "MSFT", NOW);
    expect(detail.chart.priceHistory.at(-1)!.time).toBe("2026-08-14");
    expect(detail.quote.price).toBe(500);
    expect(detail.chart.intrinsicValueHistory).toEqual([]);
  });

  it("returns partial data when IV or supports are absent", async () => {
    storageMock.readStockDetailStorageSnapshot.mockResolvedValue(baseSnapshot({ intrinsicValue: undefined, supports: undefined }));
    const detail = await readStockDetailApi(env, "MSFT", NOW);
    expect(detail.quote.price).toBe(500);
    expect(detail.valuation.intrinsicValue).toBeNull();
    expect(detail.technical.supports).toEqual([]);
  });

  it("keeps a Core stock usable with no weekly history when no split safety decision is required", async () => {
    storageMock.readStockDetailStorageSnapshot.mockResolvedValue(baseSnapshot({ weeklyRows: [] }));
    const detail = await readStockDetailApi(env, "MSFT", NOW);
    expect(detail.quote.price).toBe(500);
    expect(detail.chart.priceHistory).toEqual([]);
    expect(detail.technical.sma200wHistory).toEqual([]);
  });

  it("handles a CRCL-like short history without fabricating SMA200W", async () => {
    storageMock.readStockDetailStorageSnapshot.mockResolvedValue(baseSnapshot({
      company: { symbol: "CRCL", company: "Circle Internet Group, Inc.", logo_url: null },
      quote: {
        symbol: "CRCL", price: 130, change_abs: 1, change_pct: 0.8,
        day_high: null, day_low: null, day_open: null, previous_close: null,
        provider: "finnhub", provider_timestamp: "2026-08-21T14:59:00.000Z", updated_at: "2026-08-21T14:59:05.000Z",
      },
      metric: metric({
        symbol: "CRCL", completed_weeks_available: 100, sum_199: null,
        anchor_close: 100, closed_sma_200w: null, status: "not_enough_history",
      }),
      supports: undefined,
      intrinsicValue: undefined,
      weeklyRows: weeklyHistory(100, "CRCL"),
    }));
    const detail = await readStockDetailApi(env, "CRCL", NOW);
    expect(detail.chart.priceHistory).toHaveLength(100);
    expect(detail.technical.sma200w).toBeNull();
    expect(detail.technical.sma200wState).toBe("NotEnoughHistory");
    expect(detail.technical.sma200wHistory).toEqual([]);
  });

  it("hides manual supports and IV after an effective split until they are re-entered on the new scale", async () => {
    const history = applySplitToHistory(weeklyHistory(459), "2026-08-10", 2);
    storageMock.readStockDetailStorageSnapshot.mockResolvedValue(baseSnapshot({
      weeklyRows: history,
      splitEvents: [{ effective_date: "2026-08-10", split_factor: 2 }],
      quote: { ...baseSnapshot().quote!, price: 250 },
    }));
    const detail = await readStockDetailApi(env, "MSFT", NOW);
    expect(detail.technical.supports).toEqual([]);
    expect(detail.valuation.intrinsicValue).toBeNull();
  });

  it("does not let a future announced split affect today's serving scale", async () => {
    storageMock.readStockDetailStorageSnapshot.mockResolvedValue(baseSnapshot({
      splitEvents: [{ effective_date: "2026-09-01", split_factor: 3 }],
    }));
    const detail = await readStockDetailApi(env, "MSFT", NOW);
    expect(detail.quote.scaleState).toBe("safe");
    expect(detail.quote.price).toBe(500);
    expect(detail.technical.supports).toHaveLength(2);
    expect(detail.valuation.intrinsicValue?.base).toBe(600);
  });

  it("uses the latest effective split even when a later future split is stored", async () => {
    storageMock.readStockDetailStorageSnapshot.mockResolvedValue(baseSnapshot({
      weeklyRows: weeklyHistory(459),
      splitEvents: [
        { effective_date: "2026-08-10", split_factor: 2 },
        { effective_date: "2026-09-01", split_factor: 3 },
      ],
    }));
    const detail = await readStockDetailApi(env, "MSFT", NOW);
    expect(detail.quote.scaleState).toBe("mismatch");
    expect(detail.quote.price).toBeNull();
    expect(detail.technical.sma200w).toBeNull();
  });

  it("returns Not available data during a split reconciliation gap rather than mixing scales", async () => {
    const reconciledHistory = applySplitToHistory(weeklyHistory(459), "2026-08-10", 2);
    storageMock.readStockDetailStorageSnapshot.mockResolvedValue(baseSnapshot({
      weeklyRows: reconciledHistory,
      splitEvents: [{ effective_date: "2026-08-10", split_factor: 2 }],
      quote: { ...baseSnapshot().quote!, provider_timestamp: "2026-08-07T20:00:00.000Z" },
    }));
    const detail = await readStockDetailApi(env, "MSFT", NOW);
    expect(detail.quote.scaleState).toBe("mismatch");
    expect(detail.quote.price).toBeNull();
    expect(detail.quote.changeAbs).toBeNull();
    expect(detail.quote.changePct).toBeNull();
    expect(detail.technical.sma200w).toBeNull();
  });

  it("persists an automatic recovery request when an unannounced scale transition is evident", async () => {
    const rows = weeklyHistory(459).map((row) => ({
      ...row,
      raw_close: 1_200,
      raw_open: 1_190,
      raw_high: 1_220,
      raw_low: 1_180,
      split_adjusted_close: 1_200,
    }));
    storageMock.readStockDetailStorageSnapshot.mockResolvedValue(baseSnapshot({
      weeklyRows: rows,
      quote: {
        ...baseSnapshot().quote!,
        price: 120,
        previous_close: 1_200,
        quote_session_date: "2026-08-21",
        previous_close_session_date: "2026-08-20",
        daily_change_valid: 1,
      },
      splitEvents: [],
    }));
    const detail = await readStockDetailApi(env, "MSFT", NOW);
    expect(detail.quote.price).toBeNull();
    expect(detail.chart.priceHistory).toEqual([]);
    expect(detail.technical.sma200w).toBeNull();
    expect(storageMock.persistSplitScaleMismatch).toHaveBeenCalledWith(
      env.DB,
      "MSFT",
      "unexpected_scale_mismatch",
      NOW.toISOString(),
    );
  });

  it("blocks an explicit pending verification marker even with mathematically valid event rows", async () => {
    const history = applySplitToHistory(weeklyHistory(459), "2026-08-10", 2);
    storageMock.readStockDetailStorageSnapshot.mockResolvedValue(baseSnapshot({
      weeklyRows: history,
      splitEvents: [{ effective_date: "2026-08-10", split_factor: 2 }],
      splitHistoryVerified: false,
      splitHistoryStatus: "pending",
      quote: { ...baseSnapshot().quote!, price: 250 },
    }));
    const detail = await readStockDetailApi(env, "MSFT", NOW);
    expect(detail.quote.scaleState).toBe("mismatch");
    expect(detail.quote.price).toBeNull();
    expect(detail.chart.priceHistory).toEqual([]);
  });

  it("does not publish READY data while the authoritative serving state is BLOCKED", async () => {
    storageMock.readStockDetailStorageSnapshot.mockResolvedValue(baseSnapshot({
      servingState: { state: "BLOCKED", reason: "unexpected_scale_mismatch" },
      recoveryState: { status: "pending" },
    }));
    const detail = await readStockDetailApi(env, "MSFT", NOW);
    expect(detail.quote.price).toBeNull();
    expect(detail.quote.state).toBe("Unavailable");
    expect(detail.chart.priceHistory).toEqual([]);
    expect(detail.technical.sma200w).toBeNull();
    expect(storageMock.persistSplitScaleMismatch).not.toHaveBeenCalled();
  });

  it("clears a stale quote-only block after history and the refreshed quote align", async () => {
    const history = applySplitToHistory(weeklyHistory(459), "2026-08-10", 2);
    storageMock.clearQuoteHistoryScaleMismatch.mockResolvedValue(true);
    storageMock.readStockDetailStorageSnapshot.mockResolvedValue(baseSnapshot({
      weeklyRows: history,
      splitEvents: [{ effective_date: "2026-08-10", split_factor: 2 }],
      servingState: { state: "BLOCKED", reason: "quote_history_scale_mismatch" },
      recoveryState: { status: "retry" },
      quote: { ...baseSnapshot().quote!, price: 250 },
    }));

    const detail = await readStockDetailApi(env, "MSFT", NOW);

    expect(storageMock.clearQuoteHistoryScaleMismatch).toHaveBeenCalledWith(
      env.DB,
      "MSFT",
      NOW.toISOString(),
    );
    expect(detail.quote.scaleState).toBe("safe");
    expect(detail.quote.price).toBe(250);
    expect(detail.chart.priceHistory.length).toBeGreaterThan(0);
  });

  it("does not clear a quote-only block while recovery is running", async () => {
    const history = applySplitToHistory(weeklyHistory(459), "2026-08-10", 2);
    storageMock.readStockDetailStorageSnapshot.mockResolvedValue(baseSnapshot({
      weeklyRows: history,
      splitEvents: [{ effective_date: "2026-08-10", split_factor: 2 }],
      servingState: { state: "BLOCKED", reason: "quote_history_scale_mismatch" },
      recoveryState: { status: "running" },
      quote: { ...baseSnapshot().quote!, price: 250 },
    }));

    const detail = await readStockDetailApi(env, "MSFT", NOW);

    expect(storageMock.clearQuoteHistoryScaleMismatch).not.toHaveBeenCalled();
    expect(detail.quote.scaleState).toBe("mismatch");
    expect(detail.quote.price).toBeNull();
  });

  it("treats READY as authoritative when workflow cleanup is stale", async () => {
    storageMock.readStockDetailStorageSnapshot.mockResolvedValue(baseSnapshot({
      splitHistoryStatus: "error",
      servingState: { state: "READY", reason: "split_history_verified" },
    }));
    const detail = await readStockDetailApi(env, "MSFT", NOW);
    expect(detail.quote.scaleState).toBe("safe");
    expect(detail.quote.price).toBe(500);
    expect(detail.technical.supports).toHaveLength(2);
    expect(detail.valuation.intrinsicValue?.base).toBe(600);
  });

  it("hides all price-scale-derived values during a split mismatch", async () => {
    const rows = weeklyHistory(459).map((row) => ({
      ...row,
      raw_close: 1_200,
      raw_open: 1_190,
      raw_high: 1_220,
      raw_low: 1_180,
      split_adjusted_close: 1_200,
    }));
    storageMock.readStockDetailStorageSnapshot.mockResolvedValue(baseSnapshot({
      weeklyRows: rows,
      splitEvents: [],
      quote: {
        ...baseSnapshot().quote!,
        price: 120,
        previous_close: 1_200,
        quote_session_date: "2026-08-21",
        previous_close_session_date: "2026-08-20",
        daily_change_valid: 1,
      },
    }));
    const detail = await readStockDetailApi(env, "MSFT", NOW);
    expect(detail.quote.scaleState).toBe("mismatch");
    expect(detail.technical.supports).toEqual([]);
    expect(detail.valuation.intrinsicValue).toBeNull();
    expect(detail.valuation.automatic).toBeNull();
  });

  it("hides market-cap and P/E values while the quote scale is blocked", async () => {
    storageMock.readStockDetailStorageSnapshot.mockResolvedValue(baseSnapshot({
      servingState: { state: "BLOCKED", reason: "unexpected_scale_mismatch" },
      recoveryState: { status: "pending" },
      fundamentals: accountingFundamentals({
        market_cap: 1_000_000,
        pe_ttm: 25,
        market_checked_at: "2026-08-21T14:59:00.000Z",
      }),
    }));
    const detail = await readStockDetailApi(env, "MSFT", NOW);
    expect(detail.fundamentals.marketCap).toBeNull();
    expect(detail.fundamentals.peTtm).toBeNull();
    expect(detail.fundamentals.roicPct).toBeCloseTo(45.3514739229025, 10);
  });

  it("degrades quote and current SMA honestly when the quote row is absent", async () => {
    storageMock.readStockDetailStorageSnapshot.mockResolvedValue(baseSnapshot({ quote: null }));
    const detail = await readStockDetailApi(env, "MSFT", NOW);
    expect(detail.quote.price).toBeNull();
    expect(detail.quote.state).toBe("Unavailable");
    expect(detail.technical.sma200w).toBeNull();
    expect(detail.technical.supports.every((support) => support.triggered === null)).toBe(true);
    expect(detail.valuation.intrinsicValue?.upsidePct).toBeNull();
  });

  it("performs one batched symbol-scoped storage read", async () => {
    await readStockDetailApi(env, "MSFT", NOW);
    expect(storageMock.readStockDetailStorageSnapshot).toHaveBeenCalledTimes(1);
    expect(storageMock.readStockDetailStorageSnapshot).toHaveBeenCalledWith(env.DB, "MSFT");
  });
});

describe("Stock Detail accounting card calculations", () => {
  it("calculates all three cards from persisted inputs, not legacy derived columns", () => {
    expect(calculateAccountingCardMetrics(accountingFundamentals())).toEqual({
      roicPct: 45.3514739229025,
      fcfMarginPct: 36,
      debtToEquity: 0.2,
    });
  });

  it("fails closed for missing inputs and invalid denominators", () => {
    expect(calculateAccountingCardMetrics(accountingFundamentals({
      revenue_ttm: 0,
      pretax_income_ttm: 0,
      shareholders_equity: 0,
      cash: null,
    }))).toEqual({
      roicPct: null,
      fcfMarginPct: null,
      debtToEquity: null,
    });
  });

  it("fails closed for ROIC when the income and balance periods do not align", () => {
    expect(calculateAccountingCardMetrics(accountingFundamentals({
      accounting_periods_compatible: 0,
    }))).toMatchObject({
      roicPct: null,
      fcfMarginPct: 36,
      debtToEquity: 0.2,
    });
  });
});
