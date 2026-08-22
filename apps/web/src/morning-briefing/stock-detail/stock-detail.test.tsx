import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CORE_UNIVERSE, type ScreenerRow } from "@stock-autotrader/contracts";
import { ThemeProvider } from "../../shell/theme";
import { ScreenerTable } from "../screener/ScreenerTable";
import StockDetailPage from "./StockDetailPage";
import { createMockStockDetail, mockStockDetailDataSource } from "./stock-detail.mock";
import type { StockDetail, StockDetailDataSource } from "./stock-detail.types";

const chartMock = vi.hoisted(() => {
  const setData = vi.fn((data: unknown) => { void data; });
  const createPriceLine = vi.fn((options: { title?: string }) => { void options; });
  const remove = vi.fn();
  const subscribeCrosshairMove = vi.fn((handler: unknown) => { void handler; });
  const unsubscribeCrosshairMove = vi.fn((handler: unknown) => { void handler; });
  const fitContent = vi.fn();
  const addSeries = vi.fn((definition: unknown, options?: unknown) => {
    void definition;
    void options;
    return {
      setData,
      createPriceLine,
      options: () => ({ title: "Series" }),
    };
  });
  const createChart = vi.fn((container: unknown, options?: unknown) => {
    void container;
    void options;
    return {
      addSeries,
      remove,
      subscribeCrosshairMove,
      unsubscribeCrosshairMove,
      timeScale: () => ({ fitContent }),
    };
  });
  return {
    addSeries,
    createChart,
    createPriceLine,
    fitContent,
    remove,
    setData,
    subscribeCrosshairMove,
    unsubscribeCrosshairMove,
  };
});

vi.mock("lightweight-charts", () => ({
  CandlestickSeries: { type: "candlestick" },
  ColorType: { Solid: "solid" },
  CrosshairMode: { Normal: 0 },
  LineSeries: { type: "line" },
  LineStyle: { Solid: 0, Dashed: 2, Dotted: 1 },
  createChart: chartMock.createChart,
}));

function installMatchMedia(prefersDark = true): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: prefersDark && query === "(prefers-color-scheme: dark)",
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

