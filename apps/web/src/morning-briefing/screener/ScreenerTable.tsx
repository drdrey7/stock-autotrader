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

const supportPriceFormatter = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

function formatSupportPrice(value: number): string {
  return Number.isInteger(value) ? String(value) : supportPriceFormatter.format(value);
}

function getSupportLevel(row: ScreenerRow, level: number): ScreenerSupportLevel | undefined {
  return row.supportLevels.find((support) => support.level === level);
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

const ivPriceFormatter = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

function formatIVPrice(value: number | null): string {
  if (value === null) return "—";
  return Number.isInteger(value) ? String(value) : ivPriceFormatter.format(value);
}

function ivCell(row: ScreenerRow): ReactNode {
  const intrinsicValue = row.intrinsicValue;
  if (!intrinsicValue) return <span className="scr-flat">—</span>;
  return <span className="scr-price">{formatIVPrice(intrinsicValue.base)}</span>;
}

function ivDistanceCell(row: ScreenerRow): ReactNode {
  const intrinsicValue = row.intrinsicValue;
  if (!intrinsicValue || intrinsicValue.distancePct === null) {
    return <span className="scr-flat">—</span>;
  }
  const className = intrinsicValue.distancePct < 0
    ? "scr-up"
    : intrinsicValue.distancePct > 0
      ? "scr-down"
      : "scr-flat";
  return <span className={className}>{formatSigned(intrinsicValue.distancePct, 2)}%</span>;
}

function distanceCell(row: ScreenerRow): ReactNode {
  const distance = row.distanceToSma200wPct ?? null;
  if (distance === null) return <span className="scr-flat">—</span>;
  const state = row.sma200wState ?? "Unavailable";
  const className = state === "Above" ? "scr-up" : state === "Below" ? "scr-down" : "scr-near";
  return <span className={className} title={state}>{formatSigned(distance, 1)}%</span>;
}

function smaCell(row: ScreenerRow): ReactNode {
  const sma = row.sma200w ?? null;
  if (sma === null) {
    return <span className="scr-flat" title={row.sma200wState === "NotEnoughHistory" ? "Fewer than 199 completed weeks" : undefined}>—</span>;
  }
  return <span className="scr-price">{sma.toFixed(2)}</span>;
}

function sortIndicator(
  label: string,
  active: boolean,
  direction: ScreenerSortDirection,
  onClick: () => void,
): ReactNode {
  return (
    <button className={`scr-sort ${active ? "scr-sort-active" : ""}`} type="button" onClick={onClick}>
      {label}
      <span className="scr-sort-arrow" aria-hidden="true">
        {active ? (direction === "asc" ? "↑" : "↓") : ""}
      </span>
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
  const filtersButtonRef = useRef<HTMLButtonElement>(null);
  const filterOptionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const bodyScrollRef = useRef<HTMLDivElement>(null);
  const headScrollRef = useRef<HTMLDivElement>(null);

  const closeFilters = useCallback((restoreFocus = false) => {
    setFiltersOpen(false);
    if (restoreFocus) filtersButtonRef.current?.focus();
  }, []);

  const handleClickOutside = useCallback((event: MouseEvent) => {
    if (filtersContainerRef.current && !filtersContainerRef.current.contains(event.target as Node)) {
      setFiltersOpen(false);
    }
  }, []);

  useEffect(() => {
    if (!filtersOpen) return;
    filterOptionRefs.current[0]?.focus();
  }, [filtersOpen]);

  useEffect(() => {
    if (!filtersOpen) return;
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [filtersOpen, handleClickOutside]);

  const handleFilterMenuKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    const currentIndex = filterOptionRefs.current.findIndex((option) => option === document.activeElement);
    if (event.key === "Escape") {
      event.preventDefault();
      closeFilters(true);
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const lastIndex = SCREENER_FILTERS.length - 1;
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? lastIndex
        : event.key === "ArrowDown"
          ? Math.min(currentIndex + 1, lastIndex)
          : Math.max(currentIndex - 1, 0);
    filterOptionRefs.current[nextIndex]?.focus();
  }, [closeFilters]);

  const handleFilterSelection = useCallback((value: ScreenerFilter) => {
    onFilterChange(value);
    closeFilters(true);
  }, [closeFilters, onFilterChange]);

  const handleBodyScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    const scrollLeft = event.currentTarget.scrollLeft;
    // Header is not inside body scroller. Move only its non-sticky cells.
    headScrollRef.current?.style.setProperty("--scr-head-scroll-left", `${scrollLeft}px`);
    setScrolled((previous) => {
      if (previous && scrollLeft < 8) return false;
      if (!previous && scrollLeft > 20) return true;
      return previous;
    });
  }, []);

  const activeFilterLabel = SCREENER_FILTERS.find((entry) => entry.value === filter)?.label ?? "All";
  const getAriaSort = (key: ScreenerSortKey) => {
    if (sortKey !== key) return undefined;
    return sortDirection === "asc" ? "ascending" : "descending";
  };

  return (
    <div
      className={`scr-card scr-table-region${scrolled ? " scr-table-scrolled" : ""}`}
      role="table"
      aria-label="Screener results"
      aria-colcount={11}
    >
      <div className="scr-toolbar">
        <div className="scr-toolbar-left">
          <div className="scr-filters-container" ref={filtersContainerRef}>
            <button
              ref={filtersButtonRef}
              type="button"
              className="scr-filters-btn"
              aria-haspopup="true"
              aria-controls="scr-filters-menu"
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
                  onClick={() => {
                    onFilterChange("all");
                    closeFilters();
                  }}
                >
                  ×
                </button>
              </span>
            )}
            {filtersOpen && (
              <div
                id="scr-filters-menu"
                className="scr-filters-popover"
                role="menu"
                aria-label="Screener filters"
                onKeyDown={handleFilterMenuKeyDown}
              >
                {SCREENER_FILTERS.map(({ value, label }, index) => (
                  <button
                    key={value}
                    ref={(element) => {
                      filterOptionRefs.current[index] = element;
                    }}
                    type="button"
                    role="menuitem"
                    className={`scr-filter-option ${filter === value ? "scr-filter-option-active" : ""}`}
                    onClick={() => handleFilterSelection(value)}
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

      <div className="scr-table-head-shell" role="rowgroup">
        <div className="scr-table-head-scroll" ref={headScrollRef}>
          <div className="scr-grid-row scr-table-head-grid" role="row">
            <div className="scr-head-cell scr-col-company" role="columnheader" aria-sort={getAriaSort("company")}>
              {sortIndicator("Company", sortKey === "company", sortDirection, () => onSort("company"))}
            </div>
            <div className="scr-head-cell scr-col-price scr-align-right" role="columnheader" aria-sort={getAriaSort("price")}>
              {sortIndicator("Price", sortKey === "price", sortDirection, () => onSort("price"))}
            </div>
            <div className="scr-head-cell scr-col-1d scr-align-right" role="columnheader" aria-sort={getAriaSort("changePct")}>
              {sortIndicator("1D", sortKey === "changePct", sortDirection, () => onSort("changePct"))}
            </div>
            <div className="scr-head-cell scr-col-iv scr-align-right" role="columnheader" aria-sort={getAriaSort("iv")}>
              {sortIndicator("IV", sortKey === "iv", sortDirection, () => onSort("iv"))}
            </div>
            <div className="scr-head-cell scr-col-iv-dist scr-align-right" role="columnheader" aria-sort={getAriaSort("ivDistance")}>
              {sortIndicator("IV Dist", sortKey === "ivDistance", sortDirection, () => onSort("ivDistance"))}
            </div>
            <div className="scr-head-cell scr-col-sma scr-align-right" role="columnheader" aria-sort={getAriaSort("sma200w")}>
              {sortIndicator("200W SMA", sortKey === "sma200w", sortDirection, () => onSort("sma200w"))}
            </div>
            <div className="scr-head-cell scr-col-sma-dist scr-align-right" role="columnheader" aria-sort={getAriaSort("smaDistance")}>
              {sortIndicator("SMA Dist", sortKey === "smaDistance", sortDirection, () => onSort("smaDistance"))}
            </div>
            <div className="scr-head-cell scr-col-s1 scr-align-right" role="columnheader">S1</div>
            <div className="scr-head-cell scr-col-s2 scr-align-right" role="columnheader">S2</div>
            <div className="scr-head-cell scr-col-s3 scr-align-right" role="columnheader">S3</div>
            <div className="scr-head-cell scr-col-s4 scr-align-right" role="columnheader">S4</div>
          </div>
        </div>
      </div>

      <div className="scr-table-body-scroll" ref={bodyScrollRef} onScroll={handleBodyScroll}>
        <div className="scr-table-body" role="rowgroup">
          {rows.length === 0 ? (
            <div className="scr-grid-row scr-empty-row" role="row">
              <div className="scr-empty" role="cell" aria-colspan={11}>No matching stocks.</div>
            </div>
          ) : rows.map((row) => (
            <div className="scr-grid-row scr-body-row" role="row" key={row.symbol}>
              <div className="scr-cell scr-col-company" role="cell">
                <span className="scr-company">
                  <CompanyLogo symbol={row.symbol} logoUrl={row.logoUrl} className="scr-company-logo" size={24} />
                  <span className="scr-company-text">
                    <b>{row.symbol}</b>
                    <small>{row.company ?? "—"}</small>
                  </span>
                </span>
              </div>
              <div className="scr-cell scr-col-price scr-align-right" role="cell">
                <span className="scr-price">{row.price === null ? "—" : row.price.toFixed(2)}</span>
              </div>
              <div className="scr-cell scr-col-1d scr-align-right" role="cell">
                <span className={changeClass(row)}>{formatSigned(row.changePct)}%</span>
              </div>
              <div className="scr-cell scr-col-iv scr-align-right" role="cell">{ivCell(row)}</div>
              <div className="scr-cell scr-col-iv-dist scr-align-right" role="cell">{ivDistanceCell(row)}</div>
              <div className="scr-cell scr-col-sma scr-align-right" role="cell">{smaCell(row)}</div>
              <div className="scr-cell scr-col-sma-dist scr-align-right" role="cell">{distanceCell(row)}</div>
              <div className="scr-cell scr-col-s1 scr-align-right" role="cell">{supportCell(row, 1)}</div>
              <div className="scr-cell scr-col-s2 scr-align-right" role="cell">{supportCell(row, 2)}</div>
              <div className="scr-cell scr-col-s3 scr-align-right" role="cell">{supportCell(row, 3)}</div>
              <div className="scr-cell scr-col-s4 scr-align-right" role="cell">{supportCell(row, 4)}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
