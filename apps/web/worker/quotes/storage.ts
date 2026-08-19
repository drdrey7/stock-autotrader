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
  updated_at = excluded.updated_at
WHERE excluded.provider_timestamp >= latest_quotes.provider_timestamp
`;

/**
 * Upsert the latest quote state for a batch of symbols in one D1 batch call.
 * One row per symbol — refreshing a symbol updates its row, it never appends.
 * Defensive membership gate: only canonical Core Universe symbols persist.
 *
 * Race guard (transition window, REST collector + Finnhub WebSocket ingestor
 * both writing latest_quotes): the UPSERT only overwrites when the incoming
 * `provider_timestamp` is at least as new as the stored one
 * (`WHERE excluded.provider_timestamp >= latest_quotes.provider_timestamp`).
 * Both writers store ISO 8601 UTC, so the lexicographic compare is
 * chronological — an older REST response can never regress a newer WebSocket
 * quote, and the WebSocket ingestor applies the same rule in its own SQL.
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
            previous_close, provider, provider_timestamp, updated_at
       FROM latest_quotes`,
  ).all<LatestQuoteRow>();
  return result.results ?? [];
}
