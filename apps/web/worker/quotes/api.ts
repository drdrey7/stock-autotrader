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
import { readManualSupportLevels, type SupportLevelsForSymbol } from "../supports/storage";
import type { ScreenerSupportLevel, ScreenerIntrinsicValue } from "@stock-autotrader/contracts";
import { readManualIntrinsicValues, type IntrinsicValuesForSymbol } from "../intrinsic-values/storage";
import { nyDateKeyOf } from "./freshness";

/** Build the support-level list for one symbol, with triggered derived.
 *
 * Split-safety (P1/P2): if a stock split happened AFTER the support reference
 * date AND is already effective today, the stored manual support prices are on
 * the wrong scale and must not be displayed. Reuses the same
 * `latestSplitEffectiveDates` map that the SMA200W split-safety already reads —
 * no extra provider/D1 calls.
 *
 * Uses the OLDEST asOf from the curated set (conservative: S1-S4 are a set,
 * never mix pre/post-split scales).
 *
 * Rule:
 *  - no split effective date → supports valid
 *  - splitEffectiveDate <= oldestAsOf → supports valid
 *  - splitEffectiveDate > oldestAsOf AND splitEffectiveDate <= currentMarketDate
 *    → return [] (split already effective, supports stale)
 *  - splitEffectiveDate > oldestAsOf AND splitEffectiveDate > currentMarketDate
 *    → supports valid (future split, quote still on pre-split scale) */
function buildSupportLevels(
  currentPrice: number | null,
  grouped: SupportLevelsForSymbol | undefined,
  splitEffectiveDate: string | undefined,
  currentMarketDate: string | undefined,
): ScreenerSupportLevel[] {
  if (!grouped) return [];
  if (splitEffectiveDate && currentMarketDate) {
    const oldestAsOf = grouped.levels.reduce((min, l) => l.as_of_date < min ? l.as_of_date : min, grouped.levels[0]!.as_of_date);
    if (splitEffectiveDate > oldestAsOf && splitEffectiveDate <= currentMarketDate) return [];
  }
  return grouped.levels.map((level) => ({
    level: level.level as ScreenerSupportLevel["level"],
    price: level.price,
    method: level.method,
    asOf: level.as_of_date,
    triggered: currentPrice === null ? null : currentPrice <= level.price,
  }));
}

/**
 * Build the intrinsic value for one symbol, with distance derived.
 *
 * Split-safety (same rule as supports): if a stock split happened AFTER the
 * IV reference date AND is already effective today, the stored manual IV is on
 * the wrong scale and must not be displayed. Reuses the same
 * `latestSplitEffectiveDates` map that the SMA200W/support split-safety reads.
 *
 * Distance formula: (currentPrice / baseIV - 1) * 100
 * Null when no currentPrice or no IV.
 */
function buildIntrinsicValue(
  currentPrice: number | null,
  iv: IntrinsicValuesForSymbol | undefined,
  splitEffectiveDate: string | undefined,
  currentMarketDate: string | undefined,
): ScreenerIntrinsicValue | null {
  if (!iv) return null;
  if (splitEffectiveDate && currentMarketDate) {
    if (splitEffectiveDate > iv.values.as_of_date && splitEffectiveDate <= currentMarketDate) return null;
  }
  const base = iv.values.base_value;
  const distancePct = currentPrice === null ? null : (currentPrice / base - 1) * 100;
  return {
    low: iv.values.low_value,
    base,
    high: iv.values.high_value,
    method: iv.values.method,
    asOf: iv.values.as_of_date,
    distancePct,
  };
}

interface CompanyRow {
  symbol: string;
  company: string;
}

/** Core Universe company names are best-effort enrichment — never fatal. */
async function readCoreCompanies(db: D1Database): Promise<CompanyRow[]> {
  try {
    const result = await db.prepare(
      "SELECT symbol, company FROM earnings_universe WHERE source = 'core' AND active = 1",
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
      // Only DURING the regular session is the collector "Live"; after it
      // (post_close / closed) the prices are the final session snapshot.
      return marketState === "regular" ? "Live" : "Cached";
    case "Degraded":
      return "Cached";
    case "Disconnected":
      return "Stale";
    default:
      return "Unavailable";
  }
}

/**
 * P2 #2 conservative cross-check: Finnhub has no per-symbol subscription ack,
 * so a Healthy WS with ZERO live rows during the regular session means the
 * subscriptions may have silently failed (heartbeat fresh, socket connected,
 * no data arriving). In that pathological case we refuse to claim global
 * "Live" and degrade to Cached. Deliberately NOT triggered by one quiet
 * symbol, no recent NET/SNOW trade, or 49/50 live — only live === 0.
 */
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
 * quote state. Pure D1 reads — opening /screener never touches Finnhub; the
 * collector is fully independent of frontend traffic.
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
  // REST shard health is only used as a fallback (manual/diagnostic runs)
  // when the WebSocket collector has never written a record.
  const restHealth = wsHealth ? null : await readQuotesHealth(env.DB);
  const quoteBySymbol = new Map(quotes.map((quote) => [quote.symbol, quote]));
  const companyBySymbol = new Map(companies.map((company) => [company.symbol, company.company]));

  const marketState: ScreenerMarketState = quotesMarketState(now);
  const rows: ScreenerRow[] = CORE_UNIVERSE.map((symbol) => {
    const quote = quoteBySymbol.get(symbol);
    const state: SourceState = quoteState(quote?.updated_at ?? null, now);
    const quoteInput: QuoteInput | null = quote && quote.price > 0
      ? { price: quote.price, provider_timestamp: quote.provider_timestamp }
      : null;
    const sma = computeLiveSma200w(quoteInput, metrics.get(symbol) ?? null, latestSplitEffectiveDates);
    const currentPrice = quote?.price ?? null;
    return {
      symbol,
      company: companyBySymbol.get(symbol) ?? null,
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
      intrinsicValue: buildIntrinsicValue(currentPrice, intrinsicValues.get(symbol), splitEffectiveDatesAsOf.get(symbol), currentMarketDate),
    };
  });

  const counts = countQuoteStates(rows);
  // Global collector freshness comes from the WebSocket ingestor's D1
  // heartbeat + TTL (P2 #1/#2B) — NOT from per-symbol row age, so a quiet
  // symbol (zero trades for 15+ min) can never demote the whole collector.
  // Without a WS record (never installed / REST rollback) we fall back to the
  // legacy row-derived collector state.
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
