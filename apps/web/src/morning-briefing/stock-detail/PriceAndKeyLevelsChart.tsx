import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  LineSeries,
  LineStyle,
  createChart,
  type AutoscaleInfoProvider,
  type IChartApi,
  type ISeriesApi,
  type Time,
} from "lightweight-charts";
import { useShellTheme, type ShellTheme } from "../../shell/theme";
import type { StockLinePoint, StockPricePoint, StockSupportLevel } from "./stock-detail.types";

interface PriceAndKeyLevelsChartProps {
  symbol: string;
  priceHistory: StockPricePoint[];
  currentPrice: number | null;
  intrinsicValue: number | null;
  intrinsicValueHistory?: StockLinePoint[];
  sma200wHistory: StockLinePoint[];
  supports: StockSupportLevel[];
}

interface ChartColours {
  surface: string;
  text: string;
  muted: string;
  border: string;
  blue: string;
  positive: string;
  negative: string;
  warning: string;
}

interface PriceScaleDragState {
  pointerId: number;
  startY: number;
  from: number;
  to: number;
}

type ReferenceSeries = ISeriesApi<"Line"> | ISeriesApi<"Candlestick">;

function resolveColours(theme: ShellTheme): ChartColours {
  const fallback = theme === "dark"
    ? {
        surface: "#0f1728",
        text: "#f4f7fc",
        muted: "#98a2b3",
        border: "#202b42",
        blue: "#4c8dff",
        positive: "#38c95a",
        negative: "#ff6b75",
        warning: "#f6b84a",
      }
    : {
        surface: "#ffffff",
        text: "#0b1f33",
        muted: "#667085",
        border: "#dfe5ee",
        blue: "#3979df",
        positive: "#239b61",
        negative: "#d64550",
        warning: "#b7791f",
      };

  const root = document.documentElement;
  if (root.dataset.theme !== theme) return fallback;
  const styles = getComputedStyle(root);
  const token = (name: string, fallbackValue: string) => styles.getPropertyValue(name).trim() || fallbackValue;
  return {
    surface: token("--surface", fallback.surface),
    text: token("--text", fallback.text),
    muted: token("--muted", fallback.muted),
    border: token("--border", fallback.border),
    blue: token("--brand-blue", fallback.blue),
    positive: token("--positive", fallback.positive),
    negative: token("--negative", fallback.negative),
    warning: token("--warning", fallback.warning),
  };
}

