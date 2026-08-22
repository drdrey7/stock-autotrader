import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import StockDetailPage from "./StockDetailPage";
import { createMockStockDetail } from "./stock-detail.mock";
import type { StockDetail, StockDetailDataSource } from "./stock-detail.types";

const chartMock = vi.hoisted(() => vi.fn());
vi.mock("./PriceAndKeyLevelsChart", () => ({
  default: (props: unknown) => {
    chartMock(props);
    return <div data-testid="stock-chart" />;
  },
}));

describe("Stock Detail quote freshness", () => {
  beforeEach(() => {
    vi.stubGlobal("scrollTo", vi.fn());
    chartMock.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it("surfaces stale persisted quotes and does not plot them as a Current price line", async () => {
    const base = createMockStockDetail("MSFT")!;
    const detail: StockDetail = {
      ...base,
      quote: {
        ...base.quote,
        state: "Stale",
        marketState: "open",
      },
    };
    const dataSource: StockDetailDataSource = { getStockDetail: async () => detail };

    render(
      <MemoryRouter initialEntries={["/stocks/MSFT"]}>
        <Routes>
          <Route path="/stocks/:symbol" element={<StockDetailPage dataSource={dataSource} />} />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByRole("heading", { level: 1, name: "Microsoft Corporation" });
    expect(screen.getByText(/Market Open · Stale data ·/)).toBeInTheDocument();
    expect(chartMock).toHaveBeenCalled();
    expect(chartMock.mock.calls.at(-1)?.[0]).toMatchObject({ currentPrice: null });
  });

  it("suppresses a cached pre-split quote when history has already moved to the post-split scale", async () => {
    const base = createMockStockDetail("MSFT")!;
    const detail: StockDetail = {
      ...base,
      quote: {
        ...base.quote,
        state: "Cached",
        scaleState: "mismatch",
        marketState: "closed",
      },
    };
    const dataSource: StockDetailDataSource = { getStockDetail: async () => detail };

    render(
      <MemoryRouter initialEntries={["/stocks/MSFT"]}>
        <Routes>
          <Route path="/stocks/:symbol" element={<StockDetailPage dataSource={dataSource} />} />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByRole("heading", { level: 1, name: "Microsoft Corporation" });
    expect(screen.getByText(/Market Closed · Split adjustment pending ·/)).toBeInTheDocument();
    expect(chartMock.mock.calls.at(-1)?.[0]).toMatchObject({ currentPrice: null });
  });

  it("reports an unavailable quote before split-scale status", async () => {
    const base = createMockStockDetail("MSFT")!;
    const detail: StockDetail = {
      ...base,
      quote: {
        ...base.quote,
        price: null,
        change: null,
        changePct: null,
        asOf: null,
        state: "Unavailable",
        scaleState: "unknown",
        marketState: "closed",
      },
    };
    const dataSource: StockDetailDataSource = { getStockDetail: async () => detail };

    render(
      <MemoryRouter initialEntries={["/stocks/MSFT"]}>
        <Routes>
          <Route path="/stocks/:symbol" element={<StockDetailPage dataSource={dataSource} />} />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByRole("heading", { level: 1, name: "Microsoft Corporation" });
    expect(screen.getByText(/Market Closed · Unavailable ·/)).toBeInTheDocument();
    expect(screen.queryByText(/Split adjustment pending/)).not.toBeInTheDocument();
    expect(chartMock.mock.calls.at(-1)?.[0]).toMatchObject({ currentPrice: null });
  });
});
