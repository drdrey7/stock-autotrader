import type { ScreenerMarketState } from "@stock-autotrader/contracts";

export interface DailyChangeQuote {
  price: number;
  previous_close: number | null;
  quote_session_date?: string | null;
  previous_close_session_date?: string | null;
  daily_change_valid?: number;
}

export interface ValidDailyChange {
  changeAbs: number;
  changePct: number;
}

function isDateKey(value: string | null | undefined): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/**
 * Canonical serving rule for 1D change.
 *
 * Persisted change_abs/change_pct are never trusted. The serving layer derives
 * 1D from the current price and the persisted previous regular-session close
 * only when the quote ingestor proved the session provenance. Outside regular
 * trading, after a split boundary, or with any incomplete/pre-migration
 * provenance, 1D fails closed while the last price can still be served.
 */
export function deriveDailyChange(
  quote: DailyChangeQuote | null | undefined,
  currentMarketDate: string | null,
  marketState: ScreenerMarketState,
  latestEffectiveSplitDate?: string,
): ValidDailyChange | null {
  if (!quote || marketState !== "regular" || !isDateKey(currentMarketDate)) return null;
  if (!Number.isFinite(quote.price) || quote.price <= 0) return null;
  if (!Number.isFinite(quote.previous_close) || (quote.previous_close ?? 0) <= 0) return null;
  if (quote.daily_change_valid !== 1) return null;
  if (quote.quote_session_date !== currentMarketDate) return null;
  if (!isDateKey(quote.previous_close_session_date)) return null;
  if (quote.previous_close_session_date >= currentMarketDate) return null;

  if (
    latestEffectiveSplitDate
    && latestEffectiveSplitDate > quote.previous_close_session_date
    && latestEffectiveSplitDate <= currentMarketDate
  ) return null;

  const previousClose = quote.previous_close!;
  const changeAbs = quote.price - previousClose;
  const changePct = (quote.price / previousClose - 1) * 100;
  if (!Number.isFinite(changeAbs) || !Number.isFinite(changePct)) return null;
  return { changeAbs, changePct };
}
