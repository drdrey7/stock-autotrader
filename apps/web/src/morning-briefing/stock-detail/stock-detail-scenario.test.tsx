import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import StockDetailPage from "./StockDetailPage";
import { createMockStockDetail } from "./stock-detail.mock";
import type { StockDetail, StockDetailDataSource } from "./stock-detail.types";

vi.mock("./PriceAndKeyLevelsChart", () => ({
  default: () => <div data-testid="stock-chart" />,
}));

function renderDetail(detail: StockDetail) {
  const dataSource: StockDetailDataSource = {
    getStockDetail: async () => detail,
  };
  return render(
    <MemoryRouter initialEntries={[`/stocks/${detail.symbol}`]}>
      <Routes>
        <Route path="/stocks/:symbol" element={<StockDetailPage dataSource={dataSource} />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("Intrinsic Value scenario range", () => {
  beforeEach(() => {
    vi.stubGlobal("scrollTo", vi.fn());
  });

  it("keeps the Bear Base Bull range visible when automatic scenarios are unavailable", async () => {
    const base = createMockStockDetail("MSFT")!;
    const incomplete: StockDetail = {
      ...base,
      valuation: {
        ...base.valuation,
        automatic: null,
        scenarios: { bear: null, base: null, bull: null },
      },
    };

    renderDetail(incomplete);

    await screen.findByRole("heading", { level: 1, name: "Microsoft Corporation" });
    expect(screen.getByLabelText("Intrinsic value range")).toBeInTheDocument();
    expect(document.querySelector(".stock-scenario-track")).not.toBeNull();
    expect(document.querySelector(".stock-scenario-marker")).toBeNull();
    expect(screen.getByText("Bear")).toBeInTheDocument();
    expect(screen.getByText("Base")).toBeInTheDocument();
    expect(screen.getByText("Bull")).toBeInTheDocument();
    expect(screen.getAllByText("$529.20")).toHaveLength(1);
    expect(screen.queryByText("Scenario range unavailable")).not.toBeInTheDocument();
  });

  it("omits the range marker when Manual wins over an available Automatic range", async () => {
    const base = createMockStockDetail("MSFT")!;
    const manualSelected: StockDetail = {
      ...base,
      valuation: {
        ...base.valuation,
        intrinsicValue: 570,
        automatic: {
          bear: 400,
          base: 500,
          bull: 600,
          method: "Automatic IV V2",
          methods: ["P/E"],
          confidence: "High",
          asOf: "2026-08-25",
        },
        scenarios: { bear: 400, base: 500, bull: 600 },
        methods: {
          ...base.valuation.methods,
          manual: 570,
          selected: 570,
          selectedMethod: "manual",
        },
      },
    };

    renderDetail(manualSelected);

    await screen.findByRole("heading", { level: 1, name: "Microsoft Corporation" });
    expect(screen.getByText("$400.00")).toBeInTheDocument();
    expect(screen.getByText("$500.00")).toBeInTheDocument();
    expect(screen.getByText("$600.00")).toBeInTheDocument();
    expect(document.querySelector(".stock-scenario-marker")).toBeNull();
  });

  it("shows the midpoint marker when Automatic Base is the selected IV", async () => {
    const base = createMockStockDetail("AMD")!;
    const automaticSelected: StockDetail = {
      ...base,
      valuation: {
        ...base.valuation,
        intrinsicValue: 500,
        automatic: {
          bear: 400,
          base: 500,
          bull: 600,
          method: "Automatic IV V2",
          methods: ["P/E", "P/FCF"],
          confidence: "High",
          asOf: "2026-08-25",
        },
        scenarios: { bear: 400, base: 500, bull: 600 },
        methods: {
          ...base.valuation.methods,
          manual: null,
          selected: 500,
          selectedMethod: "automatic-p-e+p-fcf",
        },
      },
    };

    renderDetail(automaticSelected);

    await screen.findByRole("heading", { level: 1, name: automaticSelected.companyName });
    expect(document.querySelector(".stock-scenario-marker")).not.toBeNull();
  });
});