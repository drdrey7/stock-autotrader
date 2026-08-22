import { describe, expect, it } from "vitest";
import {
  stockDetailApiResponseSchema,
  type StockDetailApiResponse,
} from "@stock-autotrader/contracts";

function completeResponse(): StockDetailApiResponse {
  return {
    schemaVersion: 1,
    generatedAt: "2026-08-21T14:30:00.000Z",
    symbol: "MSFT",
    company: {
      name: "Microsoft Corporation",
      exchange: null,
      sector: null,
      logoUrl: "https://example.com/msft.png",
    },
    quote: {
      price: 500,
      changeAbs: 5,
      changePct: 1,
      provider: "finnhub",
      asOf: "2026-08-21T14:29:00.000Z",
      updatedAt: "2026-08-21T14:29:05.000Z",
      state: "Live",
      marketState: "regular",
      scaleState: "safe",
    },
    valuation: {
      intrinsicValue: {
        low: 550,
        base: 600,
        high: 650,
        method: "manual",
        asOf: "2026-08-03",
        upsidePct: 20,
      },
    },
    fundamentals: {
      marketCap: null,
      peTtm: null,
      roicPct: null,
      fcfMarginPct: null,
      debtToEquity: null,
    },
    technical: {
      sma200w: 430,
      distanceToSma200wPct: 16.279,
      sma200wState: "Above",
      sma200wHistoryWeeks: 459,
      sma200wAsOf: "2026-08-14T00:00:00.000Z",
      supports: [{
        level: 1,
        price: 450,
        method: "manual",
        asOf: "2026-08-03",
        triggered: false,
      }],
      sma200wHistory: [{ time: "2026-08-14", value: 430 }],
    },
    chart: {
      interval: "1w",
      priceHistory: [{
        time: "2026-08-14",
        open: 490,
        high: 505,
        low: 485,
        close: 500,
        volume: 1000,
      }],
      intrinsicValueHistory: [],
    },
    freshness: {
      quoteAsOf: "2026-08-21T14:29:00.000Z",
      historyAsOf: "2026-08-21T06:00:00.000Z",
      valuationAsOf: "2026-08-03",
      technicalAsOf: "2026-08-21T06:00:00.000Z",
    },
  };
}

describe("stockDetailApiResponseSchema", () => {
  it("accepts a complete response and preserves Stock Detail upside semantics", () => {
    const parsed = stockDetailApiResponseSchema.parse(completeResponse());
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.quote.scaleState).toBe("safe");
    expect(parsed.valuation.intrinsicValue?.upsidePct).toBe(20);
  });

  it("accepts a partial Core Universe response with absent optional data", () => {
    const value = completeResponse();
    value.company.name = null;
    value.company.logoUrl = null;
    value.quote.price = null;
    value.quote.changeAbs = null;
    value.quote.changePct = null;
    value.quote.provider = null;
    value.quote.asOf = null;
    value.quote.updatedAt = null;
    value.quote.state = "Unavailable";
    value.quote.scaleState = "unknown";
    value.valuation.intrinsicValue = null;
    value.technical.sma200w = null;
    value.technical.distanceToSma200wPct = null;
    value.technical.sma200wState = "Unavailable";
    value.technical.sma200wHistoryWeeks = null;
    value.technical.sma200wAsOf = null;
    value.technical.supports = [];
    value.technical.sma200wHistory = [];
    value.chart.priceHistory = [];
    value.freshness.quoteAsOf = null;
    value.freshness.historyAsOf = null;
    value.freshness.valuationAsOf = null;
    value.freshness.technicalAsOf = null;
    expect(stockDetailApiResponseSchema.safeParse(value).success).toBe(true);
  });

  it.each([
    ["lowercase symbol", (value: StockDetailApiResponse) => { value.symbol = "msft"; }],
    ["negative quote", (value: StockDetailApiResponse) => { value.quote.price = -1; }],
    ["malformed generatedAt", (value: StockDetailApiResponse) => { value.generatedAt = "today"; }],
    ["bad support level", (value: StockDetailApiResponse) => { value.technical.supports[0]!.level = 5 as 1; }],
    ["bad interval", (value: StockDetailApiResponse) => { value.chart.interval = "1d" as "1w"; }],
    ["bad schema version", (value: StockDetailApiResponse) => { value.schemaVersion = 2 as 1; }],
    ["bad scale state", (value: StockDetailApiResponse) => { value.quote.scaleState = "bad" as "safe"; }],
  ])("rejects %s", (_label, mutate) => {
    const value = completeResponse();
    mutate(value);
    expect(stockDetailApiResponseSchema.safeParse(value).success).toBe(false);
  });
});
