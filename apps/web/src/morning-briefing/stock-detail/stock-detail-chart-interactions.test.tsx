import { fireEvent, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "../../shell/theme";
import PriceAndKeyLevelsChart from "./PriceAndKeyLevelsChart";

const chartMock = vi.hoisted(() => {
  const setData = vi.fn();
  const createPriceLine = vi.fn();
  const setVisibleRange = vi.fn();
  const setAutoScale = vi.fn();
  const getVisibleRange = vi.fn(() => ({ from: 100, to: 220 }));
  const priceScale = vi.fn(() => ({ getVisibleRange, setVisibleRange, setAutoScale }));
  const fitContent = vi.fn();
  const subscribeCrosshairMove = vi.fn();
  const unsubscribeCrosshairMove = vi.fn();
  const addSeries = vi.fn((definition: unknown, options?: unknown) => {
    void definition;
    return {
      setData,
      createPriceLine,
      options: () => options as { title?: string },
    };
  });
  const createChart = vi.fn(() => ({
    addSeries,
    priceScale,
    timeScale: () => ({ fitContent }),
    subscribeCrosshairMove,
    unsubscribeCrosshairMove,
    remove: vi.fn(),
  }));
  return {
    addSeries,
    createChart,
    createPriceLine,
    fitContent,
    getVisibleRange,
    priceScale,
    setAutoScale,
    setData,
    setVisibleRange,
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

beforeEach(() => {
  vi.clearAllMocks();
  document.documentElement.dataset.theme = "dark";
});

describe("Stock Detail chart scaling", () => {
  it("includes current, IV and all supports in the initial autoscale without fake IV history", async () => {
    render(
      <ThemeProvider>
        <PriceAndKeyLevelsChart
          symbol="NVDA"
          currentPrice={180}
          intrinsicValue={212.04}
          intrinsicValueHistory={[]}
          priceHistory={[
            { time: "2026-08-07", open: 172, high: 184, low: 168, close: 180 },
            { time: "2026-08-14", open: 180, high: 188, low: 176, close: 184 },
          ]}
          sma200wHistory={[
            { time: "2026-08-07", value: 148 },
            { time: "2026-08-14", value: 152 },
          ]}
          supports={[
            { level: 1, price: 204.99 },
            { level: 2, price: 187.16 },
            { level: 3, price: 169.34 },
            { level: 4, price: 151.51 },
          ]}
        />
      </ThemeProvider>,
    );

    await waitFor(() => expect(chartMock.addSeries).toHaveBeenCalled());
    const priceOptions = chartMock.addSeries.mock.calls[0]?.[1] as {
      autoscaleInfoProvider?: (base: () => { priceRange: { minValue: number; maxValue: number } }) => {
        priceRange: { minValue: number; maxValue: number };
      } | null;
    } | undefined;
    const autoscale = priceOptions?.autoscaleInfoProvider;
    expect(autoscale).toBeTypeOf("function");
    const result = autoscale?.(() => ({ priceRange: { minValue: 160, maxValue: 190 } }));
    expect(result?.priceRange.maxValue).toBeGreaterThan(212.04);
    expect(result?.priceRange.minValue).toBeLessThan(160);
    expect(chartMock.createPriceLine.mock.calls.map(([options]) => options.title)).toEqual([
      "Current", "IV", "S1", "S2", "S3", "S4",
    ]);
    expect(chartMock.addSeries).toHaveBeenCalledTimes(2);
  });

  it("hides the historical Price axis title when a current quote exists while preserving Price in the tooltip", async () => {
    const { container } = render(
      <ThemeProvider>
        <PriceAndKeyLevelsChart
          symbol="NVDA"
          currentPrice={180}
          intrinsicValue={null}
          priceHistory={[
            { time: "2026-08-07", open: 172, high: 184, low: 168, close: 180 },
            { time: "2026-08-14", open: 180, high: 188, low: 176, close: 184 },
          ]}
          sma200wHistory={[]}
          supports={[]}
        />
      </ThemeProvider>,
    );

    await waitFor(() => expect(chartMock.addSeries).toHaveBeenCalledOnce());
    const priceOptions = chartMock.addSeries.mock.calls[0]?.[1] as {
      title?: string;
      lastValueVisible?: boolean;
    } | undefined;
    expect(priceOptions?.title).toBe("");
    expect(priceOptions?.lastValueVisible).toBe(false);

    const priceSeries = chartMock.addSeries.mock.results[0]?.value;
    const onCrosshairMove = chartMock.subscribeCrosshairMove.mock.calls[0]?.[0] as ((param: {
      time: string;
      seriesData: Map<unknown, unknown>;
    }) => void) | undefined;
    expect(onCrosshairMove).toBeTypeOf("function");
    onCrosshairMove?.({
      time: "2026-08-14",
      seriesData: new Map([[priceSeries, { open: 180, high: 188, low: 176, close: 184 }]]),
    });

    const tooltip = container.querySelector<HTMLElement>(".stock-chart-crosshair");
    expect(tooltip?.textContent).toContain("Price $184.00");
    expect(tooltip?.textContent).toContain("Current $180.00");
    expect(tooltip?.textContent).not.toContain("Value $184.00");
  });

  it("restores the historical Price axis title and value when the current quote is unavailable", async () => {
    render(
      <ThemeProvider>
        <PriceAndKeyLevelsChart
          symbol="NVDA"
          currentPrice={null}
          intrinsicValue={null}
          priceHistory={[
            { time: "2026-08-07", open: 172, high: 184, low: 168, close: 180 },
            { time: "2026-08-14", open: 180, high: 188, low: 176, close: 184 },
          ]}
          sma200wHistory={[]}
          supports={[]}
        />
      </ThemeProvider>,
    );

    await waitFor(() => expect(chartMock.addSeries).toHaveBeenCalledOnce());
    const priceOptions = chartMock.addSeries.mock.calls[0]?.[1] as {
      title?: string;
      lastValueVisible?: boolean;
    } | undefined;
    expect(priceOptions?.title).toBe("Price");
    expect(priceOptions?.lastValueVisible).toBe(true);
    expect(chartMock.createPriceLine).not.toHaveBeenCalled();
  });

  it("lets a coarse-pointer user stretch/compress the right price axis with one finger", async () => {
    const { container } = render(
      <ThemeProvider>
        <PriceAndKeyLevelsChart
          symbol="NVDA"
          currentPrice={180}
          intrinsicValue={212.04}
          priceHistory={[
            { time: "2026-08-07", open: 172, high: 184, low: 168, close: 180 },
            { time: "2026-08-14", open: 180, high: 188, low: 176, close: 184 },
          ]}
          sma200wHistory={[]}
          supports={[]}
        />
      </ThemeProvider>,
    );

    await waitFor(() => expect(chartMock.createChart).toHaveBeenCalledOnce());
    const axis = container.querySelector<HTMLElement>(".stock-chart-price-axis-gesture");
    expect(axis).not.toBeNull();
    if (!axis) return;

    fireEvent.pointerDown(axis, { pointerId: 7, clientY: 200 });
    expect(chartMock.setAutoScale).toHaveBeenCalledWith(false);

    fireEvent.pointerMove(axis, { pointerId: 7, clientY: 150 });
    expect(chartMock.setVisibleRange).toHaveBeenCalled();

    fireEvent.doubleClick(axis);
    expect(chartMock.setAutoScale).toHaveBeenLastCalledWith(true);
  });
});
