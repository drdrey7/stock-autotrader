import type { Env } from "../index";
import type {
  ScreenerApiResponse,
  ScreenerQuotesHealth,
  ScreenerRow,
  ScreenerMarketState,
  SourceState,
} from "@stock-autotrader/contracts";
import { CORE_UNIVERSE, CORE_UNIVERSE_VERSION } from "@stock-autotrader/contracts";
import {
  collectorStateFromRows,
  countQuoteStates,
  quoteState,
  quotesMarketState,
  type QuoteStateCounts,
} from "./freshness";
import {
  collectorStateFromWsHealth,
  readQuotesHealth,
  readWsIngestorHealth,
  type WSCollectorState,
} from "./health";
import { readLatestQuotes } from "./storage";
import { computeLiveSma200w, type QuoteInput } from "../sma/metrics";
import {
  readEffectiveSplitEventsAsOf,
  readLatestSplitEffectiveDate,
  readLatestSplitEffectiveDateAsOf,
  readTechnicalMetrics,
} from "../sma/storage";
import { readManualSupportLevels } from "../supports/storage";
import { readManualIntrinsicValues } from "../intrinsic-values/storage";
import {
  automaticIntrinsicValueForScreener,
  calculateAutomaticIntrinsicValueFromPersistedFundamentals,
  type AutomaticValuationFundamentals,
} from "../intrinsic-values/automatic";
import { buildIntrinsicValue, buildSupportLevels } from "../stocks/derived";
import { nyDateKeyOf } from "./freshness";

interface CompanyRow extends AutomaticValuationFundamentals {
  symbol: string;
  company: string;
  logo_url: string | null;
  industry: string | null;
}

/**
 * Core Universe company + last-known-good valuation facts in one D1 query.
 * The LEFT JOIN keeps fundamentals best-effort and avoids any provider request
 * in the Screener path.
 */
async function readCoreCompanies(db: D1Database): Promise<CompanyRow[]> {
  try {
    const result = await db.prepare(
      `SELECT u.symbol, u.company, u.logo_url, u.industry,
        f.eps_ttm, f.fcf_per_share_ttm, f.revenue_per_share_ttm, f.book_value_per_share,
        f.revenue_growth_ttm_yoy_pct, f.revenue_growth_3y_pct, f.revenue_growth_5y_pct,
        f.roe_ttm_pct, f.roic_pct, f.fcf_margin_pct, f.debt_to_equity,
        f.pe_5y_p25, f.pe_5y_median, f.pe_5y_p75, f.pe_5y_samples, f.pe_5y_as_of,
        f.pfcf_5y_p25, f.pfcf_5y_median, f.pfcf_5y_p75, f.pfcf_5y_samples, f.pfcf_5y_as_of,
        f.ps_5y_p25, f.ps_5y_median, f.ps_5y_p75, f.ps_5y_samples, f.ps_5y_as_of,
        f.pb_5y_p25, f.pb_5y_median, f.pb_5y_p75, f.pb_5y_samples, f.pb_5y_as_of,
        f.market_as_of, f.market_checked_at, f.updated_at
       FROM earnings_universe AS u
       LEFT JOIN stock_fundamentals_snapshot AS f ON f.symbol = u.symbol
       WHERE u.source = 'core' AND u.active = 1`,
    ).all<CompanyRow>();
    return result.results ?? [];
  } catch {
    return [];
  }
}

function wsCollectorStateToSourceState(state: WSCollectorState, marketState: ScreenerMarketState): SourceState {
  switch (state) {
    case "Healthy":
      return marketState === "regular" ? "Live" : "Cached";
    case "Degraded":
      return "Cached";
    case "Disconnected":
      return "Stale";
    default:
      return "Unavailable";
  }
}

function safeguardWsCollectorState(
  base: SourceState,
  wsState: WSCollectorState,
  counts: QuoteStateCounts,
  marketState: ScreenerMarketState,
): SourceState {
  if (wsState === "Healthy" && marketState === "regular" && counts.live === 0) return "Cached";
  return base;
}

/**
 * Screener read model: pure D1 serving. IV selection is deterministic:
 * split-safe Manual first, otherwise Automatic V2 Base from the persisted
 * last-known-good fundamentals snapshot. There is no fundamentals age TTL.
 */
