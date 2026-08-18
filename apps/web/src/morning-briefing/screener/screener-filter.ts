import type { ScreenerRow } from "@stock-autotrader/contracts";

/**
 * Pure Screener filter/sort logic (Screener PR1). Kept side-effect free so
 * Gainers/Losers, search and column sorting are unit-testable without React.
 *
 * Future PR3 columns (Intrinsic Value, Support, MA200W, Opportunity) extend
 * the row contract, not this module — sorting/filtering stays keyed on the
 * fields already tested here.
 */
export type ScreenerFilter = "all" | "gainers" | "losers";
export type ScreenerSortKey = "symbol" | "company" | "price" | "changePct";
export type ScreenerSortDirection = "asc" | "desc";

export interface ScreenerQuery {
  filter: ScreenerFilter;
  search: string;
  sortKey: ScreenerSortKey;
  direction: ScreenerSortDirection;
}

export const DEFAULT_SCREENER_QUERY: ScreenerQuery = {
  filter: "all",
  search: "",
  sortKey: "changePct",
  direction: "desc",
};

export const SCREENER_FILTERS: Array<{ value: ScreenerFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "gainers", label: "Gainers" },
  { value: "losers", label: "Losers" },
];

export function matchesFilter(row: ScreenerRow, filter: ScreenerFilter): boolean {
  if (filter === "gainers") return row.changePct !== null && row.changePct > 0;
  if (filter === "losers") return row.changePct !== null && row.changePct < 0;
  return true;
}

export function matchesSearch(row: ScreenerRow, search: string): boolean {
  const query = search.trim().toLowerCase();
  if (!query) return true;
  return row.symbol.toLowerCase().includes(query)
    || (row.company ?? "").toLowerCase().includes(query);
}

/** Numeric comparison with nulls always sorted last, regardless of direction. */
function compareNullableNumber(left: number | null, right: number | null, direction: 1 | -1): number {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  if (left === right) return 0;
  return (left - right) * direction;
}

export function applyScreenerQuery(
  rows: readonly ScreenerRow[],
  query: ScreenerQuery,
): ScreenerRow[] {
  const direction: 1 | -1 = query.direction === "asc" ? 1 : -1;
  const filtered = rows.filter(
    (row) => matchesSearch(row, query.search) && matchesFilter(row, query.filter),
  );
  return [...filtered].sort((left, right) => {
    switch (query.sortKey) {
      case "symbol":
      case "company": {
        const leftValue = (query.sortKey === "symbol" ? left.symbol : left.company ?? "").toLowerCase();
        const rightValue = (query.sortKey === "symbol" ? right.symbol : right.company ?? "").toLowerCase();
        if (leftValue === rightValue) return 0;
        return (leftValue < rightValue ? -1 : 1) * direction;
      }
      case "price":
        return compareNullableNumber(left.price, right.price, direction);
      case "changePct":
        return compareNullableNumber(left.changePct, right.changePct, direction);
      default:
        return 0;
    }
  });
}
