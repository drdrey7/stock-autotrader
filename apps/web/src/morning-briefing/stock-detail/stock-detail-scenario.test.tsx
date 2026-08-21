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

  it("does not render a range or marker when scenario values are incomplete", async () => {
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
    expect(screen.getByRole("status", { name: "" })).toHaveTextContent("Scenario range unavailable");
    expect(document.querySelector(".stock-scenario-track")).toBeNull();
    expect(document.querySelector(".stock-scenario-marker")).toBeNull();
  });
});