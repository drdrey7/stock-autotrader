import type { TechnicalMetricsRow } from "@stock-autotrader/contracts";
import { technicalMetricsRowSchema } from "@stock-autotrader/contracts";

/**
 * Read the precomputed 200-week SMA basis for all symbols (technical_metrics).
 *
 * One small 50-row read per Screener request — deliberately NOT the
 * ~200 x 50 weekly_prices rows: the historical basis changes weekly (or on
 * split reconciliation), never per WebSocket tick, so it is precomputed by
 * apps/history-ingestor. Rows that fail the contract (schema drift) are
 * skipped defensively; a symbol without a valid row simply has no SMA.
 */
export async function readTechnicalMetrics(db: D1Database): Promise<Map<string, TechnicalMetricsRow>> {
  const metrics = new Map<string, TechnicalMetricsRow>();
  try {
    const result = await db.prepare(
      `SELECT symbol, anchor_week, completed_weeks_available, sum_199, anchor_close,
              closed_sma_200w, historical_data_as_of, calculated_at, status, source
         FROM technical_metrics`,
    ).all();
    for (const row of (result.results ?? []) as unknown[]) {
      const parsed = technicalMetricsRowSchema.safeParse(row);
      if (!parsed.success) continue;
      metrics.set(parsed.data.symbol, parsed.data);
    }
  } catch {
    // Best-effort like readCoreCompanies: a missing/failing metrics table
    // degrades to "no SMA columns" for every symbol — it must NEVER take the
    // whole Screener (prices/quotes) down with it.
  }
  return metrics;
}

/**
 * Read the latest split effective date per symbol from split_events.
 * Used by the Worker to detect a split-scale mismatch per symbol: if the quote
 * is already on/after a split's effective date but technical_metrics were last
 * computed before that date, the SMA basis is on the wrong scale and must read
 * "Unavailable" until the daily due-split reconciliation recomputes it.
 *
 * Returns a Map of symbol -> latest effective date. Empty when no splits.
 */
export async function readLatestSplitEffectiveDate(db: D1Database): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  try {
    const query = await db.prepare(
      "SELECT symbol, MAX(effective_date) AS latest FROM split_events GROUP BY symbol",
    ).all<{ symbol: string; latest: string }>();
    for (const row of (query.results ?? [])) {
      if (row.symbol && row.latest) result.set(row.symbol, row.latest);
    }
  } catch {
    // Best-effort: a missing/failing split_events table disables the guard.
  }
  return result;
}

/**
 * Read the latest SPLIT EFFECTIVE AS OF a given date per symbol.
 * Future announced splits do not invalidate today's manual values.
 */
export async function readLatestSplitEffectiveDateAsOf(db: D1Database, asOfDate: string): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  try {
    const query = await db.prepare(
      "SELECT symbol, MAX(effective_date) AS latest FROM split_events WHERE effective_date <= ? GROUP BY symbol",
    ).bind(asOfDate).all<{ symbol: string; latest: string }>();
    for (const row of (query.results ?? [])) {
      if (row.symbol && row.latest) result.set(row.symbol, row.latest);
    }
  } catch {
    // Best-effort: same contract as readLatestSplitEffectiveDate.
  }
  return result;
}

export interface EffectiveSplitEventRow {
  symbol: string;
  effective_date: string;
  split_factor: number;
}

/**
 * All already-effective split events, grouped by symbol. Automatic IV uses the
 * factors to re-scale stale per-share fundamentals if a split happened while
 * the fundamentals VPS was offline. One tiny query; no weekly-price reads.
 */
export async function readEffectiveSplitEventsAsOf(
  db: D1Database,
  asOfDate: string,
): Promise<Map<string, EffectiveSplitEventRow[]>> {
  const grouped = new Map<string, EffectiveSplitEventRow[]>();
  try {
    const query = await db.prepare(
      "SELECT symbol, effective_date, split_factor FROM split_events WHERE effective_date <= ? ORDER BY symbol, effective_date ASC",
    ).bind(asOfDate).all<EffectiveSplitEventRow>();
    for (const row of query.results ?? []) {
      if (!row.symbol || !/^\d{4}-\d{2}-\d{2}$/.test(row.effective_date)) continue;
      if (!Number.isFinite(row.split_factor) || row.split_factor <= 0) continue;
      const rows = grouped.get(row.symbol) ?? [];
      rows.push(row);
      grouped.set(row.symbol, rows);
    }
  } catch {
    // Best-effort. Missing split data means no automatic split adjustment.
  }
  return grouped;
}
