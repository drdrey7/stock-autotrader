import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { ScreenerRow } from "@stock-autotrader/contracts";
import { ScreenerTable } from "./ScreenerTable";
import type { ScreenerQuery } from "./screener-filter";

const row: ScreenerRow = {
  symbol: "MSFT",
  company: "Microsoft Corporation",
  price: 481.2,
  changeAbs: 5.88,
  changePct: 1.24,
  dayHigh: null,
  dayLow: null,
  dayOpen: null,
  previousClose: null,
  provider: "test",
  asOf: "2026-08-21T20:00:00.000Z",
  updatedAt: "2026-08-21T20:00:00.000Z",
  state: "Live",
  sma200w: null,
  distanceToSma200wPct: null,
  sma200wState: "Unavailable",
  sma200wHistoryWeeks: null,
  sma200wAsOf: null,
  supportLevels: [],
  intrinsicValue: null,
  logoUrl: "https://example.com/logos/msft.png",
};

function NavigationStateProbe() {
  const location = useLocation();
  return <pre data-testid="navigation-state">{JSON.stringify(location.state)}</pre>;
}

describe("Screener → Stock Detail navigation", () => {
  it("forwards the real logo and the current screener query", () => {
    const query: ScreenerQuery = {
      filter: "belowIv",
      search: "micro",
      sortKey: "ivDistance",
      direction: "asc",
    };

    render(
      <MemoryRouter initialEntries={["/screener"]}>
        <Routes>
          <Route
            path="/screener"
            element={(
              <ScreenerTable
                rows={[row]}
                filter={query.filter}
                onFilterChange={vi.fn()}
                search={query.search}
                onSearchChange={vi.fn()}
                sortKey={query.sortKey}
                sortDirection={query.direction}
                onSort={vi.fn()}
                returnQuery={query}
              />
            )}
          />
          <Route path="/stocks/:symbol" element={<NavigationStateProbe />} />
        </Routes>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("link", { name: "Open Microsoft Corporation stock details" }));

    expect(screen.getByTestId("navigation-state")).toHaveTextContent(JSON.stringify({
      logoUrl: row.logoUrl,
      screenerQuery: query,
    }));
  });
});