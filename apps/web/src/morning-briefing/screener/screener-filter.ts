import type { ScreenerRow } from "@stock-autotrader/contracts";

/**
 * Pure Screener filter/sort logic (Responsive UX PR).
 * Kept side-effect free so filters, search and column sorting are
 * unit-testable without React.
 */
export type ScreenerFilter =
  | "all"
  | "gainers"
  | "losers"
  | "belowIv"
  | "aboveIv"
  | "above200w"
  | "near200w"
  | "below200w"
  | "belowSupport"
  | "aboveSupport";

export type ScreenerSortKey =
  | "symbol"
  | "company"
  | "price"
  | "changePct"
  | "iv"
  | "ivDistance"
  | "sma200w"
  | "smaDistance";

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
  { value: "belowIv", label: "Below IV" },
  { value: "aboveIv", label: "Above IV" },
  { value: "above200w", label: "Above 200W" },
  { value: "near200w", label: "Near 200W" },
  { value: "below200w", label: "Below 200W" },
  { value: "belowSupport", label: "Below Support" },
  { value: "aboveSupport", label: "Above Support" },
];

const SCREENER_SORT_KEYS: readonly ScreenerSortKey[] = [
  "symbol",
  "company",
  "price",
  "changePct",
  "iv",
  "ivDistance",
  "sma200w",
  "smaDistance",
];

/** Safely reads Screener query context forwarded through React Router state. */
export function screenerQueryFromNavigationState(state: unknown): ScreenerQuery | null {
  if (typeof state !== "object" || state === null || !("screenerQuery" in state)) return null;
  const query = (state as { screenerQuery?: unknown }).screenerQuery;
  if (typeof query !== "object" || query === null) return null;
  const candidate = query as Partial<ScreenerQuery>;
  if (!SCREENER_FILTERS.some(({ value }) => value === candidate.filter)) return null;
  if (typeof candidate.search !== "string") return null;
  if (!SCREENER_SORT_KEYS.includes(candidate.sortKey as ScreenerSortKey)) return null;
  if (candidate.direction !== "asc" && candidate.direction !== "desc") return null;
  return {
    filter: candidate.filter as ScreenerFilter,
    search: candidate.search,
    sortKey: candidate.sortKey as ScreenerSortKey,
    direction: candidate.direction,
  };
}

export function matchesFilter(row: ScreenerRow, filter: ScreenerFilter): boolean {
  if (filter === "gainers") return row.changePct !== null && row.changePct > 0;
  if (filter === "losers") return row.changePct !== null && row.changePct < 0;
  if (filter === "belowIv") {
    const iv = row.intrinsicValue;
    return iv !== null && iv.distancePct !== null && iv.distancePct < 0;
  }
  if (filter === "aboveIv") {
    const iv = row.intrinsicValue;
    return iv !== null && iv.distancePct !== null && iv.distancePct > 0;
  }
  if (filter === "above200w") return row.sma200wState === "Above";
  if (filter === "near200w") return row.sma200wState === "Near";
  if (filter === "below200w") return row.sma200wState === "Below";
  if (filter === "belowSupport") {
    if (row.supportLevels.length === 0) return false;
    if (row.price === null) return false;
    return row.supportLevels.some((s) => s.triggered === true);
  }
  if (filter === "aboveSupport") {
    if (row.supportLevels.length === 0) return false;
    if (row.price === null) return false;
    return row.supportLevels.every((s) => s.triggered === false);
  }
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
      case "symbol": {
        const leftValue = left.symbol.toLowerCase();
        const rightValue = right.symbol.toLowerCase();
        if (leftValue === rightValue) return 0;
        return (leftValue < rightValue ? -1 : 1) * direction;
      }
      case "company": {
        const leftValue = (left.company ?? left.symbol).toLowerCase();
        const rightValue = (right.company ?? right.symbol).toLowerCase();
        if (leftValue === rightValue) {
          const leftSym = left.symbol.toLowerCase();
          const rightSym = right.symbol.toLowerCase();
          if (leftSym === rightSym) return 0;
          return (leftSym < rightSym ? -1 : 1) * direction;
        }
        return (leftValue < rightValue ? -1 : 1) * direction;
      }
      case "price":
        return compareNullableNumber(left.price, right.price, direction);
      case "changePct":
        return compareNullableNumber(left.changePct, right.changePct, direction);
      case "iv":
        return compareNullableNumber(
          left.intrinsicValue?.base ?? null,
          right.intrinsicValue?.base ?? null,
          direction,
        );
      case "ivDistance":
        return compareNullableNumber(
          left.intrinsicValue?.distancePct ?? null,
          right.intrinsicValue?.distancePct ?? null,
          direction,
        );
      case "sma200w":
        return compareNullableNumber(left.sma200w ?? null, right.sma200w ?? null, direction);
      case "smaDistance":
        return compareNullableNumber(
          left.distanceToSma200wPct ?? null,
          right.distanceToSma200wPct ?? null,
          direction,
        );
      default:
        return 0;
    }
  });
}