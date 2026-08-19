import { useMemo, useState } from "react";
import { useScreener } from "./useScreener";
import { ScreenerTable } from "./ScreenerTable";
import {
  applyScreenerQuery,
  DEFAULT_SCREENER_QUERY,
  type ScreenerFilter,
  type ScreenerPreset,
  type ScreenerSortDirection,
  type ScreenerSortKey,
} from "./screener-filter";
import "./screener.css";

const MARKET_STATE_LABEL = { regular: "Open", post_close: "Post-close", closed: "Closed" } as const;

const freshCount = (data: NonNullable<ReturnType<typeof useScreener>["data"]>): number =>
  data.quotes.counts.live + data.quotes.counts.cached;

/**
 * Lazy-loaded Screener route (Screener PR1). Owns the search/filter/sort
 * state; the table is presentational and reads from pure screener-filter
 * logic. Loading, stale and unavailable states are visually distinct and no
 * mock value is ever presented as live.
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

  const onPreset = (preset: ScreenerPreset) => {
    setSortKey(preset.sortKey);
    setSortDirection(preset.direction);
  };

  return (
    <div className="page-content inner-page screener-page">
      <div className="page-heading screener-heading">
        <span className="eyebrow">LIVE MARKET SCREENER</span>
        <h1>Screener</h1>
        <p>
          The 50-stock Core Universe with latest quotes refreshed about every ten minutes
          during market hours.
        </p>
      </div>

      {data && (
        <div className="scr-summary" aria-live="polite">
          <span className="scr-summary-item">
            Market
            <b>{MARKET_STATE_LABEL[data.marketState]}</b>
          </span>
          <span className="scr-summary-item">
            Quotes
            <b className={`scr-state-text scr-state-${data.quotes.state.toLowerCase()}`}>
              {data.quotes.state}
            </b>
          </span>
          <span className="scr-summary-item">
            Fresh
            <b>{freshCount(data)}/{data.universe.total}</b>
          </span>
          {data.quotes.counts.stale > 0 && (
            <span className="scr-summary-item">
              Stale
              <b className="scr-state-text scr-state-stale">{data.quotes.counts.stale}</b>
            </span>
          )}
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
          onPreset={onPreset}
        />
      )}
    </div>
  );
}
