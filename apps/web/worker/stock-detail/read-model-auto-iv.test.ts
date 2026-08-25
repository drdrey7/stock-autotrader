import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../index";
import type { StockDetailStorageSnapshot } from "./storage";

const storageMock = vi.hoisted(() => ({
  readStockDetailStorageSnapshot: vi.fn(),
}));

vi.mock("./storage", () => ({
  ...storageMock,
  STOCK_DETAIL_VISIBLE_WEEKS: 260,
  STOCK_DETAIL_SMA_WARMUP_WEEKS: 199,
  STOCK_DETAIL_HISTORY_LIMIT: 459,
}));

import { readStockDetailApi } from "./read-model";

const NOW = new Date("2026-08-13T14:00:00.000Z");
const NOW_ISO = NOW.toISOString();
const env = { DB: {} as D1Database } as Env;
const ADBE_EPS_TTM = 276.24 / 15.137946495292185;

function snapshot(manualBase: number | null, price = 276.24): StockDetailStorageSnapshot {
  return {
    company: {
      symbol: "ADBE",
      company: "Adobe Inc.",
      logo_url: null,
      exchange: "NASDAQ",
      industry: "Technology",
    },
    quote: {
      symbol: "ADBE",
      price,
      change_abs: 22.25,
      change_pct: 8.74,
      day_high: 280,
      day_low: 260,
      day_open: 265,
      previous_close: 253.99,
      provider: "finnhub-quote",
      provider_timestamp: NOW_ISO,
      updated_at: NOW_ISO,
    },
    metric: null,
    supports: undefined,
    intrinsicValue: manualBase === null
      ? undefined
      : {
          symbol: "ADBE",
          values: {
            symbol: "ADBE",
            method: "manual",
            low_value: null,
            base_value: manualBase,
            high_value: null,
            as_of_date: "2026-08-01",
          },
        },
    fundamentals: {
      symbol: "ADBE",
      market_cap: 119_000_000_000,
      pe_ttm: 15.137946495292185,
      eps_ttm: ADBE_EPS_TTM,
      shares_outstanding: 420_000_000,
      revenue_ttm: null,
      operating_income_ttm: null,
      pretax_income_ttm: null,
      income_tax_ttm: null,
      operating_cash_flow_ttm: null,
      capex_ttm: null,
      free_cash_flow_ttm: null,
      cash: null,
      short_term_investments: null,
      total_debt: null,
      shareholders_equity: 14_000_000_000,
      roic_pct: null,
      fcf_margin_pct: null,
      debt_to_equity: null,
      accounting_periods_compatible: null,
      accounting_as_of: null,
      market_as_of: null,
      market_checked_at: NOW_ISO,
      accounting_source: "edgartools",
      market_source: "finnhub-basic-financials",
      updated_at: NOW_ISO,
    },
    weeklyRows: [],
    splitEvents: [],
  };
}

beforeEach(() => vi.clearAllMocks());

describe("Stock Detail canonical intrinsic-value selection", () => {
  it("uses Automatic Base when Adobe has no Manual IV", async () => {
    storageMock.readStockDetailStorageSnapshot.mockResolvedValue(snapshot(null));

    const detail = await readStockDetailApi(env, "ADBE", NOW);

    expect(detail.valuation.intrinsicValue).toBeNull();
    expect(detail.valuation.automatic).toMatchObject({
      bear: 401.46,
      base: 456.21,
      bull: 510.95,
      method: "P/E",
      bearMultiple: 22,
      baseMultiple: 25,
      bullMultiple: 28,
    });
    expect(detail.valuation.selectedIntrinsicValue).toMatchObject({
      low: 401.46,
      base: 456.21,
      high: 510.95,
      method: "automatic-p-e",
      asOf: "2026-08-13",
    });
  });

  it("keeps automatic IV stable when only the live Adobe quote moves", async () => {
    storageMock.readStockDetailStorageSnapshot.mockResolvedValueOnce(snapshot(null, 276.24));
    const first = await readStockDetailApi(env, "ADBE", NOW);
    storageMock.readStockDetailStorageSnapshot.mockResolvedValueOnce(snapshot(null, 270.52));
    const second = await readStockDetailApi(env, "ADBE", NOW);

    expect(second.valuation.automatic?.base).toBe(first.valuation.automatic?.base);
    expect(second.valuation.automatic?.base).toBe(456.21);
    expect(second.valuation.automatic?.baseUpsidePct).not.toBe(first.valuation.automatic?.baseUpsidePct);
  });

  it("keeps Manual selected while still exposing Automatic scenarios", async () => {
    storageMock.readStockDetailStorageSnapshot.mockResolvedValue(snapshot(333.33));

    const detail = await readStockDetailApi(env, "ADBE", NOW);

    expect(detail.valuation.intrinsicValue).toMatchObject({
      base: 333.33,
      method: "manual",
    });
    expect(detail.valuation.automatic?.base).toBe(456.21);
    expect(detail.valuation.selectedIntrinsicValue).toMatchObject({
      base: 333.33,
      method: "manual",
    });
  });
});