function renderStockRoute(
  path: string,
  dataSource: StockDetailDataSource = mockStockDetailDataSource,
  navigationState?: unknown,
) {
  return render(
    <ThemeProvider>
      <MemoryRouter initialEntries={[{ pathname: path, state: navigationState }]}>
        <Routes>
          <Route path="/stocks/:symbol" element={<StockDetailPage dataSource={dataSource} />} />
        </Routes>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

function expectFiniteDetail(detail: StockDetail): void {
  expect(Number.isFinite(detail.quote.price)).toBe(true);
  expect(detail.chart.priceHistory.length).toBe(260);
  expect(detail.technical.sma200wHistory.length).toBe(61);
  expect(detail.technical.supports).toHaveLength(4);
  expect(detail.chart.priceHistory.every((point) =>
    [point.open, point.high, point.low, point.close].every((value) => typeof value === "number" && Number.isFinite(value)),
  )).toBe(true);
}

beforeEach(() => {
  localStorage.clear();
  installMatchMedia();
  document.documentElement.dataset.theme = "dark";
  vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete document.documentElement.dataset.theme;
});

describe("deterministic stock detail mock provider", () => {
  it("covers every current Core Universe symbol", () => {
    expect(CORE_UNIVERSE).toHaveLength(50);
    for (const symbol of CORE_UNIVERSE) {
      const detail = createMockStockDetail(symbol);
      expect(detail, `${symbol} should have a mock detail`).not.toBeNull();
      expect(detail?.symbol).toBe(symbol);
      if (detail) expectFiniteDetail(detail);
    }
  });

  it("normalizes symbols, rejects outsiders and is deterministic", () => {
    const first = createMockStockDetail("nvda");
    const second = createMockStockDetail("NVDA");
    expect(first?.symbol).toBe("NVDA");
    expect(first).toEqual(second);
    expect(createMockStockDetail("INVALID")).toBeNull();
  });

  it("keeps the MSFT fixture explicitly aligned to preview design values", () => {
    const detail = createMockStockDetail("MSFT");
    expect(detail?.source).toBe("mock");
    expect(detail?.quote.price).toBe(481.2);
    expect(detail?.quote.change).toBe(5.88);
    expect(detail?.quote.changePct).toBe(1.24);
    expect(detail?.valuation.intrinsicValue).toBe(529.2);
    expect(detail?.technical.supports.map((support) => support.price)).toEqual([450, 420, 390, 350]);
    expect(detail?.chart.intrinsicValueHistory?.at(-1)?.time).not.toBe(detail?.chart.priceHistory.at(-1)?.time);
  });
});

describe("StockDetailPage", () => {
  it("renders the single overview surface from an injected fixture without tabs or network requests", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    renderStockRoute("/stocks/MSFT");

    expect(screen.getByRole("status")).toHaveTextContent("Loading stock details");
    expect(await screen.findByRole("heading", { level: 1, name: "Microsoft Corporation" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to Screener" })).toHaveAttribute("href", "/screener");
    expect(screen.queryByText("Preview data")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Our Intrinsic Value" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Valuation Methods" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Key Levels" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Price & Key Levels" })).toBeInTheDocument();
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("accepts lowercase symbols and renders another Core Universe stock", async () => {
    const view = renderStockRoute("/stocks/msft");
    expect(await screen.findByRole("heading", { level: 1, name: "Microsoft Corporation" })).toBeInTheDocument();
    view.unmount();

    renderStockRoute("/stocks/CRCL");
    expect(await screen.findByRole("heading", { level: 1, name: "Circle Internet Group, Inc." })).toBeInTheDocument();
  });

  it("resets document scroll when opening a stock detail route", async () => {
    renderStockRoute("/stocks/NVDA");
    await screen.findByRole("heading", { level: 1, name: "NVIDIA Corporation" });
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 0, left: 0, behavior: "auto" });
  });

  it("uses navigation logo only as fallback when the detail provider has no logo", async () => {
    const logoUrl = "https://example.com/logos/now.png";
    renderStockRoute("/stocks/NOW", mockStockDetailDataSource, { logoUrl });
    await screen.findByRole("heading", { level: 1, name: "ServiceNow, Inc." });
    const logo = document.querySelector<HTMLImageElement>("img.stock-company-logo.company-logo-img");
    expect(logo).not.toBeNull();
    expect(logo).toHaveAttribute("src", logoUrl);
  });

  it("shows Stock not found for a symbol outside the Core Universe", async () => {
    renderStockRoute("/stocks/INVALID");
    expect(await screen.findByRole("heading", { name: "Stock not found" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to Screener" })).toHaveAttribute("href", "/screener");
  });

  it("supports missing values, uses × for missing IV and hides unplotted legend entries", async () => {
    const base = createMockStockDetail("MSFT")!;
    const incomplete: StockDetail = {
      ...base,
      valuation: {
        ...base.valuation,
        intrinsicValue: null,
        upsidePct: null,
        scenarios: { bear: null, base: null, bull: null },
        methods: { dcf: null, multiples: null, manual: null, selected: null, selectedMethod: null },
      },
      technical: {
        ...base.technical,
        sma200w: null,
        smaDistancePct: null,
        sma200wHistory: [],
        supports: [],
      },
      metrics: {
        marketCap: null,
        peTtm: null,
        roicPct: null,
        fcfMarginPct: null,
        debtToEquity: null,
        fundamentalsAsOf: null,
      },
      chart: {
        ...base.chart,
        intrinsicValueHistory: [],
      },
    };
    const dataSource: StockDetailDataSource = { getStockDetail: async () => incomplete };
    renderStockRoute("/stocks/MSFT", dataSource);

    await screen.findByRole("heading", { level: 1, name: "Microsoft Corporation" });
    expect(screen.getByText("×")).toBeInTheDocument();
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(12);
    expect(document.body).not.toHaveTextContent(/NaN|undefined/);
    const legend = screen.getByLabelText("Chart legend");
    expect(within(legend).getByText("Price")).toBeInTheDocument();
    expect(within(legend).getByText("Current")).toBeInTheDocument();
    expect(within(legend).queryByText("IV")).not.toBeInTheDocument();
    expect(within(legend).queryByText("200W SMA")).not.toBeInTheDocument();
    expect(within(legend).queryByText(/Supports/)).not.toBeInTheDocument();
  });

  it("shows Chart unavailable instead of creating a chart for insufficient history", async () => {
    const base = createMockStockDetail("MSFT")!;
    const insufficient: StockDetail = {
      ...base,
      chart: { ...base.chart, priceHistory: base.chart.priceHistory.slice(0, 1) },
    };
    const dataSource: StockDetailDataSource = { getStockDetail: async () => insufficient };
    renderStockRoute("/stocks/MSFT", dataSource);

    expect(await screen.findByText("Chart unavailable")).toBeInTheDocument();
    expect(chartMock.createChart).not.toHaveBeenCalled();
  });

  it("feeds candlesticks, SMA, IV history and six labelled reference price lines into Lightweight Charts", async () => {
    renderStockRoute("/stocks/MSFT");
    await screen.findByRole("img", { name: /MSFT price chart/i });

    await waitFor(() => expect(chartMock.createChart).toHaveBeenCalledTimes(1));
    expect(chartMock.addSeries).toHaveBeenCalledTimes(3);
    expect(chartMock.addSeries.mock.calls[0]?.[0]).toEqual({ type: "candlestick" });
    expect(chartMock.setData).toHaveBeenCalledTimes(3);
    expect(chartMock.setData.mock.calls[0]?.[0]).toHaveLength(260);
    expect(chartMock.setData.mock.calls[1]?.[0]).toHaveLength(61);
    expect((chartMock.setData.mock.calls[2]?.[0] as unknown[] | undefined)?.length).toBeGreaterThan(1);
    expect(chartMock.createPriceLine).toHaveBeenCalledTimes(6);
    expect(chartMock.createPriceLine.mock.calls.map(([options]) => options.title)).toEqual(["Current", "IV", "S1", "S2", "S3", "S4"]);
    expect(chartMock.fitContent).toHaveBeenCalledTimes(1);

    const chartOptions = chartMock.createChart.mock.calls[0]?.[1] as {
      handleScroll?: { horzTouchDrag?: boolean; vertTouchDrag?: boolean };
      handleScale?: {
        axisPressedMouseMove?: { time?: boolean; price?: boolean };
        axisDoubleClickReset?: { time?: boolean; price?: boolean };
        pinch?: boolean;
      };
    } | undefined;
    expect(chartOptions?.handleScroll?.horzTouchDrag).toBe(true);
    expect(chartOptions?.handleScroll?.vertTouchDrag).toBe(false);
    expect(chartOptions?.handleScale?.axisPressedMouseMove?.price).toBe(true);
    expect(chartOptions?.handleScale?.axisDoubleClickReset?.price).toBe(true);
    expect(chartOptions?.handleScale?.pinch).toBe(true);

    expect(screen.getByText(/TradingView Lightweight Charts™ Copyright \(c\) 2025/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "TradingView, Inc." })).toHaveAttribute("href", "https://www.tradingview.com/");
  });

  it("falls back to LineSeries when a dataset provides close-only price history", async () => {
    const base = createMockStockDetail("NVDA")!;
    const closeOnly: StockDetail = {
      ...base,
      chart: {
        ...base.chart,
        priceHistory: base.chart.priceHistory.map(({ time, close }) => ({ time, close })),
      },
    };
    const dataSource: StockDetailDataSource = { getStockDetail: async () => closeOnly };
    renderStockRoute("/stocks/NVDA", dataSource);

    await screen.findByRole("img", { name: /NVDA price chart/i });
    await waitFor(() => expect(chartMock.createChart).toHaveBeenCalledTimes(1));
    expect(chartMock.addSeries.mock.calls[0]?.[0]).toEqual({ type: "line" });
  });

  it("destroys each TradingView instance and leaves no persistent duplicate after remount", async () => {
    const first = renderStockRoute("/stocks/MSFT");
    await screen.findByRole("img", { name: /MSFT price chart/i });
    await waitFor(() => expect(chartMock.createChart).toHaveBeenCalledTimes(1));
    first.unmount();
    expect(chartMock.unsubscribeCrosshairMove).toHaveBeenCalledTimes(1);
    expect(chartMock.remove).toHaveBeenCalledTimes(1);

    const second = renderStockRoute("/stocks/MSFT");
    await screen.findByRole("img", { name: /MSFT price chart/i });
    await waitFor(() => expect(chartMock.createChart).toHaveBeenCalledTimes(2));
    expect(chartMock.remove).toHaveBeenCalledTimes(1);
    second.unmount();
    expect(chartMock.unsubscribeCrosshairMove).toHaveBeenCalledTimes(2);
    expect(chartMock.remove).toHaveBeenCalledTimes(2);
  });

  it("renders an explicit error state when its data source rejects", async () => {
    const dataSource: StockDetailDataSource = {
      getStockDetail: async () => { throw new Error("mock failure"); },
    };
    renderStockRoute("/stocks/MSFT", dataSource);
    expect(await screen.findByRole("alert")).toHaveTextContent("Stock detail unavailable");
  });
});

describe("Screener Stock Detail integration", () => {
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

  it("links only the company identity to /stocks/:symbol and keeps the real company logo", () => {
    render(
      <MemoryRouter>
        <ScreenerTable
          rows={[row]}
          filter="all"
          onFilterChange={vi.fn()}
          search=""
          onSearchChange={vi.fn()}
          sortKey="company"
          sortDirection="asc"
          onSort={vi.fn()}
        />
      </MemoryRouter>,
    );
    expect(screen.getByRole("link", { name: "Open Microsoft Corporation stock details" })).toHaveAttribute("href", "/stocks/MSFT");
    expect(document.querySelector("img.scr-company-logo.company-logo-img")).toHaveAttribute("src", row.logoUrl);
    expect(screen.getByText("481.20").closest("a")).toBeNull();
  });
});