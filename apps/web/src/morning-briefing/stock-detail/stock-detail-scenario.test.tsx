import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import StockDetailPage from "./StockDetailPage";
import { createMockStockDetail } from "./stock-detail.mock";
import type { StockDetail, StockDetailDataSource } from "./stock-detail.types";

vi.mock("./PriceAndKeyLevelsChart", () => ({
  default: () => <div data-testid="stock-chart" />,
}));

describe("Intrinsic Value scenario range", () => {
  beforeEach(() => {
    vi.stubGlobal("scrollTo", vi.fn());
  });

  it("keeps the Bear Base Bull range and a single selected-IV marker when automatic scenarios are unavailable", async () => {
    const base = createMockStockDetail("MSFT")!;
    const incomplete: StockDetail = {
      ...base,
      valuation: {
        ...base.valuation,
        scenarios: { bear: null, base: null, bull: null },
      },
    };
    const dataSource: StockDetailDataSource = {
      getStockDetail: async () => incomplete,
    };

    render(
      <MemoryRouter initialEntries={["/stocks/MSFT"]}>
        <Routes>
          <Route path="/stocks/:symbol" element={<StockDetailPage dataSource={dataSource} />} />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByRole("heading", { level: 1, name: "Microsoft Corporation" });
    expect(screen.getByLabelText("Intrinsic value range")).toBeInTheDocument();
    expect(document.querySelector(".stock-scenario-track")).not.toBeNull();
    expect(document.querySelector(".stock-scenario-marker")).not.toBeNull();
    expect(screen.getByText("Bear")).toBeInTheDocument();
    expect(screen.getByText("Base")).toBeInTheDocument();
    expect(screen.getByText("Bull")).toBeInTheDocument();
    expect(screen.getAllByText("$529.20")).toHaveLength(1);
    expect(screen.queryByText("Scenario range unavailable")).not.toBeInTheDocument();
  });
});