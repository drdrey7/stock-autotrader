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
