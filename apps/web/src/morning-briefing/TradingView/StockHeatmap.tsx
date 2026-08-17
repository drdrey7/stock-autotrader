import { useEffect, useRef, useState } from "react";
import { useShellTheme } from "../../shell/theme";

const STOCK_HEATMAP_SCRIPT = "https://s3.tradingview.com/external-embedding/embed-widget-stock-heatmap.js";
const RENDER_TIMEOUT_MS = 20_000;

/**
 * Official TradingView S&P 500 stock heatmap.
 *
 * The top toolbar and data-source switcher stay disabled so the widget feels
 * native to the Morning Briefing surface instead of embedding the TradingView
 * site chrome. The script is mounted only while this route is open and is
 * rebuilt on theme changes because TradingView iframe widgets cannot re-theme
 * in place.
 */
export function StockHeatmap() {
  const embedRef = useRef<HTMLDivElement>(null);
  const { theme } = useShellTheme();
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

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
      blockColor: "change",
      grouping: "sector",
      locale: "en",
      symbolUrl: "",
      colorTheme: theme,
      exchanges: [],
      hasTopBar: false,
      isDataSetEnabled: false,
      isZoomEnabled: true,
      hasSymbolTooltip: true,
      isMonoSize: false,
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
  }, [theme]);

  return (
    <div className="tv-stock-heatmap" data-theme={theme} data-tv-status={status}>
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
    </div>
  );
}
