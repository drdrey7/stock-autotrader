import { useEffect, useRef, useState } from "react";
import { useShellTheme } from "../../shell/theme";

const STOCK_HEATMAP_SCRIPT = "https://s3.tradingview.com/external-embedding/embed-widget-stock-heatmap.js";
const RENDER_TIMEOUT_MS = 20_000;

type PerformanceMode = "1D" | "YTD";
type SizeMode = "market-cap" | "equal";

/**
 * Official TradingView S&P 500 stock heatmap.
 *
 * The top toolbar and data-source switcher stay disabled so the widget feels
 * native to the Morning Briefing surface instead of embedding the TradingView
 * site chrome. The page owns two small first-party controls for the supported
 * view modes. On coarse-pointer devices the iframe starts in scroll-friendly
 * mode so vertical swipes continue scrolling the page; users can explicitly
 * enable iframe interaction when they want to inspect/zoom the heatmap.
 */
export function StockHeatmap() {
  const embedRef = useRef<HTMLDivElement>(null);
  const { theme } = useShellTheme();
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [performance, setPerformance] = useState<PerformanceMode>("1D");
  const [sizeMode, setSizeMode] = useState<SizeMode>("market-cap");
  const [touchInteractive, setTouchInteractive] = useState(false);

  const blockColor = performance === "YTD" ? "Perf.YTD" : "change";
  const isMonoSize = sizeMode === "equal";

  useEffect(() => {
    const container = embedRef.current;
    if (!container) return;

    let cancelled = false;
    setStatus("loading");
    container.replaceChildren();

    const widgetSlot = document.createElement("div");
    widgetSlot.className = "tradingview-widget-container__widget";

    const copyright = document.createElement("div");
    copyright.className = "tradingview-widget-copyright";
    const link = document.createElement("a");
    link.href = "https://www.tradingview.com/heatmap/stock/";
    link.rel = "noopener nofollow";
    link.target = "_blank";
    const label = document.createElement("span");
    label.className = "blue-text";
    label.textContent = "Stock Heatmap";
    link.appendChild(label);
    const trademark = document.createElement("span");
    trademark.className = "trademark";
    trademark.textContent = " by TradingView";
    copyright.append(link, trademark);

    const script = document.createElement("script");
    script.type = "text/javascript";
    script.async = true;
    script.src = STOCK_HEATMAP_SCRIPT;
    script.dataset.tvStockHeatmap = "true";
    script.textContent = JSON.stringify({
      dataSource: "SPX500",
      blockSize: "market_cap_basic",
      blockColor,
      grouping: "sector",
      locale: "en",
      symbolUrl: "",
      colorTheme: theme,
      exchanges: [],
      hasTopBar: false,
      isDataSetEnabled: false,
      isZoomEnabled: true,
      hasSymbolTooltip: true,
      isMonoSize,
      width: "100%",
      height: "100%",
    });

    const onError = () => {
      if (!cancelled) setStatus("error");
    };
    script.addEventListener("error", onError);

    container.append(widgetSlot, copyright, script);

    const observer = new MutationObserver(() => {
      if (!cancelled && container.querySelector("iframe")) setStatus("ready");
    });
    observer.observe(container, { childList: true, subtree: true });

    const timeout = window.setTimeout(() => {
      if (!cancelled && !container.querySelector("iframe")) setStatus("error");
    }, RENDER_TIMEOUT_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
      observer.disconnect();
      script.removeEventListener("error", onError);
      container.replaceChildren();
    };
  }, [theme, blockColor, isMonoSize]);

  return (
    <div className="heatmap-widget">
      <div className="heatmap-context" aria-label="Heatmap settings">
        <span className="heatmap-static">S&amp;P 500</span>
        <button
          type="button"
          onClick={() => setPerformance((current) => (current === "1D" ? "YTD" : "1D"))}
          aria-label={`Switch to ${performance === "1D" ? "YTD" : "1D"} performance`}
        >
          {performance} performance
        </button>
        <button
          type="button"
          onClick={() => setSizeMode((current) => (current === "market-cap" ? "equal" : "market-cap"))}
          aria-label={`Switch to ${sizeMode === "market-cap" ? "equal-size tiles" : "market-cap sizing"}`}
        >
          {sizeMode === "market-cap" ? "Market cap" : "Equal size"}
        </button>
      </div>

      <section className="heatmap-panel" aria-label="S&P 500 stock heatmap">
        <div
          className={`tv-stock-heatmap${touchInteractive ? " is-touch-interactive" : ""}`}
          data-theme={theme}
          data-tv-status={status}
        >
          <div ref={embedRef} className="tradingview-widget-container tv-stock-heatmap-embed" />
          {status !== "ready" && (
            <div
              className={`tv-stock-heatmap-state${status === "error" ? " tv-widget-error" : ""}`}
              role={status === "error" ? "alert" : "status"}
              aria-live="polite"
            >
              {status === "error" ? "Heatmap temporarily unavailable" : "Loading S&P 500 heatmap…"}
            </div>
          )}
          <button
            type="button"
            className="tv-stock-heatmap-touch-toggle"
            aria-pressed={touchInteractive}
            aria-label={touchInteractive ? "Disable heatmap interaction" : "Enable heatmap interaction"}
            onClick={() => setTouchInteractive((current) => !current)}
          >
            {touchInteractive ? "Done" : "Interact"}
          </button>
        </div>
      </section>
    </div>
  );
}
