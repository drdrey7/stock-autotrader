import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import StockDetailPage from "./StockDetailPage";
import { mockStockDetailDataSource } from "./stock-detail.mock";

vi.mock("./PriceAndKeyLevelsChart", () => ({
  default: () => <div data-testid="stock-chart" />,
}));

function renderStock(symbol: string) {
  return render(
    <MemoryRouter initialEntries={[`/stocks/${symbol}`]}>
      <Routes>
        <Route path="/stocks/:symbol" element={<StockDetailPage dataSource={mockStockDetailDataSource} />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("Stock Detail financial info hints", () => {
  beforeEach(() => {
    vi.stubGlobal("scrollTo", vi.fn());
  });

  it("renders the three beginner-friendly hints on Microsoft", async () => {
    renderStock("MSFT");
    await screen.findByRole("heading", { level: 1, name: "Microsoft Corporation" });

    expect(screen.getByRole("button", { name: "Learn what Market Cap means" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Learn what 200W SMA means" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Learn what Intrinsic Value means" })).toBeInTheDocument();
  });

  it("uses the same hints for another stock without symbol-specific logic", async () => {
    renderStock("AAPL");
    await screen.findByRole("heading", { level: 1, name: "Apple Inc." });

    expect(screen.getByRole("button", { name: "Learn what Market Cap means" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Learn what 200W SMA means" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Learn what Intrinsic Value means" })).toBeInTheDocument();
  });
});
