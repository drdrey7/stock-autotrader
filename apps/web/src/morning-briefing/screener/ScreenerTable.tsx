import type { ReactNode } from "react";
import type { ScreenerRow } from "@stock-autotrader/contracts";
import { SCREENER_FILTERS, SCREENER_PRESETS } from "./screener-filter";
import type {
  ScreenerFilter,
  ScreenerPreset,
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

/** Distance display + state color (PR2). Full-precision value, 1-decimal display. */
function distanceCell(row: ScreenerRow): ReactNode {
  if (row.distanceToSma200wPct === null) return <span className="scr-flat">—</span>;
  const state = row.sma200wState ?? "Unavailable";
  const cls = state === "Above" ? "scr-up" : state === "Below" ? "scr-down" : "scr-near";
  return (
    <span className={cls} title={state}>
      {formatSigned(row.distanceToSma200wPct, 1)}%
    </span>
  );
}

function smaCell(row: ScreenerRow): ReactNode {
  if (row.sma200w === null) {
    return row.sma200wState === "NotEnoughHistory"
      ? <span className="scr-flat" title="Fewer than 199 completed weeks">—</span>
      : <span className="scr-flat">—</span>;
  }
  return <span className="scr-price">{row.sma200w.toFixed(2)}</span>;
}

export interface ScreenerColumn {
  key: string;
  label: ReactNode;
  alignRight?: boolean;
  render: (row: ScreenerRow) => ReactNode;
}

/**
 * Column-driven table so future screens (Intrinsic Value, Support,
 * Opportunity) only append a column config — no component rewrite.
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
    key: "sma200w",
    label: sortIndicator("200W SMA", sortKey === "sma200w", sortDirection, () => onSort("sma200w")),
    alignRight: true,
    render: smaCell,
  },
  {
    key: "smaDistance",
    label: sortIndicator("Dist", sortKey === "smaDistance", sortDirection, () => onSort("smaDistance")),
    alignRight: true,
    render: distanceCell,
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

/** Which preset the current (sortKey, direction) maps to, if any. */
function presetFor(sortKey: ScreenerSortKey, direction: ScreenerSortDirection): ScreenerPreset["key"] | null {
  const preset = SCREENER_PRESETS.find((p) => p.sortKey === sortKey && p.direction === direction);
  return preset?.key ?? null;
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
  onPreset: (preset: ScreenerPreset) => void;
}

/**
 * Premium, responsive Screener table. Rows with no quote yet render honest
 * "—" placeholders — never fabricates a live-looking price. The SMA columns
 * (200W SMA / Dist) show "—" while the historical basis is unavailable.
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
  onPreset,
}: ScreenerTableProps) {
  const columns = buildColumns(onSort, sortKey, sortDirection);
  const activePreset = presetFor(sortKey, sortDirection);
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
        <div className="scr-toolbar-right">
          <label className="scr-preset-label" htmlFor="scr-preset">
            Sort
          </label>
          <select
            id="scr-preset"
            className="scr-preset"
            value={activePreset ?? "none"}
            aria-label="SMA sort preset"
            onChange={(event) => {
              const preset = SCREENER_PRESETS.find((p) => p.key === event.target.value);
              if (preset) onPreset(preset);
            }}
          >
            <option value="none">Chg %</option>
            {SCREENER_PRESETS.map((preset) => (
              <option key={preset.key} value={preset.key}>{preset.label}</option>
            ))}
          </select>
          <input
            className="scr-search"
            type="search"
            aria-label="Search ticker or company"
            placeholder="Search ticker or company…"
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
          />
        </div>
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
