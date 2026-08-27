import type { QuoteObservation } from "@stock-autotrader/contracts";
import { isCoreUniverseSymbol } from "@stock-autotrader/contracts";

export interface LatestQuoteRow {
  symbol: string;
  price: number;
  change_abs: number;
  change_pct: number;
  day_high: number | null;
  day_low: number | null;
  day_open: number | null;
  previous_close: number | null;
  provider: string;
  provider_timestamp: string;
  updated_at: string;
  quote_session_date?: string | null;
  previous_close_session_date?: string | null;
  daily_change_valid?: number;
}

const UPSERT_SQL = `
INSERT INTO latest_quotes
  (symbol, price, change_abs, change_pct, day_high, day_low, day_open, previous_close, provider, provider_timestamp, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(symbol) DO UPDATE SET
  price = excluded.price,
  change_abs = excluded.change_abs,
  change_pct = excluded.change_pct,
  day_high = excluded.day_high,
  day_low = excluded.day_low,
  day_open = excluded.day_open,
  previous_close = excluded.previous_close,
  provider = excluded.provider,
  provider_timestamp = excluded.provider_timestamp,
  updated_at = excluded.updated_at,
  quote_session_date = NULL,
  previous_close_session_date = NULL,
  daily_change_valid = 0
WHERE excluded.provider_timestamp >= latest_quotes.provider_timestamp
`;

/**
 * Upsert a REST quote observation defensively.
 *
 * The Finnhub WebSocket ingestor is the canonical automatic writer and owns
 * regular-session provenance. If this legacy/provider-neutral write path is
 * ever re-enabled, it deliberately invalidates session provenance rather than
 * allowing an observation without a proven session lifecycle to inherit a
 * previously-valid 1D baseline. Price still serves; 1D fails closed.
 */
export async function upsertLatestQuotes(
  db: D1Database,
  observations: readonly QuoteObservation[],
  updatedAt: string,
): Promise<number> {
  const statements = observations
    .filter((observation) => isCoreUniverseSymbol(observation.symbol))
    .map((observation) => db.prepare(UPSERT_SQL).bind(
      observation.symbol,
      observation.price,
      observation.changeAbs,
      observation.changePct,
      observation.dayHigh,
      observation.dayLow,
      observation.dayOpen,
      observation.previousClose,
      observation.provider,
      observation.asOf,
      updatedAt,
    ));
  if (statements.length === 0) return 0;
  const results = await db.batch(statements);
  return results.reduce((total, result) => total + Number(result.meta?.changes ?? 0), 0);
}

export async function readLatestQuotes(db: D1Database): Promise<LatestQuoteRow[]> {
  const result = await db.prepare(
    `SELECT symbol, price, change_abs, change_pct, day_high, day_low, day_open,
            previous_close, provider, provider_timestamp, updated_at,
            quote_session_date, previous_close_session_date, daily_change_valid
       FROM latest_quotes`,
  ).all<LatestQuoteRow>();
  return result.results ?? [];
}
