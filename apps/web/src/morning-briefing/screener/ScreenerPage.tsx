import { useMemo, useState } from "react";
import { useScreener } from "./useScreener";
import { ScreenerTable } from "./ScreenerTable";
import {
  applyScreenerQuery,
  DEFAULT_SCREENER_QUERY,
  type ScreenerFilter,
  type ScreenerSortDirection,
  type ScreenerSortKey,
} from "./screener-filter";
import "./screener.css";

const marketOpen = (state: string): boolean => state === "regular";

/**
 * Lazy-loaded Screener route. Owns the search/filter/sort state;
 * the table is presentational and reads from pure screener-filter logic.
 */
export default function ScreenerPage() {
  const { data, loading, error } = useScreener();
  const [filter, setFilter] = useState<ScreenerFilter>(DEFAULT_SCREENER_QUERY.filter);
  const [search, setSearch] = useState(DEFAULT_SCREENER_QUERY.search);
  const [sortKey, setSortKey] = useState<ScreenerSortKey>(DEFAULT_SCREENER_QUERY.sortKey);
  const [sortDirection, setSortDirection] =
    useState<ScreenerSortDirection>(DEFAULT_SCREENER_QUERY.direction);

  const rows = useMemo(
    () => (data ? applyScreenerQuery(data.rows, { filter, search, sortKey, direction: sortDirection }) : []),
    [data, filter, search, sortKey, sortDirection],
  );

  const onSort = (key: ScreenerSortKey) => {
    if (key === sortKey) {
      setSortDirection((direction) => (direction === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDirection("desc");
    }
  };

  const isOpen = data ? marketOpen(data.marketState) : false;

  return (
    <div className="page-content inner-page screener-page">
      <div className="page-heading screener-heading">
        <span className="eyebrow">LIVE MARKET SCREENER</span>
        <h1>Screener</h1>
        <p>
          The 50-stock Core Universe with live market quotes during regular market hours.
        </p>
      </div>

      {data && (
        <div className="scr-market-status" aria-live="polite">
          <span className={`scr-market-badge ${isOpen ? "scr-market-open" : "scr-market-closed"}`}>
            <span className="scr-market-dot" aria-hidden="true" />
            {isOpen ? "Market Open" : "Market Closed"}
          </span>
        </div>
      )}

      {loading && !data && (
        <div className="scr-card scr-message" role="status">Loading quotes…</div>
      )}

      {error && !data && (
        <div className="scr-card scr-error" role="alert">
          Quotes are temporarily unavailable. Prices shown (if any) reflect the last known state.
        </div>
      )}

      {error && data && (
        <div className="scr-banner" role="status">
          Refresh failed — showing the last known quotes.
        </div>
      )}

      {data && (
        <ScreenerTable
          rows={rows}
          filter={filter}
          onFilterChange={setFilter}
          search={search}
          onSearchChange={setSearch}
          sortKey={sortKey}
          sortDirection={sortDirection}
          onSort={onSort}
        />
      )}
    </div>
  );
}
