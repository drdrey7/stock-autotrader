import type { ReactNode } from "react";
import type { ScreenerRow } from "@stock-autotrader/contracts";
import { SCREENER_FILTERS } from "./screener-filter";
import type { ScreenerFilter, ScreenerSortDirection, ScreenerSortKey } from "./screener-filter";
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

function stateLabel(row: ScreenerRow): string {
  if (row.state === "Live") return "Live";
  // Neutral label: Cached applies both to a closed market and to the
  // market-open grace window (the sweep has not refreshed this symbol yet),
  // so "Market closed" would be wrong during the first 10 minutes of a
  // session. The actual market state is shown in the summary chips.
  if (row.state === "Cached") return "Cached";
  if (row.state === "Stale") return "Stale";
  if (row.state === "Error") return "Error";
  return "Unavailable";
}

export interface ScreenerColumn {
  key: string;
  label: ReactNode;
  alignRight?: boolean;
  render: (row: ScreenerRow) => ReactNode;
}

/**
 * Column-driven table so PR3 (Intrinsic Value, Support, MA200W, Opportunity)
 * only appends a column config — no component rewrite.
 */
const buildColumns = (
  onSort: (key: ScreenerSortKey) => void,
  sortKey: ScreenerSortKey,
  sortDirection: ScreenerSortDirection,
): ScreenerColumn[] => [
  {
    key: "symbol",
    label: sortIndicator("Ticker", sortKey === "symbol", sortDirection, () => onSort("symbol")),
    render: (row) => (
      <span className="scr-company">
        <b>{row.symbol}</b>
        <small>{row.company ?? "—"}</small>
      </span>
    ),
  },
  {
    key: "price",
    label: sortIndicator("Price", sortKey === "price", sortDirection, () => onSort("price")),
    alignRight: true,
    render: (row) => <span className="scr-price">{row.price === null ? "—" : row.price.toFixed(2)}</span>,
  },
  {
    key: "changeAbs",
    label: "Chg $",
    alignRight: true,
    render: (row) => <span className={changeClass(row)}>{formatSigned(row.changeAbs)}</span>,
  },
  {
    key: "changePct",
    label: sortIndicator("Chg %", sortKey === "changePct", sortDirection, () => onSort("changePct")),
    alignRight: true,
    render: (row) => <span className={changeClass(row)}>{formatSigned(row.changePct)}%</span>,
  },
  {
    key: "state",
    label: "Status",
    render: (row) => <span className={`scr-state scr-state-${row.state.toLowerCase()}`}>{stateLabel(row)}</span>,
  },
];

function sortIndicator(label: string, active: boolean, direction: ScreenerSortDirection, onClick: () => void): ReactNode {
  return (
    <button className={`scr-sort ${active ? "scr-sort-active" : ""}`} type="button" onClick={onClick}>
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
 * Premium, responsive Screener table. Rows with no quote yet render honest
 * "—" placeholders — never fabricates a live-looking price.
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
  const columns = buildColumns(onSort, sortKey, sortDirection);
  return (
    <div className="scr-card">
      <div className="scr-toolbar">
        <div className="scr-chips" role="tablist" aria-label="Screener filter">
          {SCREENER_FILTERS.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={filter === value}
              className={`scr-chip ${filter === value ? "scr-chip-active" : ""}`}
              onClick={() => onFilterChange(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <input
          className="scr-search"
          type="search"
          aria-label="Search ticker or company"
          placeholder="Search ticker or company…"
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
        />
      </div>

      <div className="scr-table-wrap">
        <table className="scr-table">
          <thead>
            <tr>
              {columns.map((column) => (
                <th key={column.key} className={column.alignRight ? "scr-align-right" : undefined}>
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="scr-empty">
                  No matching stocks.
                </td>
              </tr>
            ) : rows.map((row) => (
              <tr key={row.symbol}>
                {columns.map((column) => (
                  <td key={column.key} className={column.alignRight ? "scr-align-right" : undefined}>
                    {column.render(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
