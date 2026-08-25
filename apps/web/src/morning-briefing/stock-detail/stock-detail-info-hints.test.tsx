import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import StockDetailPage from "./StockDetailPage";
import { mockStockDetailDataSource } from "./stock-detail.mock";

vi.mock("./PriceAndKeyLevelsChart", () => ({
  default: () => <div data-testid="stock-chart" />,
}));

afterEach(() => cleanup());

function renderStock(symbol: string) {
  return render(
    <MemoryRouter initialEntries={[`/stocks/${symbol}`]}>
      <Routes>
        <Route path="/stocks/:symbol" element={<StockDetailPage dataSource={mockStockDetailDataSource} />} />
      </Routes>
    </MemoryRouter>,
  );
}

const expandedHintNames = [
  "Learn what Intrinsic Value means",
  "Learn what Valuation Methods means",
  "Learn what DCF means",
  "Learn what Multiples means",
  "Learn what Market Cap means",
  "Learn what P/E (TTM) means",
  "Learn what ROIC means",
  "Learn what FCF Margin means",
  "Learn what Debt / Equity means",
] as const;

describe("Stock Detail financial info hints", () => {
  beforeEach(() => {
    vi.stubGlobal("scrollTo", vi.fn());
  });

  it("renders the requested beginner-friendly hints on Microsoft", async () => {
    renderStock("MSFT");
    await screen.findByRole("heading", { level: 1, name: "Microsoft Corporation" });

    for (const name of expandedHintNames) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
    expect(screen.getByRole("button", { name: "Learn what 200W SMA means" })).toBeInTheDocument();
  });

  it("does not duplicate the Intrinsic Value hint beside the IV range label", async () => {
    renderStock("MSFT");
    await screen.findByRole("heading", { level: 1, name: "Microsoft Corporation" });

    expect(screen.getAllByRole("button", { name: "Learn what Intrinsic Value means" })).toHaveLength(1);
    expect(screen.getByText("IV")).toBeInTheDocument();
  });

  it("uses the same hints for another stock without symbol-specific logic", async () => {
    renderStock("AAPL");
    await screen.findByRole("heading", { level: 1, name: "Apple Inc." });

    for (const name of expandedHintNames) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
    expect(screen.getByRole("button", { name: "Learn what 200W SMA means" })).toBeInTheDocument();
  });
});
