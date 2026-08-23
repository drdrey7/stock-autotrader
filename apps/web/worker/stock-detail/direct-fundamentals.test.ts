import { describe, expect, it } from "vitest";
import { calculateAccountingCardMetrics } from "./read-model";
import type { StockDetailStorageSnapshot } from "./storage";

function directFundamentals(
  overrides: Record<string, unknown> = {},
): NonNullable<StockDetailStorageSnapshot["fundamentals"]> {
  return {
    symbol: "MSFT",
    market_cap: 3_000_000_000_000,
    pe_ttm: 35.5,
    revenue_ttm: 1,
    operating_income_ttm: 1,
    pretax_income_ttm: 1,
    income_tax_ttm: 0,
    operating_cash_flow_ttm: 1,
    capex_ttm: 0,
    free_cash_flow_ttm: 1,
    cash: 0,
    short_term_investments: 0,
    total_debt: 9,
    shareholders_equity: 1,
    roic_pct: 27.5,
    fcf_margin_pct: 36,
    debt_to_equity: 0.2,
    accounting_periods_compatible: 1,
    accounting_as_of: null,
    market_as_of: null,
    market_checked_at: "2026-08-23T12:00:00Z",
    accounting_source: "edgartools",
    market_source: "finnhub-basic-financials",
    updated_at: "2026-08-23T12:00:01Z",
    ...overrides,
  };
}

describe("direct Finnhub Stock Detail fundamentals", () => {
  it("uses provider ratios directly instead of reconstructing them from legacy accounting fields", () => {
    expect(calculateAccountingCardMetrics(directFundamentals())).toEqual({
      roicPct: 27.5,
      fcfMarginPct: 36,
      debtToEquity: 0.2,
    });
  });

  it("keeps legitimately missing direct metrics null", () => {
    expect(calculateAccountingCardMetrics(directFundamentals({
      roic_pct: null,
      fcf_margin_pct: null,
      debt_to_equity: null,
    }))).toEqual({
      roicPct: null,
      fcfMarginPct: null,
      debtToEquity: null,
    });
  });
});