export async function readScreenerApi(env: Env, now = new Date()): Promise<ScreenerApiResponse> {
  const currentMarketDate = nyDateKeyOf(now);
  const [
    quotes,
    companies,
    wsHealth,
    metrics,
    latestSplitEffectiveDates,
    splitEffectiveDatesAsOf,
    effectiveSplitEvents,
    supportLevels,
    intrinsicValues,
  ] = await Promise.all([
    readLatestQuotes(env.DB),
    readCoreCompanies(env.DB),
    readWsIngestorHealth(env.DB),
    readTechnicalMetrics(env.DB),
    readLatestSplitEffectiveDate(env.DB),
    currentMarketDate ? readLatestSplitEffectiveDateAsOf(env.DB, currentMarketDate) : Promise.resolve(new Map()),
    currentMarketDate ? readEffectiveSplitEventsAsOf(env.DB, currentMarketDate) : Promise.resolve(new Map()),
    readManualSupportLevels(env.DB),
    readManualIntrinsicValues(env.DB),
  ]);
  const restHealth = wsHealth ? null : await readQuotesHealth(env.DB);
  const quoteBySymbol = new Map(quotes.map((quote) => [quote.symbol, quote]));
  const companyBySymbol = new Map(companies.map((company) => [company.symbol, company]));

  const marketState: ScreenerMarketState = quotesMarketState(now);
  const rows: ScreenerRow[] = CORE_UNIVERSE.map((symbol) => {
    const quote = quoteBySymbol.get(symbol);
    const company = companyBySymbol.get(symbol);
    const state: SourceState = quoteState(quote?.updated_at ?? null, now);
    const quoteInput: QuoteInput | null = quote && quote.price > 0
      ? { price: quote.price, provider_timestamp: quote.provider_timestamp }
      : null;
    const sma = computeLiveSma200w(quoteInput, metrics.get(symbol) ?? null, latestSplitEffectiveDates);
    const currentPrice = quote?.price ?? null;
    const manualIntrinsicValue = buildIntrinsicValue(
      currentPrice,
      intrinsicValues.get(symbol),
      splitEffectiveDatesAsOf.get(symbol),
      currentMarketDate ?? undefined,
    );
    const automaticIntrinsicValue = currentMarketDate
      ? calculateAutomaticIntrinsicValueFromPersistedFundamentals(
          symbol,
          company?.industry ?? null,
          currentPrice,
          company,
          effectiveSplitEvents.get(symbol) ?? [],
          currentMarketDate,
        )
      : null;
    const intrinsicValue = manualIntrinsicValue
      ?? automaticIntrinsicValueForScreener(automaticIntrinsicValue, currentPrice);

    return {
      symbol,
      company: company?.company ?? null,
      price: currentPrice,
      changeAbs: quote?.change_abs ?? null,
      changePct: quote?.change_pct ?? null,
      dayHigh: quote?.day_high ?? null,
      dayLow: quote?.day_low ?? null,
      dayOpen: quote?.day_open ?? null,
      previousClose: quote?.previous_close ?? null,
      provider: quote?.provider ?? null,
      asOf: quote?.provider_timestamp ?? null,
      updatedAt: quote?.updated_at ?? null,
      state,
      sma200w: sma.sma200w,
      distanceToSma200wPct: sma.distanceToSma200wPct,
      sma200wState: sma.sma200wState,
      sma200wHistoryWeeks: sma.sma200wHistoryWeeks,
      sma200wAsOf: sma.sma200wAsOf,
      supportLevels: buildSupportLevels(
        currentPrice,
        supportLevels.get(symbol),
        splitEffectiveDatesAsOf.get(symbol),
        currentMarketDate ?? undefined,
      ),
      intrinsicValue,
      logoUrl: company?.logo_url ?? null,
    };
  });

  const counts = countQuoteStates(rows);
  const wsCollector = wsHealth ? collectorStateFromWsHealth(wsHealth, now) : "Unavailable";
  const collectorState = wsHealth
    ? safeguardWsCollectorState(
        wsCollectorStateToSourceState(wsCollector, marketState),
        wsCollector,
        counts,
        marketState,
      )
    : collectorStateFromRows(counts, marketState);
  const quotesHealth: ScreenerQuotesHealth = {
    state: collectorState,
    provider: wsHealth ? "finnhub-websocket" : (restHealth?.provider ?? "unavailable"),
    lastSuccessAt: wsHealth ? wsHealth.lastSuccessfulFlushAt : (restHealth?.lastSuccessAt ?? null),
    lastAttemptAt: wsHealth ? wsHealth.lastFlushAt : (restHealth?.lastAttemptAt ?? null),
    error: wsHealth ? wsHealth.lastError : (restHealth?.lastError ?? null),
    counts,
  };

  return {
    universe: { version: CORE_UNIVERSE_VERSION, total: CORE_UNIVERSE.length },
    marketState,
    quotes: quotesHealth,
    rows,
    asOf: wsHealth ? wsHealth.lastSuccessfulFlushAt : (restHealth?.lastSuccessAt ?? null),
  };
}
