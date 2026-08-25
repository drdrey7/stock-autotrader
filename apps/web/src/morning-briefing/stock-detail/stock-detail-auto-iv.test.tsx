import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import StockDetailPage from "./StockDetailPage";
import { createMockStockDetail } from "./stock-detail.mock";
import type { StockDetail, StockDetailDataSource } from "./stock-detail.types";

vi.mock("./PriceAndKeyLevelsChart", () => ({
  default: () => <div data-testid="stock-chart" />,
}));

afterEach(() => cleanup());

function renderDetail(detail: StockDetail) {
  const dataSource: StockDetailDataSource = { getStockDetail: async () => detail };
  return render(
    <MemoryRouter initialEntries={[`/stocks/${detail.symbol}`]}>
      <Routes>
        <Route path="/stocks/:symbol" element={<StockDetailPage dataSource={dataSource} />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("Stock Detail automatic intrinsic value", () => {
  beforeEach(() => vi.stubGlobal("scrollTo", vi.fn()));

  it("shows Bear, midpoint Base, Bull and Manual for an earnings company", async () => {
    const mock = createMockStockDetail("MSFT")!;
    const detail: StockDetail = {
      ...mock,
      source: "api",
      sector: "Software",
      quote: { ...mock.quote, price: 481.2 },
      metrics: { ...mock.metrics, peTtm: 32.1, priceToBook: null },
      valuation: {
        ...mock.valuation,
        intrinsicValue: 570.31,
        methods: { ...mock.valuation.methods, manual: 570.31 },
      },
    };

    renderDetail(detail);
    await screen.findByRole("heading", { level: 1, name: "Microsoft Corporation" });

    expect(screen.getAllByText("$419.74").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("$464.71").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("$509.68").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("$570.31")).toBeInTheDocument();
    expect(screen.getByText("P/E · 28x / 31x / 34x")).toBeInTheDocument();
  });

  it("regression: Adobe uses the midpoint Base everywhere, including the headline and scenario bar", async () => {
    const mock = createMockStockDetail("ADBE")!;
    const detail: StockDetail = {
      ...mock,
      source: "api",
      sector: "Technology",
      quote: { ...mock.quote, price: 276.24 },
      metrics: { ...mock.metrics, peTtm: 15.137946495292185, priceToBook: null },
      valuation: {
        ...mock.valuation,
        intrinsicValue: null,
        upsidePct: null,
        methods: { ...mock.valuation.methods, manual: null, selected: null },
      },
    };

    renderDetail(detail);
    await screen.findByRole("heading", { level: 1, name: "Adobe Inc." });

    expect(screen.getAllByText("$401.46").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("$456.21").length).toBeGreaterThanOrEqual(3);
    expect(screen.getAllByText("$510.95").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("+65.20%")).toBeInTheDocument();
    expect(screen.getByText("P/E · 22x / 25x / 28x")).toBeInTheDocument();
    expect(screen.getByText("Bear")).toBeInTheDocument();
    expect(screen.getByText("Base")).toBeInTheDocument();
    expect(screen.getByText("Bull")).toBeInTheDocument();
  });

  it("uses P/B scenarios for a bank when P/B is available", async () => {
    const mock = createMockStockDetail("JPM")!;
    const detail: StockDetail = {
      ...mock,
      source: "api",
      sector: "Banks - Diversified",
      quote: { ...mock.quote, price: 200 },
      metrics: { ...mock.metrics, peTtm: 14, priceToBook: 2 },
      valuation: {
        ...mock.valuation,
        intrinsicValue: null,
        upsidePct: null,
        methods: { ...mock.valuation.methods, manual: null, selected: null },
      },
    };

    renderDetail(detail);
    await screen.findByRole("heading", { level: 1, name: "JPMorgan Chase & Co." });

    expect(screen.getAllByText("$122.86").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("$159.48").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("$196.10").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("P/B · 1.23x / 1.6x / 1.96x")).toBeInTheDocument();
  });
});
