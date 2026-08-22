/**
 * Lightweight price-sensitive derived metrics computed at serving time.
 * These combine the persisted fundamental snapshot with the current quote.
 */

export function computeMarketCap(price: number | null, sharesOutstanding: number | null): number | null {
  if (price === null || sharesOutstanding === null || price <= 0 || sharesOutstanding <= 0) return null;
  return price * sharesOutstanding;
}

export function computePeTtm(price: number | null, dilutedEpsTtm: number | null): number | null {
  if (price === null || dilutedEpsTtm === null || dilutedEpsTtm <= 0) return null;
  return price / dilutedEpsTtm;
}

export interface FundamentalSplitEvent {
  readonly effective_date: string;
  readonly split_factor: number;
}

/**
 * Return the cumulative split factor needed to move a fundamental period's
 * shares/EPS onto today's quote scale. A missing period end cannot establish
 * compatibility once any split exists, so the price-sensitive metrics fail
 * closed instead of mixing pre- and post-split units.
 */
export function splitAdjustmentFactorForPeriod(
  periodEnd: string | null,
  effectiveSplits: readonly FundamentalSplitEvent[],
): number | null {
  if (effectiveSplits.length === 0) return 1;
  if (!periodEnd) return null;
  let factor = 1;
  for (const split of effectiveSplits) {
    if (split.effective_date <= periodEnd) continue;
    if (!Number.isFinite(split.split_factor) || split.split_factor <= 0) return null;
    factor *= split.split_factor;
    if (!Number.isFinite(factor) || factor <= 0) return null;
  }
  return factor;
}
