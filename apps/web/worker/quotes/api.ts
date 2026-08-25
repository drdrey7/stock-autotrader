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
import { readTechnicalMetrics, readLatestSplitEffectiveDate, readLatestSplitEffectiveDateAsOf } from "../sma/storage";
import { readManualSupportLevels } from "../supports/storage";
import { readManualIntrinsicValues } from "../intrinsic-values/storage";
import {
  automaticIntrinsicValueForScreener,
  calculateAutomaticIntrinsicValueFromPersistedFundamentals,
} from "../intrinsic-values/automatic";
import { buildIntrinsicValue, buildSupportLevels } from "../stocks/derived";
import { nyDateKeyOf } from "./freshness";

interface CompanyRow {
  symbol: string;
  company: string;
  logo_url: string | null;
  industry: string | null;
  pe_ttm: number | null;
  eps_ttm: number | null;
  market_cap: number | null;
  shareholders_equity: number | null;
  shares_outstanding: number | null;
  market_as_of: string | null;
  market_checked_at: string | null;
  updated_at: string | null;
}

/**
 * Core Universe company + slow valuation inputs in one D1 query. The LEFT JOIN
 * keeps fundamentals best-effort and avoids a second query/read loop for the
 * Screener fallback IV. Freshness and per-share eligibility are evaluated by
 * the same canonical helper used by Stock Detail.
 */
async function readCoreCompanies(db: D1Database): Promise<CompanyRow[]> {
  try {
    const result = await db.prepare(
      `SELECT u.symbol, u.company, u.logo_url, u.industry,
        f.pe_ttm, f.eps_ttm, f.market_cap, f.shareholders_equity, f.shares_outstanding,
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

/**
 * Map the WebSocket collector state onto today's Screener badge labels
 * (P2 #2B — a future /status PR will surface Healthy/Degraded/Disconnected
 * natively). The worker badge stays semantics-compatible:
 *  - Healthy   -> Live (open session) / Cached (closed)
 *  - Degraded  -> Cached (usable, but not streaming live data)
 *  - Disconnected -> Stale (assuming a dead collector never recovers)
 */
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
 * Screener read model: canonical Core Universe (50) combined with the latest
 * quote state. Pure D1 reads — opening /screener never touches Finnhub.
 *
 * IV selection is deliberately centralized and deterministic:
 *   1. split-safe Manual IV from D1;
 *   2. otherwise Automatic Base from fresh persisted per-share fundamentals;
 *   3. otherwise unavailable.
 */
export async function readScreenerApi(env: Env, now = new Date()): Promise<ScreenerApiResponse> {
  const currentMarketDate = nyDateKeyOf(now) ?? undefined;
  const [quotes, companies, wsHealth, metrics, latestSplitEffectiveDates, splitEffectiveDatesAsOf, supportLevels, intrinsicValues] = await Promise.all([
    readLatestQuotes(env.DB),
    readCoreCompanies(env.DB),
    readWsIngestorHealth(env.DB),
    readTechnicalMetrics(env.DB),
    readLatestSplitEffectiveDate(env.DB),
    currentMarketDate ? readLatestSplitEffectiveDateAsOf(env.DB, currentMarketDate) : Promise.resolve(new Map()),
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
      currentMarketDate,
    );
    const automaticIntrinsicValue = calculateAutomaticIntrinsicValueFromPersistedFundamentals(
      symbol,
      company?.industry ?? null,
      currentPrice,
      company,
      now,
    );
    const intrinsicValue = manualIntrinsicValue
      ?? automaticIntrinsicValueForScreener(automaticIntrinsicValue, currentPrice, currentMarketDate);

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
      supportLevels: buildSupportLevels(currentPrice, supportLevels.get(symbol), splitEffectiveDatesAsOf.get(symbol), currentMarketDate),
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
