import {
  calculateAutomaticIntrinsicValue,
  stockDetailApiResponseSchema,
  type StockDetailApiResponse,
  type StockDetailAutomaticIntrinsicValue,
  type StockDetailIntrinsicValue,
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

/**
 * Rolling-deploy compatibility only. Once every production Worker serves the
 * new `valuation.automatic` field, the browser consumes the Worker result and
 * never owns valuation policy. This fallback keeps old-main previews usable
 * while the PR is still unmerged.
 */
function compatibilityAutomaticValuation(api: StockDetailApiResponse): StockDetailAutomaticIntrinsicValue | null {
  if (api.valuation.automatic !== undefined) return api.valuation.automatic;
  const calculated = calculateAutomaticIntrinsicValue(api.symbol, api.company.sector, {
    price: api.quote.price,
    peTtm: api.fundamentals.peTtm,
    priceToBook: api.fundamentals.priceToBook ?? null,
  });
  if (!calculated) return null;
  return {
    bear: calculated.bear,
    base: calculated.base,
    bull: calculated.bull,
    method: calculated.method,
    bearMultiple: calculated.bearMultiple,
    baseMultiple: calculated.baseMultiple,
    bullMultiple: calculated.bullMultiple,
    bearUpsidePct: calculated.bearUpsidePct,
    baseUpsidePct: calculated.baseUpsidePct,
    bullUpsidePct: calculated.bullUpsidePct,
  };
}

function compatibilitySelectedIntrinsicValue(
  api: StockDetailApiResponse,
  automatic: StockDetailAutomaticIntrinsicValue | null,
): StockDetailIntrinsicValue | null {
  if (api.valuation.selectedIntrinsicValue !== undefined) return api.valuation.selectedIntrinsicValue;
  if (api.valuation.intrinsicValue) return api.valuation.intrinsicValue;
  if (!automatic) return null;
  return {
    low: automatic.bear,
    base: automatic.base,
    high: automatic.bull,
    method: `automatic-${automatic.method.toLowerCase().replaceAll("/", "-")}`,
    asOf: api.generatedAt.slice(0, 10),
    upsidePct: automatic.baseUpsidePct,
  };
}

function toUiModel(api: StockDetailApiResponse): StockDetail {
  const manual = api.valuation.intrinsicValue;
  const automatic = compatibilityAutomaticValuation(api);
  const selected = compatibilitySelectedIntrinsicValue(api, automatic);
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
            bearMultiple: automatic.bearMultiple,
            baseMultiple: automatic.baseMultiple,
            bullMultiple: automatic.bullMultiple,
          }
        : null,
      scenarios: {
        bear: automatic?.bear ?? null,
        base: automatic?.base ?? null,
        bull: automatic?.bull ?? null,
      },
      methods: {
        dcf: null,
        multiples: null,
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
    metrics: {
      ...api.fundamentals,
      priceToBook: api.fundamentals.priceToBook ?? null,
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
