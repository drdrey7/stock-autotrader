import {
  calculateAutomaticIntrinsicValue,
  intrinsicValueDistancePct,
  type AutomaticIntrinsicValue,
  type AutomaticValuationMethod,
  type MultipleHistoryInput,
  type ScreenerIntrinsicValue,
} from "@stock-autotrader/contracts";

/**
 * Minimal last-known-good snapshot consumed by Automatic IV V2. There is
 * deliberately no freshness TTL: these are slow-moving accounting facts, and a
 * failed/offline ingestor must not make intrinsic value disappear from serving.
 */
export interface AutomaticValuationFundamentals {
  eps_ttm?: number | null;
  fcf_per_share_ttm?: number | null;
  revenue_per_share_ttm?: number | null;
  book_value_per_share?: number | null;
  revenue_growth_ttm_yoy_pct?: number | null;
  revenue_growth_3y_pct?: number | null;
  revenue_growth_5y_pct?: number | null;
  roe_ttm_pct?: number | null;
  roic_pct?: number | null;
  fcf_margin_pct?: number | null;
  debt_to_equity?: number | null;
  pe_5y_p25?: number | null;
  pe_5y_median?: number | null;
  pe_5y_p75?: number | null;
  pe_5y_samples?: number | null;
  pe_5y_as_of?: string | null;
  pfcf_5y_p25?: number | null;
  pfcf_5y_median?: number | null;
  pfcf_5y_p75?: number | null;
  pfcf_5y_samples?: number | null;
  pfcf_5y_as_of?: string | null;
  ps_5y_p25?: number | null;
  ps_5y_median?: number | null;
  ps_5y_p75?: number | null;
  ps_5y_samples?: number | null;
  ps_5y_as_of?: string | null;
  pb_5y_p25?: number | null;
  pb_5y_median?: number | null;
  pb_5y_p75?: number | null;
  pb_5y_samples?: number | null;
  pb_5y_as_of?: string | null;
  market_as_of?: string | null;
  market_checked_at?: string | null;
  updated_at?: string | null;
}

export interface AutomaticValuationSplitEvent {
  effective_date: string;
  split_factor: number;
}

export type AutomaticIntrinsicValueWithAsOf = AutomaticIntrinsicValue & { asOf: string };

function finite(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function positiveFinite(value: number | null | undefined): value is number {
  return finite(value) && value > 0;
}

function marketDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const direct = /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : value.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(direct)) return null;
  const parsed = Date.parse(`${direct}T00:00:00.000Z`);
  return Number.isFinite(parsed) ? direct : null;
}

function history(
  fundamentals: AutomaticValuationFundamentals,
  prefix: "pe" | "pfcf" | "ps" | "pb",
): MultipleHistoryInput {
  switch (prefix) {
    case "pe":
      return { p25: fundamentals.pe_5y_p25 ?? null, median: fundamentals.pe_5y_median ?? null, p75: fundamentals.pe_5y_p75 ?? null, samples: fundamentals.pe_5y_samples ?? null };
    case "pfcf":
      return { p25: fundamentals.pfcf_5y_p25 ?? null, median: fundamentals.pfcf_5y_median ?? null, p75: fundamentals.pfcf_5y_p75 ?? null, samples: fundamentals.pfcf_5y_samples ?? null };
    case "ps":
      return { p25: fundamentals.ps_5y_p25 ?? null, median: fundamentals.ps_5y_median ?? null, p75: fundamentals.ps_5y_p75 ?? null, samples: fundamentals.ps_5y_samples ?? null };
    case "pb":
      return { p25: fundamentals.pb_5y_p25 ?? null, median: fundamentals.pb_5y_median ?? null, p75: fundamentals.pb_5y_p75 ?? null, samples: fundamentals.pb_5y_samples ?? null };
  }
}

/** Latest factual date carried by the snapshot; used for transparency and split adjustment. */
export function automaticValuationAsOfDate(
  fundamentals: AutomaticValuationFundamentals | null | undefined,
): string | null {
  if (!fundamentals) return null;
  for (const value of [fundamentals.market_checked_at, fundamentals.market_as_of, fundamentals.updated_at]) {
    const parsed = marketDate(value);
    if (parsed) return parsed;
  }
  const historyDates = [
    fundamentals.pe_5y_as_of,
    fundamentals.pfcf_5y_as_of,
    fundamentals.ps_5y_as_of,
    fundamentals.pb_5y_as_of,
  ].map(marketDate).filter((value): value is string => value !== null);
  return historyDates.sort().at(-1) ?? null;
}

