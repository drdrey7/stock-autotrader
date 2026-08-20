import { intrinsicValueRowSchema } from "@stock-autotrader/contracts";
import type { IntrinsicValueRow } from "@stock-autotrader/contracts";

/**
 * Manual intrinsic values for the Screener.
 *
 * Pure storage concern: read rows from `stock_intrinsic_values`, validate,
 * group by symbol. All interpretation (distance calculation) lives in the
 * Worker read model — storage never looks at quotes.
 */

/** Grouped form handed to the Screener read model. */
export interface IntrinsicValuesForSymbol {
  symbol: string;
  values: IntrinsicValueRow;
}

/**
 * Read all manual intrinsic values from D1, grouped by symbol. Invalid rows
 * are skipped defensively; a missing/failing table degrades to an empty map —
 * it must NEVER take the whole Screener (prices/quotes/SMA) down with it.
 */
export async function readManualIntrinsicValues(
  db: D1Database,
): Promise<Map<string, IntrinsicValuesForSymbol>> {
  const grouped = new Map<string, IntrinsicValuesForSymbol>();
  try {
    const result = await db.prepare(
      `SELECT symbol, method, low_value, base_value, high_value, as_of_date
         FROM stock_intrinsic_values
        WHERE method = 'manual'`,
    ).all();
    for (const raw of (result.results ?? []) as unknown[]) {
      const parsed = intrinsicValueRowSchema.safeParse(raw);
      if (!parsed.success) continue;
      const row: IntrinsicValueRow = parsed.data;
      grouped.set(row.symbol, { symbol: row.symbol, values: row });
    }
  } catch {
    // Best-effort, same contract as readManualSupportLevels / readTechnicalMetrics.
  }
  return grouped;
}
