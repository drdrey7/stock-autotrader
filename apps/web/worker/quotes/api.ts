import type { Env } from "../index";
import type {
  ScreenerApiResponse,
  ScreenerQuotesHealth,
  ScreenerRow,
  ScreenerMarketState,
  SourceState,
} from "@stock-autotrader/contracts";
import { CORE_UNIVERSE, CORE_UNIVERSE_VERSION } from "@stock-autotrader/contracts";
import { collectorStateFromRows, countQuoteStates, quoteState, quotesMarketState } from "./freshness";
import { readQuotesHealth } from "./health";
import { readLatestQuotes } from "./storage";

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
 * Screener read model: canonical Core Universe (50) combined with the latest
 * quote state. Pure D1 reads — opening /screener never touches Finnhub; the
 * collector is fully independent of frontend traffic.
 */
export async function readScreenerApi(env: Env, now = new Date()): Promise<ScreenerApiResponse> {
  const [quotes, companies] = await Promise.all([readLatestQuotes(env.DB), readCoreCompanies(env.DB)]);
  const health = await readQuotesHealth(env.DB);
  const quoteBySymbol = new Map(quotes.map((quote) => [quote.symbol, quote]));
  const companyBySymbol = new Map(companies.map((company) => [company.symbol, company.company]));

  const marketState: ScreenerMarketState = quotesMarketState(now);
  const rows: ScreenerRow[] = CORE_UNIVERSE.map((symbol) => {
    const quote = quoteBySymbol.get(symbol);
    const state: SourceState = quoteState(quote?.updated_at ?? null, now);
    return {
      symbol,
      company: companyBySymbol.get(symbol) ?? null,
      price: quote?.price ?? null,
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
    };
  });

  // Global collector freshness is derived from the real per-stock states, so
  // a persistently failing shard can never hide behind "recent lastSuccess"
  // from the healthy shards. Counts make the population explicit.
  const counts = countQuoteStates(rows);
  const quotesHealth: ScreenerQuotesHealth = {
    state: collectorStateFromRows(counts, marketState),
    provider: health?.provider ?? "unavailable",
    lastSuccessAt: health?.lastSuccessAt ?? null,
    lastAttemptAt: health?.lastAttemptAt ?? null,
    error: health?.lastError ?? null,
    counts,
  };

  return {
    universe: { version: CORE_UNIVERSE_VERSION, total: CORE_UNIVERSE.length },
    marketState,
    quotes: quotesHealth,
    rows,
    asOf: health?.lastSuccessAt ?? null,
  };
}
