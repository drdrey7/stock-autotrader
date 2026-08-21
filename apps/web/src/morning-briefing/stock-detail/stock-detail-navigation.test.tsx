import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import StockDetailPage from "./StockDetailPage";
import type { ScreenerQuery } from "../screener/screener-filter";

vi.mock("./PriceAndKeyLevelsChart", () => ({
  default: () => <div data-testid="stock-chart" />,
}));

function NavigationStateProbe() {
  const location = useLocation();
  return <pre data-testid="return-state">{JSON.stringify(location.state)}</pre>;
}

describe("Stock Detail → Screener navigation", () => {
  beforeEach(() => {
    vi.stubGlobal("scrollTo", vi.fn());
  });

  it("returns with the same screener filter, search and sort context", async () => {
    const query: ScreenerQuery = {
      filter: "belowIv",
      search: "micro",
      sortKey: "ivDistance",
      direction: "asc",
    };

    render(
      <MemoryRouter
        initialEntries={[{
          pathname: "/stocks/MSFT",
          state: {
            logoUrl: "https://example.com/logos/msft.png",
            screenerQuery: query,
          },
        }]}
      >
        <Routes>
          <Route path="/stocks/:symbol" element={<StockDetailPage />} />
          <Route path="/screener" element={<NavigationStateProbe />} />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByRole("heading", { level: 1, name: "Microsoft Corporation" });
    fireEvent.click(screen.getByRole("link", { name: "Back to Screener" }));

    expect(screen.getByTestId("return-state")).toHaveTextContent(JSON.stringify({ screenerQuery: query }));
  });
});