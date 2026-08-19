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
 * Read the latest split effective date across all symbols from split_events.
 * Used by the Worker to detect a split-scale mismatch: if the quote is already
 * on/after a split's effective date but technical_metrics were last computed
 * before that date, the SMA basis is on the wrong scale and must read
 * "Unavailable" until the daily due-split reconciliation recomputes it.
 *
 * Returns null when there are no stored splits (no guard needed).
 */
export async function readLatestSplitEffectiveDate(db: D1Database): Promise<string | null> {
  try {
    const result = await db.prepare(
      "SELECT MAX(effective_date) AS latest FROM split_events",
    ).all<{ latest: string | null }>();
    const rows = result.results ?? [];
    if (!rows.length) return null;
    return rows[0]?.latest ?? null;
  } catch {
    // Best-effort: a missing/failing split_events table disables the guard
    // (the historical basis is then assumed current). Never fatal.
    return null;
  }
}
