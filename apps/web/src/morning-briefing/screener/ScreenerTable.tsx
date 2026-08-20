import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { ScreenerRow, ScreenerSupportLevel } from "@stock-autotrader/contracts";
import { CompanyLogo } from "../EarningsLogo";
import { SCREENER_FILTERS } from "./screener-filter";
import type {
  ScreenerFilter,
  ScreenerSortDirection,
  ScreenerSortKey,
} from "./screener-filter";
import "./screener.css";

const isUp = (row: ScreenerRow): boolean | null => row.changePct === null ? null : row.changePct > 0;

function changeClass(row: ScreenerRow): string {
  const up = isUp(row);
  if (up === null) return "scr-flat";
  return up ? "scr-up" : "scr-down";
}

function formatSigned(value: number | null, digits = 2): string {
  if (value === null) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(digits)}`;
}

/** Compact support price: max 2 decimals, strip trailing zeros. */
const supportPriceFormatter = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

function formatSupportPrice(value: number): string {
  return Number.isInteger(value) ? String(value) : supportPriceFormatter.format(value);
}

function getSupportLevel(row: ScreenerRow, level: number): ScreenerSupportLevel | undefined {
  return row.supportLevels.find((s) => s.level === level);
}

function supportCell(row: ScreenerRow, level: number): ReactNode {
  const support = getSupportLevel(row, level);
  if (!support) return <span className="scr-flat">—</span>;
  if (support.triggered === true) {
    return (
      <span className="scr-support-pill" title={`S${level} triggered`}>
        {formatSupportPrice(support.price)}
      </span>
    );
  }
  return <span className="scr-support">{formatSupportPrice(support.price)}</span>;
}

/** Format IV base: max 2 decimals, strip trailing zeros. */
const ivPriceFormatter = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

function formatIVPrice(value: number | null): string {
  if (value === null) return "—";
  return Number.isInteger(value) ? String(value) : ivPriceFormatter.format(value);
}

function ivCell(row: ScreenerRow): ReactNode {
  const iv = row.intrinsicValue;
  if (!iv) return <span className="scr-flat">—</span>;
  return <span className="scr-price">{formatIVPrice(iv.base)}</span>;
}

function ivDistanceCell(row: ScreenerRow): ReactNode {
  const iv = row.intrinsicValue;
  if (!iv || iv.distancePct === null) return <span className="scr-flat">—</span>;
  const cls = iv.distancePct < 0 ? "scr-up" : iv.distancePct > 0 ? "scr-down" : "scr-flat";
  return (
    <span className={cls}>
      {formatSigned(iv.distancePct, 2)}%
    </span>
  );
}

/** Distance display + state color. Full-precision value, 1-decimal display. */
function distanceCell(row: ScreenerRow): ReactNode {
  const distance = row.distanceToSma200wPct ?? null;
  if (distance === null) return <span className="scr-flat">—</span>;
  const state = row.sma200wState ?? "Unavailable";
  const cls = state === "Above" ? "scr-up" : state === "Below" ? "scr-down" : "scr-near";
  return (
    <span className={cls} title={state}>
      {formatSigned(distance, 1)}%
    </span>
  );
}

function smaCell(row: ScreenerRow): ReactNode {
  const sma = row.sma200w ?? null;
  if (sma === null) {
    return row.sma200wState === "NotEnoughHistory"
      ? <span className="scr-flat" title="Fewer than 199 completed weeks">—</span>
      : <span className="scr-flat">—</span>;
  }
  return <span className="scr-price">{sma.toFixed(2)}</span>;
}

function sortIndicator(label: string, active: boolean, direction: ScreenerSortDirection, onClick: () => void): ReactNode {
  return (
    <button
      className={`scr-sort ${active ? "scr-sort-active" : ""}`}
      type="button"
      onClick={onClick}
    >
      {label}
      <span className="scr-sort-arrow">{active ? (direction === "asc" ? "↑" : "↓") : ""}</span>
    </button>
  );
}

interface ScreenerTableProps {
  rows: ScreenerRow[];
  filter: ScreenerFilter;
  onFilterChange: (filter: ScreenerFilter) => void;
  search: string;
  onSearchChange: (search: string) => void;
  sortKey: ScreenerSortKey;
  sortDirection: ScreenerSortDirection;
  onSort: (key: ScreenerSortKey) => void;
}

/**
 * Premium, responsive Screener table.
 * All 11 columns visible on both desktop and mobile. Horizontal scroll on mobile.
 * Company + Price are sticky. Sortable via headers (except S1-S4).
 * Company column contracts on mobile during horizontal scroll to free width.
 */
export function ScreenerTable({
  rows,
  filter,
  onFilterChange,
  search,
  onSearchChange,
  sortKey,
  sortDirection,
  onSort,
}: ScreenerTableProps) {
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const filtersContainerRef = useRef<HTMLDivElement>(null);

  // Close popover on outside click — ref covers button + chip + popover
  const handleClickOutside = useCallback((event: MouseEvent) => {
    if (filtersContainerRef.current && !filtersContainerRef.current.contains(event.target as Node)) {
      setFiltersOpen(false);
    }
  }, []);

  useEffect(() => {
    if (!filtersOpen) return;
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [filtersOpen, handleClickOutside]);

  // Mobile: detect horizontal scroll to compact company column (boolean only, hysteresis)
  const handleScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    const scrollLeft = event.currentTarget.scrollLeft;
    setScrolled(prev => {
      if (prev && scrollLeft < 8) return false;
      if (!prev && scrollLeft > 20) return true;
      return prev;
    });
  }, []);

  const activeFilterLabel = SCREENER_FILTERS.find((f) => f.value === filter)?.label ?? "All";

  const getAriaSort = (key: ScreenerSortKey) => {
    if (sortKey !== key) return undefined;
    return sortDirection === "asc" ? "ascending" : "descending";
  };

  return (
    <div className="scr-card">
      <div className="scr-toolbar">
        <div className="scr-toolbar-left">
          <div className="scr-filters-container" ref={filtersContainerRef}>
            <button
              type="button"
              className="scr-filters-btn"
              aria-haspopup="true"
              aria-expanded={filtersOpen}
              onClick={() => setFiltersOpen((open) => !open)}
            >
              Filters
              <span className="scr-filters-caret" aria-hidden="true">▾</span>
            </button>
            {filter !== "all" && (
              <span className="scr-active-filter-chip">
                {activeFilterLabel}
                <button
                  type="button"
                  className="scr-clear-filter-btn"
                  aria-label={`Clear ${activeFilterLabel} filter`}
                  onClick={() => onFilterChange("all")}
                >
                  ×
                </button>
              </span>
            )}
            {filtersOpen && (
              <div className="scr-filters-popover" role="menu" aria-label="Screener filters">
                {SCREENER_FILTERS.map(({ value, label }) => (
                  <button
                    key={value}
                    type="button"
                    role="menuitem"
                    className={`scr-filter-option ${filter === value ? "scr-filter-option-active" : ""}`}
                    onClick={() => {
                      onFilterChange(value);
                      setFiltersOpen(false);
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="scr-toolbar-right">
          <input
            className="scr-search"
            type="search"
            aria-label="Search stocks"
            placeholder="Search stocks…"
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
          />
        </div>
      </div>

      <div className={`scr-table-wrap${scrolled ? " scr-table-scrolled" : ""}`} onScroll={handleScroll}>
        <table className="scr-table">
          <thead>
            <tr>
              <th className="scr-col-company" aria-sort={getAriaSort("symbol")}>
                {sortIndicator("Company", sortKey === "symbol", sortDirection, () => onSort("symbol"))}
              </th>
              <th className="scr-col-price scr-align-right" aria-sort={getAriaSort("price")}>
                {sortIndicator("Price", sortKey === "price", sortDirection, () => onSort("price"))}
              </th>
              <th className="scr-col-1d scr-align-right" aria-sort={getAriaSort("changePct")}>
                {sortIndicator("1D", sortKey === "changePct", sortDirection, () => onSort("changePct"))}
              </th>
              <th className="scr-col-iv scr-align-right" aria-sort={getAriaSort("iv")}>
                {sortIndicator("IV", sortKey === "iv", sortDirection, () => onSort("iv"))}
              </th>
              <th className="scr-col-iv-dist scr-align-right" aria-sort={getAriaSort("ivDistance")}>
                {sortIndicator("IV Dist", sortKey === "ivDistance", sortDirection, () => onSort("ivDistance"))}
              </th>
              <th className="scr-col-sma scr-align-right" aria-sort={getAriaSort("sma200w")}>
                {sortIndicator("200W SMA", sortKey === "sma200w", sortDirection, () => onSort("sma200w"))}
              </th>
              <th className="scr-col-sma-dist scr-align-right" aria-sort={getAriaSort("smaDistance")}>
                {sortIndicator("SMA Dist", sortKey === "smaDistance", sortDirection, () => onSort("smaDistance"))}
              </th>
              <th className="scr-col-s1 scr-align-right">S1</th>
              <th className="scr-col-s2 scr-align-right">S2</th>
              <th className="scr-col-s3 scr-align-right">S3</th>
              <th className="scr-col-s4 scr-align-right">S4</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={11} className="scr-empty">
                  No matching stocks.
                </td>
              </tr>
            ) : rows.map((row) => (
              <tr key={row.symbol}>
                <td className="scr-col-company scr-sticky-left">
                  <span className="scr-company">
                    <CompanyLogo symbol={row.symbol} logoUrl={row.logoUrl} className="scr-company-logo" size={24} />
                    <span className="scr-company-text">
                      <b>{row.symbol}</b>
                      <small>{row.company ?? "—"}</small>
                    </span>
                  </span>
                </td>
                <td className="scr-col-price scr-align-right scr-sticky-price">
                  <span className="scr-price">{row.price === null ? "—" : row.price.toFixed(2)}</span>
                </td>
                <td className="scr-col-1d scr-align-right">
                  <span className={changeClass(row)}>{formatSigned(row.changePct)}%</span>
                </td>
                <td className="scr-col-iv scr-align-right">{ivCell(row)}</td>
                <td className="scr-col-iv-dist scr-align-right">{ivDistanceCell(row)}</td>
                <td className="scr-col-sma scr-align-right">{smaCell(row)}</td>
                <td className="scr-col-sma-dist scr-align-right">{distanceCell(row)}</td>
                <td className="scr-col-s1 scr-align-right">{supportCell(row, 1)}</td>
                <td className="scr-col-s2 scr-align-right">{supportCell(row, 2)}</td>
                <td className="scr-col-s3 scr-align-right">{supportCell(row, 3)}</td>
                <td className="scr-col-s4 scr-align-right">{supportCell(row, 4)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
