import {
  stockDetailApiResponseSchema,
  type StockDetailApiResponse,
} from "@stock-autotrader/contracts";
import { requestJson } from "../api-client";
import type { StockDetail, StockDetailDataSource } from "./stock-detail.types";

function canShowDailyChange(api: StockDetailApiResponse): boolean {
  return api.quote.marketState === "regular"
    && api.quote.state === "Live"
    && api.quote.scaleState === "safe"
    && api.quote.changeAbs !== null
    && api.quote.changePct !== null;
}

function toUiModel(api: StockDetailApiResponse): StockDetail {
  const manual = api.valuation.intrinsicValue;
  const automatic = api.valuation.automatic ?? null;
  // Rolling-deploy compatibility: an older production Worker only exposes the
  // manual `intrinsicValue` field. The browser never calculates valuation.
  const selected = api.valuation.selectedIntrinsicValue ?? manual;
  const showDailyChange = canShowDailyChange(api);

  return {
    source: "api",
    symbol: api.symbol,
    companyName: api.company.name ?? api.symbol,
    exchange: api.company.exchange,
    sector: api.company.sector,
    logoUrl: api.company.logoUrl,
    quote: {
      price: api.quote.price,
      change: showDailyChange ? api.quote.changeAbs : null,
      changePct: showDailyChange ? api.quote.changePct : null,
      state: api.quote.state,
      scaleState: api.quote.scaleState,
      marketState: api.quote.marketState === "regular" ? "open" : "closed",
      asOf: api.quote.asOf,
    },
    valuation: {
      intrinsicValue: selected?.base ?? null,
      upsidePct: selected?.upsidePct ?? null,
      automatic: automatic
        ? {
            bear: automatic.bear,
            base: automatic.base,
            bull: automatic.bull,
            method: automatic.method,
            methods: automatic.methods,
            confidence: automatic.confidence,
            asOf: automatic.asOf,
          }
        : null,
      scenarios: {
        bear: automatic?.bear ?? null,
        base: automatic?.base ?? null,
        bull: automatic?.bull ?? null,
      },
      methods: {
        dcf: null,
        multiples: automatic?.base ?? null,
        manual: manual?.base ?? null,
        selected: selected?.base ?? null,
        selectedMethod: selected?.method ?? null,
      },
    },
    technical: {
      sma200w: api.technical.sma200w,
      smaDistancePct: api.technical.distanceToSma200wPct,
      sma200wHistory: api.technical.sma200wHistory,
      supports: api.technical.supports.map((support) => ({
        level: support.level,
        price: support.price,
        method: support.method,
        asOf: support.asOf,
        triggered: support.triggered,
      })),
    },
    metrics: api.fundamentals,
    chart: {
      priceHistory: api.chart.priceHistory,
      intrinsicValueHistory: api.chart.intrinsicValueHistory,
    },
  };
}

export class ApiStockDetailDataSource implements StockDetailDataSource {
  async getStockDetail(rawSymbol: string): Promise<StockDetail | null> {
    const symbol = rawSymbol.trim().toUpperCase();
    const response = await requestJson(`/api/stocks/${encodeURIComponent(symbol)}/detail`);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`stock_detail_http_${response.status}`);

    const parsed = stockDetailApiResponseSchema.safeParse(response.body);
    if (!parsed.success) throw new Error("stock_detail_invalid_response");
    return toUiModel(parsed.data);
  }
}

export const apiStockDetailDataSource = new ApiStockDetailDataSource();
