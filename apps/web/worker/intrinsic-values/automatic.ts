import {
  calculateAutomaticIntrinsicValue,
  classifyValuationFamily,
  intrinsicValueDistancePct,
  type AutomaticIntrinsicValue,
  type ScreenerIntrinsicValue,
} from "@stock-autotrader/contracts";

export const AUTOMATIC_IV_MARKET_STALE_AFTER_SECONDS = 3 * 24 * 60 * 60;

/**
 * Minimal persisted inputs required by the automatic valuation model.
 * Both Screener and Stock Detail adapt their D1 rows to this shape so freshness,
 * per-share anchors and valuation eligibility cannot drift between read models.
 */
export interface AutomaticValuationFundamentals {
  pe_ttm: number | null;
  eps_ttm?: number | null;
  fcf_per_share_ttm?: number | null;
  market_cap: number | null;
  shareholders_equity: number | null;
  shares_outstanding?: number | null;
  market_as_of?: string | null;
  market_checked_at: string | null;
  /** Nullable because Screener obtains these columns through a LEFT JOIN. */
  updated_at: string | null;
}

function finite(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function positiveFinite(value: number | null | undefined): value is number {
  return finite(value) && value > 0;
}

export function automaticValuationFundamentalsAreFresh(
  fundamentals: AutomaticValuationFundamentals | null | undefined,
  now: Date,
): boolean {
  if (!fundamentals) return false;
  const updatedMs = Date.parse(fundamentals.updated_at ?? "");
  const marketAsOfMs = Date.parse(fundamentals.market_checked_at ?? fundamentals.market_as_of ?? "");
  if (!Number.isFinite(updatedMs) || !Number.isFinite(marketAsOfMs)) return false;
  const oldestTimestamp = Math.min(marketAsOfMs, updatedMs);
  const ageSeconds = (now.getTime() - oldestTimestamp) / 1000;
  return ageSeconds >= 0 && ageSeconds <= AUTOMATIC_IV_MARKET_STALE_AFTER_SECONDS;
}

/** Current P/B is still useful for the public metric/read model, not as the canonical IV anchor. */
export function priceToBookFromPersistedFundamentals(
  fundamentals: AutomaticValuationFundamentals | null | undefined,
): number | null {
  const marketCap = fundamentals?.market_cap;
  const equity = fundamentals?.shareholders_equity;
  if (!positiveFinite(marketCap) || !positiveFinite(equity)) return null;
  const value = marketCap / equity;
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function bookValuePerShareFromPersistedFundamentals(
  fundamentals: AutomaticValuationFundamentals | null | undefined,
): number | null {
  const equity = fundamentals?.shareholders_equity;
  const shares = fundamentals?.shares_outstanding;
  if (!positiveFinite(equity) || !positiveFinite(shares)) return null;
  const value = equity / shares;
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Canonical serving adapter. Production uses only persisted, fresh per-share
 * anchors. Banks require positive EPS + BVPS. Other stocks prefer positive EPS
 * (P/E) and fall back to positive FCF/share (P/FCF). Current price only drives
 * displayed upside/distance, never the intrinsic-value equation itself.
 */
export function calculateAutomaticIntrinsicValueFromPersistedFundamentals(
  symbol: string,
  industry: string | null,
  currentPrice: number | null,
  fundamentals: AutomaticValuationFundamentals | null | undefined,
  now: Date,
): AutomaticIntrinsicValue | null {
  if (!automaticValuationFundamentalsAreFresh(fundamentals, now)) return null;

  const family = classifyValuationFamily(symbol, industry);
  const epsTtm = fundamentals?.eps_ttm;
  const fcfPerShareTtm = fundamentals?.fcf_per_share_ttm;
  const bookValuePerShare = bookValuePerShareFromPersistedFundamentals(fundamentals);

  if (family === "bank") {
    if (!positiveFinite(epsTtm) || bookValuePerShare === null) return null;
  } else if (!positiveFinite(epsTtm) && !positiveFinite(fcfPerShareTtm)) {
    return null;
  }

  return calculateAutomaticIntrinsicValue(symbol, industry, {
    price: currentPrice,
    peTtm: fundamentals?.pe_ttm ?? null,
    epsTtm: positiveFinite(epsTtm) ? epsTtm : null,
    fcfPerShareTtm: positiveFinite(fcfPerShareTtm) ? fcfPerShareTtm : null,
    priceToBook: priceToBookFromPersistedFundamentals(fundamentals),
    bookValuePerShare,
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