function formatPrice(value: number): string {
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatTime(time: Time): string {
  if (typeof time === "string") return time;
  if (typeof time === "number") return new Date(time * 1000).toISOString().slice(0, 10);
  return `${time.year}-${String(time.month).padStart(2, "0")}-${String(time.day).padStart(2, "0")}`;
}

function crosshairValue(data: unknown): number | null {
  if (typeof data !== "object" || data === null) return null;
  if ("close" in data && typeof data.close === "number") return data.close;
  if ("value" in data && typeof data.value === "number") return data.value;
  return null;
}

function keyLevelAutoscale(values: Array<number | null>): AutoscaleInfoProvider {
  const levels = values.filter((value): value is number => value !== null && Number.isFinite(value) && value > 0);
  return (baseImplementation) => {
    const info = baseImplementation();
    if (info === null || info.priceRange === null || levels.length === 0) return info;

    let minValue = info.priceRange.minValue;
    let maxValue = info.priceRange.maxValue;
    for (const level of levels) {
      minValue = Math.min(minValue, level);
      maxValue = Math.max(maxValue, level);
    }

    // Price lines themselves do not participate in Lightweight Charts'
    // autoscale. Expand the real series' autoscale range so IV/current/supports
    // remain visible without fabricating a historical series just for layout.
    const span = Math.max(maxValue - minValue, Math.abs(maxValue) * 0.01, 0.01);
    const padding = span * 0.035;
    return {
      ...info,
      priceRange: {
        minValue: minValue - padding,
        maxValue: maxValue + padding,
      },
    };
  };
}

function addReferenceLines(
  series: ReferenceSeries,
  currentPrice: number | null,
  intrinsicValue: number | null,
  supports: StockSupportLevel[],
  colours: ChartColours,
): void {
  if (currentPrice !== null) {
    series.createPriceLine({
      price: currentPrice,
      color: colours.blue,
      lineWidth: 1,
      lineStyle: LineStyle.Solid,
      axisLabelVisible: true,
      title: "Current",
    });
  }

  if (intrinsicValue !== null) {
    series.createPriceLine({
      price: intrinsicValue,
      color: colours.positive,
      lineWidth: 2,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: true,
      title: "IV",
    });
  }

  for (const support of supports) {
    series.createPriceLine({
      price: support.price,
      color: colours.muted,
      lineWidth: 1,
      lineStyle: LineStyle.Dotted,
      axisLabelVisible: true,
      title: `S${support.level}`,
    });
  }
}

function hasOhlc(point: StockPricePoint): point is StockPricePoint & Required<Pick<StockPricePoint, "open" | "high" | "low">> {
  return point.open !== undefined && point.high !== undefined && point.low !== undefined;
}

export default function PriceAndKeyLevelsChart({
  symbol,
  priceHistory,
  currentPrice,
  intrinsicValue,
  intrinsicValueHistory = [],
  sma200wHistory,
  supports,
}: PriceAndKeyLevelsChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const chartApiRef = useRef<IChartApi | null>(null);
  const priceScaleDragRef = useRef<PriceScaleDragState | null>(null);
  const { theme } = useShellTheme();
  const hasCurrentPrice = currentPrice !== null;
  const hasIntrinsicValue = intrinsicValue !== null || intrinsicValueHistory.length > 1;
  const hasSma = sma200wHistory.length > 0;
  const hasSupports = supports.length > 0;
  const plottedItems = [
    "price",
    hasCurrentPrice ? "current price" : null,
    hasIntrinsicValue ? "intrinsic value" : null,
    hasSma ? "200-week SMA" : null,
    hasSupports ? `support levels ${supports.map((support) => `S${support.level}`).join(", ")}` : null,
  ].filter(Boolean).join(", ");

  useEffect(() => {
    const container = containerRef.current;
    if (!container || priceHistory.length < 2) return;

    const colours = resolveColours(theme);
    const chart = createChart(container, {
      autoSize: true,
      height: container.clientHeight || 340,
      layout: {
        background: { type: ColorType.Solid, color: colours.surface },
        textColor: colours.muted,
        fontFamily: "DM Sans, ui-sans-serif, system-ui, sans-serif",
      },
      grid: {
        vertLines: { color: colours.border },
        horzLines: { color: colours.border },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: colours.muted, labelBackgroundColor: colours.text },
        horzLine: { color: colours.muted, labelBackgroundColor: colours.text },
      },
      rightPriceScale: {
        borderColor: colours.border,
        minimumWidth: 64,
        scaleMargins: { top: 0.07, bottom: 0.07 },
      },
      timeScale: {
        borderColor: colours.border,
        rightOffset: 2,
        barSpacing: 6,
        minBarSpacing: 1.2,
      },
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
        horzTouchDrag: true,
        // Vertical swipes over the chart body continue to scroll the page.
        // A dedicated coarse-pointer overlay on the right price axis below
        // provides one-finger price-scale stretching without trapping the page.
        vertTouchDrag: false,
      },
      handleScale: {
        axisPressedMouseMove: {
          time: true,
          price: true,
        },
        axisDoubleClickReset: {
          time: true,
          price: true,
        },
        mouseWheel: true,
        pinch: true,
      },
      localization: {
        priceFormatter: (price: number) => formatPrice(price),
      },
    });
    chartApiRef.current = chart;

    const referenceLevels = [currentPrice, intrinsicValue, ...supports.map((support) => support.price)];
    const autoscaleInfoProvider = keyLevelAutoscale(referenceLevels);
    const ohlcReady = priceHistory.every(hasOhlc);
    let referenceSeries: ReferenceSeries;

    if (ohlcReady) {
      const priceSeries = chart.addSeries(CandlestickSeries, {
        title: "Price",
        upColor: colours.positive,
        downColor: colours.negative,
        borderUpColor: colours.positive,
        borderDownColor: colours.negative,
        wickUpColor: colours.positive,
        wickDownColor: colours.negative,
        priceLineVisible: false,
        lastValueVisible: currentPrice === null,
        autoscaleInfoProvider,
      });
      priceSeries.setData(priceHistory.map((point) => ({
        time: point.time,
        open: point.open,
        high: point.high,
        low: point.low,
        close: point.close,
      })));
      referenceSeries = priceSeries;
    } else {
      const priceSeries = chart.addSeries(LineSeries, {
        title: "Price",
        color: colours.blue,
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: currentPrice === null,
        autoscaleInfoProvider,
      });
      priceSeries.setData(priceHistory.map((point) => ({ time: point.time, value: point.close })));
      referenceSeries = priceSeries;
    }

    addReferenceLines(referenceSeries, currentPrice, intrinsicValue, supports, colours);

    if (hasSma) {
      const smaSeries = chart.addSeries(LineSeries, {
        title: "200W SMA",
        color: colours.warning,
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: false,
      });
      smaSeries.setData(sma200wHistory.map((point) => ({ time: point.time, value: point.value })));
    }

    if (intrinsicValueHistory.length > 1) {
      const ivSeries = chart.addSeries(LineSeries, {
        title: "IV history",
        color: colours.positive,
        lineWidth: 2,
        lineStyle: LineStyle.Dashed,
        priceLineVisible: false,
        lastValueVisible: false,
      });
      ivSeries.setData(intrinsicValueHistory.map((point) => ({ time: point.time, value: point.value })));
    }

    const onCrosshairMove: Parameters<typeof chart.subscribeCrosshairMove>[0] = (param) => {
      const tooltip = tooltipRef.current;
      if (!tooltip) return;
      if (!param.time || param.seriesData.size === 0) {
        tooltip.hidden = true;
        return;
      }
      const values: string[] = [];
      for (const [series, data] of param.seriesData) {
        const value = crosshairValue(data);
        if (value === null) continue;
        const title = series.options().title || "Value";
        values.push(`${title} ${formatPrice(value)}`);
      }
      if (currentPrice !== null) values.push(`Current ${formatPrice(currentPrice)}`);
      if (intrinsicValue !== null) values.push(`IV ${formatPrice(intrinsicValue)}`);
      tooltip.textContent = `${formatTime(param.time)} · ${values.join(" · ")}`;
      tooltip.hidden = values.length === 0;
    };
    chart.subscribeCrosshairMove(onCrosshairMove);
    chart.timeScale().fitContent();

    return () => {
      if (chartApiRef.current === chart) chartApiRef.current = null;
      priceScaleDragRef.current = null;
      chart.unsubscribeCrosshairMove(onCrosshairMove);
      chart.remove();
    };
  }, [currentPrice, hasSma, intrinsicValue, intrinsicValueHistory, priceHistory, sma200wHistory, supports, theme]);

  const beginPriceScaleDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const chart = chartApiRef.current;
    if (!chart) return;
    const priceScale = chart.priceScale("right");
    const range = priceScale.getVisibleRange();
    if (!range || !Number.isFinite(range.from) || !Number.isFinite(range.to) || range.to <= range.from) return;

    priceScale.setAutoScale(false);
    priceScaleDragRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      from: range.from,
      to: range.to,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  };

  const movePriceScaleDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = priceScaleDragRef.current;
    const chart = chartApiRef.current;
    if (!drag || !chart || drag.pointerId !== event.pointerId) return;

    const deltaY = event.clientY - drag.startY;
    // Up = stretch candles (narrower range); down = compress (wider range).
    const factor = Math.exp(deltaY * 0.007);
    const midpoint = (drag.from + drag.to) / 2;
    const originalHalfRange = (drag.to - drag.from) / 2;
    const minimumHalfRange = Math.max(Math.abs(midpoint) * 0.0025, 0.01);
    const halfRange = Math.max(originalHalfRange * factor, minimumHalfRange);
    chart.priceScale("right").setVisibleRange({
      from: midpoint - halfRange,
      to: midpoint + halfRange,
    });
    event.preventDefault();
  };

  const endPriceScaleDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = priceScaleDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    priceScaleDragRef.current = null;
    event.preventDefault();
  };

  const resetPriceScale = () => {
    chartApiRef.current?.priceScale("right").setAutoScale(true);
    priceScaleDragRef.current = null;
  };

  if (priceHistory.length < 2) {
    return <div className="stock-chart-empty" role="status">Chart unavailable</div>;
  }

  return (
    <div className="stock-chart-shell">
      <div className="stock-chart-legend" aria-label="Chart legend">
        <span><i className="stock-chart-key stock-chart-price-key" />Price</span>
        {hasCurrentPrice && <span><i className="stock-chart-key stock-chart-current-key" />Current</span>}
        {hasIntrinsicValue && <span><i className="stock-chart-key stock-chart-iv-key" />IV</span>}
        {hasSma && <span><i className="stock-chart-key stock-chart-sma-key" />200W SMA</span>}
        {hasSupports && (
          <span className="stock-chart-support-legend">
            Supports {supports.map((support) => `S${support.level}`).join(" · ")}
          </span>
        )}
      </div>
      <div className="stock-chart-frame">
        <div
          ref={containerRef}
          className="stock-chart-canvas"
          role="img"
          aria-label={`${symbol} price chart showing ${plottedItems}`}
        />
        <div
          className="stock-chart-price-axis-gesture"
          aria-hidden="true"
          onPointerDown={beginPriceScaleDrag}
          onPointerMove={movePriceScaleDrag}
          onPointerUp={endPriceScaleDrag}
          onPointerCancel={endPriceScaleDrag}
          onDoubleClick={resetPriceScale}
        />
        <div ref={tooltipRef} className="stock-chart-crosshair" hidden aria-hidden="true" />
      </div>
      <div className="stock-chart-credit">
        <span className="stock-chart-attribution">
          TradingView Lightweight Charts™ Copyright (c) 2025{" "}
          <a href="https://www.tradingview.com/" target="_blank" rel="noreferrer">TradingView, Inc.</a>
        </span>
      </div>
    </div>
  );
}