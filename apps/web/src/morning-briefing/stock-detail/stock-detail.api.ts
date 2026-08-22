import {
  stockDetailApiResponseSchema,
  type StockDetailApiResponse,
} from "@stock-autotrader/contracts";
import { requestJson } from "../api-client";
import type { StockDetail, StockDetailDataSource } from "./stock-detail.types";

/**
 * Daily change is only presentation-safe when the regular session is active
 * and the quote source owns a trustworthy prior-close baseline.
 *
 * The production WebSocket collector currently preserves `previous_close`
 * across sessions, so its persisted change fields can become stale from the
 * second trading day onward. Issue #83 owns that collector/session rollover.
 * Until then Stock Detail fails closed (`—`) for WebSocket daily change while
 * preserving the latest usable price.
 *
 * `finnhub-quote` is the existing REST quote adapter: its c/d/dp/pc values are
 * returned together by one provider response, so a Live regular-session row
 * from that source can safely expose the daily move.
 */
function canShowDailyChange(api: StockDetailApiResponse): boolean {
  return api.quote.marketState === "regular"
    && api.quote.state === "Live"
    && api.quote.scaleState === "safe"
    && api.quote.provider === "finnhub-quote";
}

function formatMarketCap(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) return null;
  if (value >= 1e12) return `$${(value / 1e12).toFixed(1)}T`;
  if (value >= 1e9) return `$${(value / 1e9).toFixed(1)}B`;
  if (value >= 1e6) return `$${(value / 1e6).toFixed(1)}M`;
  return `$${value.toLocaleString("en-US")}`;
}

export function toUiModel(api: StockDetailApiResponse): StockDetail {
  const iv = api.valuation.intrinsicValue;
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
      intrinsicValue: iv?.base ?? null,
      upsidePct: iv?.upsidePct ?? null,
      scenarios: {
        bear: iv?.low ?? null,
        base: iv?.base ?? null,
        bull: iv?.high ?? null,
      },
      methods: {
        dcf: null,
        multiples: null,
        manual: iv?.base ?? null,
        selected: iv?.base ?? null,
        selectedMethod: iv?.method ?? null,
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
    metrics: {
      marketCap: formatMarketCap(api.fundamentals.marketCap),
      peTtm: api.fundamentals.peTtm,
      roicPct: api.fundamentals.roicPct,
      fcfMarginPct: api.fundamentals.fcfMarginPct,
      debtToEquity: api.fundamentals.debtToEquity,
      fundamentalsAsOf: api.fundamentals.asOf,
    },
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
