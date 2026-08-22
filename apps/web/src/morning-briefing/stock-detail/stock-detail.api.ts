import {
  screenerApiResponseSchema,
  stockDetailApiResponseSchema,
  type ScreenerApiResponse,
  type ScreenerRow,
  type StockDetailApiResponse,
} from "@stock-autotrader/contracts";
import { requestJson } from "../api-client";
import type { StockDetail, StockDetailDataSource } from "./stock-detail.types";

interface ScreenerSummary {
  row: ScreenerRow;
  marketState: ScreenerApiResponse["marketState"];
}

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
function canShowDailyChange(api: StockDetailApiResponse, screener: ScreenerSummary | null): boolean {
  const marketState = screener?.marketState ?? api.quote.marketState;
  const quoteState = screener?.row.state ?? api.quote.state;
  return marketState === "regular"
    && quoteState === "Live"
    && api.quote.scaleState === "safe"
    && api.quote.provider === "finnhub-quote";
}

/**
 * Screener is the canonical source for values already shown in its row.
 * Stock Detail only adds detail-only data (history/chart/freshness metadata).
 * This guarantees that clicking a stock cannot change its visible price, IV,
 * SMA or support values just because the detail read model is stricter.
 */
function toUiModel(api: StockDetailApiResponse, screener: ScreenerSummary | null): StockDetail {
  const row = screener?.row ?? null;
  const price = row ? row.price : api.quote.price;
  const intrinsicValue = row ? row.intrinsicValue : api.valuation.intrinsicValue;
  const showDailyChange = canShowDailyChange(api, screener);
  const marketState = screener?.marketState ?? api.quote.marketState;
  const quoteState = row?.state ?? api.quote.state;
  const changeAbs = row ? row.changeAbs : api.quote.changeAbs;
  const changePct = row ? row.changePct : api.quote.changePct;
  const ivUpsidePct = intrinsicValue && price !== null && price > 0
    ? (intrinsicValue.base / price - 1) * 100
    : null;

  const supports = row ? row.supportLevels : api.technical.supports;
  return {
    source: "api",
    symbol: api.symbol,
    companyName: row?.company ?? api.company.name ?? api.symbol,
    exchange: api.company.exchange,
    sector: api.company.sector,
    logoUrl: row?.logoUrl ?? api.company.logoUrl,
    quote: {
      price,
      change: showDailyChange ? changeAbs : null,
      changePct: showDailyChange ? changePct : null,
      state: quoteState,
      scaleState: api.quote.scaleState,
      marketState: marketState === "regular" ? "open" : "closed",
      asOf: row ? row.asOf : api.quote.asOf,
    },
    valuation: {
      intrinsicValue: intrinsicValue?.base ?? null,
      upsidePct: ivUpsidePct,
      scenarios: {
        bear: intrinsicValue?.low ?? null,
        base: intrinsicValue?.base ?? null,
        bull: intrinsicValue?.high ?? null,
      },
      methods: {
        dcf: null,
        multiples: null,
        manual: intrinsicValue?.base ?? null,
        selected: intrinsicValue?.base ?? null,
        selectedMethod: intrinsicValue?.method ?? null,
      },
    },
    technical: {
      sma200w: row ? row.sma200w : api.technical.sma200w,
      smaDistancePct: row ? row.distanceToSma200wPct : api.technical.distanceToSma200wPct,
      sma200wHistory: api.technical.sma200wHistory,
      supports: supports.map((support) => ({
        level: support.level,
        price: support.price,
        method: support.method,
        asOf: support.asOf,
        triggered: support.triggered,
      })),
    },
    metrics: {
      marketCap: null,
      peTtm: null,
      roicPct: null,
      fcfMarginPct: null,
      debtToEquity: null,
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
    const [detailResponse, screenerResponse] = await Promise.all([
      requestJson(`/api/stocks/${encodeURIComponent(symbol)}/detail`),
      requestJson("/api/screener"),
    ]);

    if (detailResponse.status === 404) return null;
    if (!detailResponse.ok) throw new Error(`stock_detail_http_${detailResponse.status}`);

    const parsedDetail = stockDetailApiResponseSchema.safeParse(detailResponse.body);
    if (!parsedDetail.success) throw new Error("stock_detail_invalid_response");

    let screener: ScreenerSummary | null = null;
    if (screenerResponse.ok) {
      const parsedScreener = screenerApiResponseSchema.safeParse(screenerResponse.body);
      if (parsedScreener.success) {
        const row = parsedScreener.data.rows.find((candidate) => candidate.symbol === symbol) ?? null;
        if (row) screener = { row, marketState: parsedScreener.data.marketState };
      }
    }

    return toUiModel(parsedDetail.data, screener);
  }
}

export const apiStockDetailDataSource = new ApiStockDetailDataSource();
