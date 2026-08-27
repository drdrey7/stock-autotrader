import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StockDetailApiResponse } from "@stock-autotrader/contracts";
import pageSource from "./StockDetailPage.tsx?raw";

const apiClientMock = vi.hoisted(() => ({ requestJson: vi.fn() }));
vi.mock("../api-client", () => ({ requestJson: apiClientMock.requestJson }));

import { ApiStockDetailDataSource } from "./stock-detail.api";

function responseBody(): StockDetailApiResponse {
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
      provider: "finnhub-websocket",
      asOf: "2026-08-21T14:29:00.000Z",
      updatedAt: "2026-08-21T14:29:05.000Z",
      state: "Live",
      marketState: "regular",
      scaleState: "safe",
    },
    valuation: {
      intrinsicValue: {
        low: null,
        base: 600,
        high: null,
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
      supports: [{ level: 1, price: 450, method: "manual", asOf: "2026-08-03", triggered: false }],
      sma200wHistory: [{ time: "2026-08-14", value: 430 }],
    },
    chart: {
      interval: "1w",
      priceHistory: [{ time: "2026-08-14", open: 490, high: 505, low: 485, close: 500, volume: 1000 }],
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

beforeEach(() => vi.clearAllMocks());

describe("ApiStockDetailDataSource", () => {
  it("maps a valid WebSocket-backed response into the UI model", async () => {
    apiClientMock.requestJson.mockResolvedValue({ ok: true, status: 200, body: responseBody() });
    const detail = await new ApiStockDetailDataSource().getStockDetail("MSFT");
    expect(detail?.quote.price).toBe(500);
    expect(detail?.quote.change).toBe(5);
    expect(detail?.quote.changePct).toBe(1);
    expect(detail?.quote.state).toBe("Live");
    expect(detail?.quote.scaleState).toBe("safe");
    expect(detail?.logoUrl).toBe("https://example.com/msft.png");
    expect(detail?.valuation.intrinsicValue).toBe(600);
    expect(detail?.valuation.methods.manual).toBe(600);
    expect(detail?.valuation.methods.dcf).toBeNull();
    expect(detail?.metrics.marketCap).toBeNull();
    expect(detail?.technical.supports).toHaveLength(1);
  });

  it("keeps the last known price but suppresses 1D change while the market is closed", async () => {
    const body = responseBody();
    body.quote.marketState = "closed";
    body.quote.state = "Cached";
    apiClientMock.requestJson.mockResolvedValue({ ok: true, status: 200, body });

    const detail = await new ApiStockDetailDataSource().getStockDetail("MSFT");

    expect(detail?.quote.price).toBe(500);
    expect(detail?.quote.change).toBeNull();
    expect(detail?.quote.changePct).toBeNull();
    expect(detail?.quote.marketState).toBe("closed");
  });

  it("shows validated WebSocket 1D change during the regular session", async () => {
    const body = responseBody();
    apiClientMock.requestJson.mockResolvedValue({ ok: true, status: 200, body });

    const detail = await new ApiStockDetailDataSource().getStockDetail("MSFT");

    expect(detail?.quote.price).toBe(500);
    expect(detail?.quote.change).toBe(5);
    expect(detail?.quote.changePct).toBe(1);
    expect(detail?.quote.marketState).toBe("open");
  });

  it("suppresses 1D change for a non-live regular-session quote", async () => {
    const body = responseBody();
    body.quote.state = "Cached";
    apiClientMock.requestJson.mockResolvedValue({ ok: true, status: 200, body });

    const detail = await new ApiStockDetailDataSource().getStockDetail("MSFT");

    expect(detail?.quote.price).toBe(500);
    expect(detail?.quote.change).toBeNull();
    expect(detail?.quote.changePct).toBeNull();
  });

  it("suppresses 1D change when the Worker marks either derived value unavailable", async () => {
    const body = responseBody();
    body.quote.changePct = null;
    apiClientMock.requestJson.mockResolvedValue({ ok: true, status: 200, body });

    const detail = await new ApiStockDetailDataSource().getStockDetail("MSFT");

    expect(detail?.quote.price).toBe(500);
    expect(detail?.quote.change).toBeNull();
    expect(detail?.quote.changePct).toBeNull();
  });

  it("normalizes lowercase symbols and uses the central api client", async () => {
    apiClientMock.requestJson.mockResolvedValue({ ok: true, status: 200, body: responseBody() });
    await new ApiStockDetailDataSource().getStockDetail(" msft ");
    expect(apiClientMock.requestJson).toHaveBeenCalledWith("/api/stocks/MSFT/detail");
  });

  it("maps 404 to not found", async () => {
    apiClientMock.requestJson.mockResolvedValue({ ok: false, status: 404, body: { error: "stock_not_found" } });
    await expect(new ApiStockDetailDataSource().getStockDetail("INVALID")).resolves.toBeNull();
  });

  it("throws on server failures instead of falling back to mock data", async () => {
    apiClientMock.requestJson.mockResolvedValue({ ok: false, status: 503, body: { error: "stock_detail_store_unavailable" } });
    await expect(new ApiStockDetailDataSource().getStockDetail("MSFT")).rejects.toThrow("stock_detail_http_503");
  });

  it("throws when a 200 response violates the shared contract", async () => {
    apiClientMock.requestJson.mockResolvedValue({ ok: true, status: 200, body: { schemaVersion: 1, symbol: "MSFT" } });
    await expect(new ApiStockDetailDataSource().getStockDetail("MSFT")).rejects.toThrow("stock_detail_invalid_response");
  });

  it("keeps mock data out of the production StockDetailPage dependency graph", () => {
    expect(pageSource).toContain('from "./stock-detail.api"');
    expect(pageSource).toContain("apiStockDetailDataSource");
    expect(pageSource).not.toContain("stock-detail.mock");
    expect(pageSource).not.toContain("mockStockDetailDataSource");
  });
});
