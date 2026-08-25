import {
  calculateAutomaticIntrinsicValue,
  intrinsicValueDistancePct,
  type AutomaticIntrinsicValue,
  type ScreenerIntrinsicValue,
} from "@stock-autotrader/contracts";

export const AUTOMATIC_IV_MARKET_STALE_AFTER_SECONDS = 3 * 24 * 60 * 60;

/**
 * Minimal persisted market inputs required by the automatic valuation model.
 * Both Screener and Stock Detail adapt their D1 rows to this shape so freshness,
 * P/B derivation and valuation eligibility cannot drift between read models.
 */
export interface AutomaticValuationFundamentals {
  pe_ttm: number | null;
  market_cap: number | null;
  shareholders_equity: number | null;
  market_as_of?: string | null;
  market_checked_at: string | null;
  updated_at: string;
}

function finite(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function automaticValuationFundamentalsAreFresh(
  fundamentals: AutomaticValuationFundamentals | null | undefined,
  now: Date,
): boolean {
  if (!fundamentals) return false;
  const updatedMs = Date.parse(fundamentals.updated_at);
  const marketAsOfMs = Date.parse(fundamentals.market_checked_at ?? fundamentals.market_as_of ?? "");
  if (!Number.isFinite(updatedMs) || !Number.isFinite(marketAsOfMs)) return false;
  const oldestTimestamp = Math.min(marketAsOfMs, updatedMs);
  const ageSeconds = (now.getTime() - oldestTimestamp) / 1000;
  return ageSeconds >= 0 && ageSeconds <= AUTOMATIC_IV_MARKET_STALE_AFTER_SECONDS;
}

export function priceToBookFromPersistedFundamentals(
  fundamentals: AutomaticValuationFundamentals | null | undefined,
): number | null {
  const marketCap = fundamentals?.market_cap;
  const equity = fundamentals?.shareholders_equity;
  if (!finite(marketCap) || marketCap <= 0 || !finite(equity) || equity <= 0) return null;
  const value = marketCap / equity;
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function calculateAutomaticIntrinsicValueFromPersistedFundamentals(
  symbol: string,
  industry: string | null,
  currentPrice: number | null,
  fundamentals: AutomaticValuationFundamentals | null | undefined,
  now: Date,
): AutomaticIntrinsicValue | null {
  if (!automaticValuationFundamentalsAreFresh(fundamentals, now)) return null;
  return calculateAutomaticIntrinsicValue(symbol, industry, {
    price: currentPrice,
    peTtm: fundamentals?.pe_ttm ?? null,
    priceToBook: priceToBookFromPersistedFundamentals(fundamentals),
  });
}

/** Convert one automatic valuation into the Screener's selected-IV contract. */
export function automaticIntrinsicValueForScreener(
  automatic: AutomaticIntrinsicValue | null,
  currentPrice: number | null,
  asOf: string | undefined,
): ScreenerIntrinsicValue | null {
  if (!automatic || !asOf) return null;
  return {
    low: automatic.bear,
    base: automatic.base,
    high: automatic.bull,
    method: `automatic-${automatic.method.toLowerCase().replaceAll("/", "-")}`,
    asOf,
    distancePct: intrinsicValueDistancePct(currentPrice, automatic.base),
  };
}
