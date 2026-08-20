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
    // All defined supports must be false (not triggered)
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
          // Tie-break: symbol
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
        return compareNullableNumber(left.sma200w, right.sma200w, direction);
      case "smaDistance":
        // Raw distance value (NOT ABS) — asc = more negative first, desc = more positive first
        return compareNullableNumber(
          left.distanceToSma200wPct,
          right.distanceToSma200wPct,
          direction,
        );
      default:
        return 0;
    }
  });
}
