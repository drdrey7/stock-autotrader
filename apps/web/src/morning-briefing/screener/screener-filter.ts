import type { ScreenerRow } from "@stock-autotrader/contracts";

/**
 * Pure Screener filter/sort logic (Screener PR1 + PR2).
 * Kept side-effect free so Gainers/Losers, SMA200W filters, search and
 * column sorting are unit-testable without React.
 */
export type ScreenerFilter = "all" | "gainers" | "losers" | "above" | "near" | "below";
export type ScreenerSortKey =
  | "symbol"
  | "company"
  | "price"
  | "changePct"
  | "sma200w"
  | "smaDistance"
  | "smaAbove"
  | "smaBelow";
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
  { value: "above", label: "Above 200W" },
  { value: "near", label: "Near 200W" },
  { value: "below", label: "Below 200W" },
];

/** Preset sorts (PR2): Closest uses ABS(distance); Furthest Above/Below are
 * raw-distance extremes. Each preset maps to a (sortKey, direction) pair. */
export interface ScreenerPreset {
  key: "closest" | "furthestAbove" | "furthestBelow";
  label: string;
  sortKey: ScreenerSortKey;
  direction: ScreenerSortDirection;
}

export const SCREENER_PRESETS: ScreenerPreset[] = [
  { key: "closest", label: "Closest to 200W", sortKey: "smaDistance", direction: "asc" },
  { key: "furthestAbove", label: "Furthest above 200W", sortKey: "smaAbove", direction: "desc" },
  { key: "furthestBelow", label: "Furthest below 200W", sortKey: "smaBelow", direction: "asc" },
];

export function matchesFilter(row: ScreenerRow, filter: ScreenerFilter): boolean {
  if (filter === "gainers") return row.changePct !== null && row.changePct > 0;
  if (filter === "losers") return row.changePct !== null && row.changePct < 0;
  if (filter === "above") return row.sma200wState === "Above";
  if (filter === "near") return row.sma200wState === "Near";
  if (filter === "below") return row.sma200wState === "Below";
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
      case "sma200w":
        return compareNullableNumber(left.sma200w, right.sma200w, direction);
      case "smaDistance": {
        // Closest to 200W: ABS(distance), nulls last. asc = closest first.
        const leftAbs = left.distanceToSma200wPct === null ? null : Math.abs(left.distanceToSma200wPct);
        const rightAbs = right.distanceToSma200wPct === null ? null : Math.abs(right.distanceToSma200wPct);
        return compareNullableNumber(leftAbs, rightAbs, direction);
      }
      case "smaAbove":
        // Furthest above 200W: raw distance descending (direction fixed).
        return compareNullableNumber(left.distanceToSma200wPct, right.distanceToSma200wPct, -1);
      case "smaBelow":
        // Furthest below 200W: raw distance ascending (direction fixed).
        return compareNullableNumber(left.distanceToSma200wPct, right.distanceToSma200wPct, 1);
      default:
        return 0;
    }
  });
}
