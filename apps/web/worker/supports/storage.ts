import { supportLevelRowSchema } from "@stock-autotrader/contracts";
import type { SupportLevelRow } from "@stock-autotrader/contracts";

/**
 * Manual support levels for the Screener (S1-S4).
 *
 * Pure storage concern: read rows from `stock_support_levels`, validate,
 * group by symbol, and order S1 -> S4. All interpretation (triggered /
 * not-triggered) lives in the Worker read model — storage never looks at
 * quotes.
 */

/** Grouped, ordered form handed to the Screener read model. */
export interface SupportLevelsForSymbol {
  symbol: string;
  levels: SupportLevelRow[];
}

/**
 * Read all manual-support levels from D1, grouped by symbol and ordered
 * S1 -> S4 within each group. Invalid rows are skipped defensively; a
 * missing/failing table degrades to an empty map — it must NEVER take the
 * whole Screener (prices/quotes/SMA) down with it.
 */
export async function readManualSupportLevels(
  db: D1Database,
): Promise<Map<string, SupportLevelsForSymbol>> {
  const grouped = new Map<string, SupportLevelsForSymbol>();
  try {
    const result = await db.prepare(
      `SELECT symbol, method, level, price, as_of_date
         FROM stock_support_levels
        WHERE method = 'manual'
        ORDER BY symbol, level ASC`,
    ).all();
    for (const raw of (result.results ?? []) as unknown[]) {
      const parsed = supportLevelRowSchema.safeParse(raw);
      if (!parsed.success) continue;
      const row: SupportLevelRow = parsed.data;
      const existing = grouped.get(row.symbol);
      if (existing) {
        existing.levels.push(row);
      } else {
        grouped.set(row.symbol, { symbol: row.symbol, levels: [row] });
      }
    }
  } catch {
    // Best-effort, same contract as readTechnicalMetrics / readCoreCompanies.
  }
  return grouped;
}
