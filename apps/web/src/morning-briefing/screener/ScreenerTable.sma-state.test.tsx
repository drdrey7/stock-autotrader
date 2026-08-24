import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ScreenerRow } from "@stock-autotrader/contracts";
import { ScreenerTable } from "./ScreenerTable";

function makeRow(symbol: string, sma200wState: ScreenerRow["sma200wState"]): ScreenerRow {
  return {
    symbol,
    company: `${symbol} Co`,
    price: 100,
    changeAbs: 1,
    changePct: 1,
    dayHigh: null,
    dayLow: null,
    dayOpen: null,
    previousClose: null,
    provider: "finnhub-quote",
    asOf: "2026-08-24T08:00:00.000Z",
    updatedAt: "2026-08-24T08:00:00.000Z",
    state: "Live",
    sma200w: null,
    distanceToSma200wPct: null,
    sma200wState,
    sma200wHistoryWeeks: sma200wState === "NotEnoughHistory" ? 152 : null,
    sma200wAsOf: null,
    supportLevels: [],
    intrinsicValue: null,
    logoUrl: null,
  };
}

function renderTable(rows: ScreenerRow[]) {
  render(
    <ScreenerTable
      rows={rows}
      filter="all"
      onFilterChange={vi.fn()}
      search=""
      onSearchChange={vi.fn()}
      sortKey="company"
      sortDirection="asc"
      onSort={vi.fn()}
    />,
  );
}

describe("ScreenerTable SMA availability states", () => {
  it("shows N/A in both SMA columns only when history is insufficient", () => {
    renderTable([
      makeRow("ARM", "NotEnoughHistory"),
      makeRow("PLTR", "Unavailable"),
    ]);

    const armRow = screen.getByText("ARM").closest('[role="row"]');
    const pltrRow = screen.getByText("PLTR").closest('[role="row"]');

    expect(armRow).not.toBeNull();
    expect(pltrRow).not.toBeNull();
    const armCells = within(armRow as HTMLElement).getAllByText("N/A");
    expect(armCells).toHaveLength(2);
    for (const cell of armCells) {
      expect(cell).toHaveAttribute("title", "Insufficient history for a 200-week SMA");
    }
    expect(within(pltrRow as HTMLElement).queryByText("N/A")).not.toBeInTheDocument();
    expect(within(pltrRow as HTMLElement).getAllByText("—").length).toBeGreaterThanOrEqual(2);
  });
});
