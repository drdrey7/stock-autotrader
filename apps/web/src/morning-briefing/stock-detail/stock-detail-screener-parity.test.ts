import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScreenerApiResponse, StockDetailApiResponse } from "@stock-autotrader/contracts";

const apiClientMock = vi.hoisted(() => ({ requestJson: vi.fn() }));
vi.mock("../api-client", () => ({ requestJson: apiClientMock.requestJson }));

import { ApiStockDetailDataSource } from "./stock-detail.api";

const detailBody: StockDetailApiResponse = {
  schemaVersion: 1,
  generatedAt: "2026-08-22T18:00:00.000Z",
  symbol: "ADBE",
  company: {
    name: "Adobe Inc.",
    exchange: "NASDAQ",
    sector: "Technology",
    logoUrl: "https://example.com/adbe.png",
  },
  quote: {
    price: null,
    changeAbs: null,
    changePct: null,
    provider: "finnhub-websocket",
    asOf: "2026-08-21T20:00:00.000Z",
    updatedAt: "2026-08-21T20:00:05.000Z",
    state: "Unavailable",
    marketState: "closed",
    scaleState: "mismatch",
  },
  valuation: { intrinsicValue: null },
  technical: {
    sma200w: null,
    distanceToSma200wPct: null,
    sma200wState: "Unavailable",
    sma200wHistoryWeeks: null,
    sma200wAsOf: null,
    supports: [],
    sma200wHistory: [{ time: "2026-08-14", value: 410 }],
  },
  chart: {
    interval: "1w",
    priceHistory: [{ time: "2026-08-14", open: 340, high: 350, low: 335, close: 345, volume: 1_000 }],
    intrinsicValueHistory: [],
  },
  freshness: {
    quoteAsOf: "2026-08-21T20:00:00.000Z",
    historyAsOf: "2026-08-22T06:00:00.000Z",
    valuationAsOf: null,
    technicalAsOf: null,
  },
};

const screenerBody: ScreenerApiResponse = {
  universe: { version: 1, total: 50 },
  marketState: "closed",
  quotes: {
    state: "Cached",
    provider: "finnhub-websocket",
    lastSuccessAt: "2026-08-21T20:00:05.000Z",
    lastAttemptAt: "2026-08-21T20:00:05.000Z",
    error: null,
    counts: { total: 50, live: 0, cached: 50, stale: 0, unavailable: 0 },
  },
  rows: [{
    symbol: "ADBE",
    company: "Adobe Inc.",
    price: 345.67,
    changeAbs: -4.12,
    changePct: -1.18,
    dayHigh: 352,
    dayLow: 342,
    dayOpen: 350,
    previousClose: 349.79,
    provider: "finnhub-websocket",
    asOf: "2026-08-21T20:00:00.000Z",
    updatedAt: "2026-08-21T20:00:05.000Z",
    state: "Cached",
    sma200w: 410,
    distanceToSma200wPct: -15.69,
    sma200wState: "Below",
    sma200wHistoryWeeks: 459,
    sma200wAsOf: "2026-08-22T06:00:00.000Z",
    supportLevels: [{ level: 1, price: 330, method: "manual", asOf: "2026-08-01", triggered: false }],
    intrinsicValue: {
      low: 360,
      base: 400,
      high: 440,
      method: "manual",
      asOf: "2026-08-01",
      distancePct: 15.72,
    },
    logoUrl: "https://example.com/adbe.png",
  }],
  asOf: "2026-08-21T20:00:05.000Z",
};

beforeEach(() => vi.clearAllMocks());

describe("Stock Detail screener parity", () => {
  it("uses the Screener row for shared values while keeping detail-only chart data", async () => {
    apiClientMock.requestJson.mockImplementation(async (path: string) => {
      if (path === "/api/screener") return { ok: true, status: 200, body: screenerBody };
      return { ok: true, status: 200, body: detailBody };
    });

    const detail = await new ApiStockDetailDataSource().getStockDetail("adbe");

    expect(detail?.quote.price).toBe(345.67);
    expect(detail?.quote.state).toBe("Cached");
    expect(detail?.valuation.intrinsicValue).toBe(400);
    expect(detail?.technical.sma200w).toBe(410);
    expect(detail?.technical.supports).toEqual([
      { level: 1, price: 330, method: "manual", asOf: "2026-08-01", triggered: false },
    ]);
    expect(detail?.chart.priceHistory).toEqual(detailBody.chart.priceHistory);
    expect(detail?.quote.scaleState).toBe("mismatch");
    expect(apiClientMock.requestJson).toHaveBeenCalledWith("/api/screener");
    expect(apiClientMock.requestJson).toHaveBeenCalledWith("/api/stocks/ADBE/detail");
  });
});
