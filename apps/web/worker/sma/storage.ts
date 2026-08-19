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
  const result = await db.prepare(
    `SELECT symbol, anchor_week, completed_weeks_available, sum_199, anchor_close,
            closed_sma_200w, historical_data_as_of, calculated_at, status, source
       FROM technical_metrics`,
  ).all();
  const metrics = new Map<string, TechnicalMetricsRow>();
  for (const row of (result.results ?? []) as unknown[]) {
    const parsed = technicalMetricsRowSchema.safeParse(row);
    if (!parsed.success) continue;
    metrics.set(parsed.data.symbol, parsed.data);
  }
  return metrics;
}