/**
 * Cumulative post-snapshot split factor. Multiples are scale invariant, so only
 * the per-share anchors need adjustment when a split became effective after the
 * last persisted fundamentals snapshot.
 */
export function automaticValuationSplitFactor(
  fundamentalsAsOf: string,
  currentMarketDate: string,
  splitEvents: readonly AutomaticValuationSplitEvent[],
): number {
  let factor = 1;
  for (const event of splitEvents) {
    if (event.effective_date <= fundamentalsAsOf || event.effective_date > currentMarketDate) continue;
    if (!positiveFinite(event.split_factor)) continue;
    factor *= event.split_factor;
    if (!positiveFinite(factor)) return 1;
  }
  return factor;
}

function adjustedPerShare(value: number | null | undefined, splitFactor: number): number | null {
  if (!finite(value)) return null;
  const adjusted = value / splitFactor;
  return Number.isFinite(adjusted) ? adjusted : null;
}

/**
 * Canonical Worker adapter. No provider calls, no persistence, no age cutoff.
 * If the VPS is offline, D1 keeps the previous snapshot and this function keeps
 * returning the same IV until the underlying accounting facts change.
 */
export function calculateAutomaticIntrinsicValueFromPersistedFundamentals(
  symbol: string,
  industry: string | null,
  currentPrice: number | null,
  fundamentals: AutomaticValuationFundamentals | null | undefined,
  splitEvents: readonly AutomaticValuationSplitEvent[],
  currentMarketDate: string,
): AutomaticIntrinsicValueWithAsOf | null {
  if (!fundamentals) return null;
  const asOf = automaticValuationAsOfDate(fundamentals);
  if (!asOf) return null;
  const splitFactor = automaticValuationSplitFactor(asOf, currentMarketDate, splitEvents);

  const calculated = calculateAutomaticIntrinsicValue(symbol, industry, {
    price: currentPrice,
    epsTtm: adjustedPerShare(fundamentals.eps_ttm, splitFactor),
    fcfPerShareTtm: adjustedPerShare(fundamentals.fcf_per_share_ttm, splitFactor),
    revenuePerShareTtm: adjustedPerShare(fundamentals.revenue_per_share_ttm, splitFactor),
    bookValuePerShare: adjustedPerShare(fundamentals.book_value_per_share, splitFactor),
    revenueGrowthTtmYoyPct: fundamentals.revenue_growth_ttm_yoy_pct ?? null,
    revenueGrowth3yPct: fundamentals.revenue_growth_3y_pct ?? null,
    revenueGrowth5yPct: fundamentals.revenue_growth_5y_pct ?? null,
    roeTtmPct: fundamentals.roe_ttm_pct ?? null,
    roicPct: fundamentals.roic_pct ?? null,
    fcfMarginPct: fundamentals.fcf_margin_pct ?? null,
    debtToEquity: fundamentals.debt_to_equity ?? null,
    peHistory: history(fundamentals, "pe"),
    pfcfHistory: history(fundamentals, "pfcf"),
    psHistory: history(fundamentals, "ps"),
    pbHistory: history(fundamentals, "pb"),
  });
  return calculated ? { ...calculated, asOf } : null;
}

function methodSlug(methods: readonly AutomaticValuationMethod[]): string {
  return methods.map((method) => method.toLowerCase().replaceAll("/", "-")).join("+");
}

/** Convert one automatic valuation into the Screener's existing selected-IV contract. */
export function automaticIntrinsicValueForScreener(
  automatic: AutomaticIntrinsicValueWithAsOf | null,
  currentPrice: number | null,
): ScreenerIntrinsicValue | null {
  if (!automatic) return null;
  return {
    low: automatic.bear,
    base: automatic.base,
    high: automatic.bull,
    method: `automatic-${methodSlug(automatic.methods)}`,
    asOf: automatic.asOf,
    distancePct: intrinsicValueDistancePct(currentPrice, automatic.base),
  };
}
