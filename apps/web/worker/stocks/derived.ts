import type {
  ScreenerIntrinsicValue,
  ScreenerSupportLevel,
} from "@stock-autotrader/contracts";
import type { IntrinsicValuesForSymbol } from "../intrinsic-values/storage";
import type { SupportLevelsForSymbol } from "../supports/storage";

/**
 * Manual price-scale guard shared by every stock read model.
 *
 * A curated manual value is invalid only when a split became effective after
 * its reference date and that split is already effective on the current New
 * York market date. Future announced splits do not invalidate today's scale.
 */
export function isManualValueSplitSafe(
  asOfDate: string,
  splitEffectiveDate: string | undefined,
  currentMarketDate: string | undefined,
): boolean {
  if (!splitEffectiveDate || !currentMarketDate) return true;
  return !(splitEffectiveDate > asOfDate && splitEffectiveDate <= currentMarketDate);
}

/** Build the support-level list for one symbol, with triggered derived. */
export function buildSupportLevels(
  currentPrice: number | null,
  grouped: SupportLevelsForSymbol | undefined,
  splitEffectiveDate: string | undefined,
  currentMarketDate: string | undefined,
): ScreenerSupportLevel[] {
  if (!grouped || grouped.levels.length === 0) return [];
  const oldestAsOf = grouped.levels.reduce(
    (oldest, level) => level.as_of_date < oldest ? level.as_of_date : oldest,
    grouped.levels[0]!.as_of_date,
  );
  if (!isManualValueSplitSafe(oldestAsOf, splitEffectiveDate, currentMarketDate)) return [];

  return grouped.levels.map((level) => ({
    level: level.level as ScreenerSupportLevel["level"],
    price: level.price,
    method: level.method,
    asOf: level.as_of_date,
    triggered: currentPrice === null ? null : currentPrice <= level.price,
  }));
}

/**
 * Build the Screener intrinsic-value shape for one symbol.
 *
 * IMPORTANT: `distancePct` retains the Screener's established semantics:
 * (currentPrice / baseIV - 1) * 100. Stock Detail derives its separately named
 * `upsidePct` with the inverse business meaning in its own read model.
 */
export function buildIntrinsicValue(
  currentPrice: number | null,
  iv: IntrinsicValuesForSymbol | undefined,
  splitEffectiveDate: string | undefined,
  currentMarketDate: string | undefined,
): ScreenerIntrinsicValue | null {
  if (!iv) return null;
  if (!isManualValueSplitSafe(iv.values.as_of_date, splitEffectiveDate, currentMarketDate)) return null;

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
