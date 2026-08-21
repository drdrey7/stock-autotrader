import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import StockDetailPage from "./StockDetailPage";
import { createMockStockDetail } from "./stock-detail.mock";
import type { StockDetail, StockDetailDataSource } from "./stock-detail.types";

vi.mock("./PriceAndKeyLevelsChart", () => ({
  default: () => <div data-testid="stock-chart" />,
}));

describe("Stock Detail quote date", () => {
  beforeEach(() => {
    vi.stubGlobal("scrollTo", vi.fn());
  });

  it("formats the quote as-of date in the New York market timezone", async () => {
    const base = createMockStockDetail("MSFT")!;
    const detail: StockDetail = {
      ...base,
      quote: {
        ...base.quote,
        asOf: "2026-08-22T00:30:00Z",
      },
    };
    const dataSource: StockDetailDataSource = {
      getStockDetail: async () => detail,
    };

    render(
      <MemoryRouter initialEntries={["/stocks/MSFT"]}>
        <Routes>
          <Route path="/stocks/:symbol" element={<StockDetailPage dataSource={dataSource} />} />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByRole("heading", { level: 1, name: "Microsoft Corporation" });
    expect(screen.getByText(/Market (?:Open|Closed) · Aug 21, 2026/)).toBeInTheDocument();
    expect(screen.queryByText(/Aug 22, 2026/)).not.toBeInTheDocument();
  });
});
