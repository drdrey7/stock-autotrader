import { useEffect, useRef, useState } from "react";
import { useShellTheme } from "../shell/theme";

/**
 * Single reusable TradingView widget integration.
 *
 * This is the ONLY place that loads the TradingView bootstrap scripts. Each
 * widget type maps to one official embed script
 * (https://s3.tradingview.com/external-embedding/embed-widget-<type>.js) that
 * reads its config from the script's own JSON text and self-replaces with an
 * <iframe> hosted on tradingview-widget.com. TradingView owns the market-data
 * display layer — no data is proxied through our backend.
 *
 * Behaviour contract (used by the tests):
 *  - renders the `tradingview-widget-container` + required `.tradingview-widget-copyright`
 *    attribution that the widget script preserves;
 *  - injects exactly one script element per mount, tagged `data-tv-widget="<type>"`;
 *  - re-injects the script when the app theme changes so `colorTheme` always
 *    matches (widgets cannot change theme in place, so we remount cleanly);
 *  - lazy-loads below-the-fold widgets via IntersectionObserver;
 *  - never fabricates data: if the script fails to load or no iframe appears
 *    within the timeout, a restrained "Market widget temporarily unavailable"
 *    state is shown instead of fake/demo values.
 */
export type TradingViewWidgetType = "ticker-tape" | "market-overview" | "events" | "timeline";

const SCRIPT_BASE = "https://s3.tradingview.com/external-embedding";
const WIDGET_SCRIPTS: Record<TradingViewWidgetType, string> = {
  "ticker-tape": "embed-widget-ticker-tape.js",
  "market-overview": "embed-widget-market-overview.js",
  events: "embed-widget-events.js",
  timeline: "embed-widget-timeline.js",
};
const IFRAME_TIMEOUT_MS = 20_000;

export type TradingViewWidgetSettings = Record<string, unknown>;

export function TradingViewWidget({
  type,
  settings,
  lazy = true,
  className = "",
}: {
  type: TradingViewWidgetType;
  settings: TradingViewWidgetSettings;
  lazy?: boolean;
  className?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { theme } = useShellTheme();
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [inView, setInView] = useState(!lazy);

  // Below-the-fold widgets wait until they scroll near the viewport before any
  // third-party script is injected. IntersectionObserver is absent in jsdom,
  // so tests fall back to loading immediately.
  useEffect(() => {
    if (inView) return;
    if (typeof IntersectionObserver !== "function") {
      setInView(true);
      return;
    }
    const element = containerRef.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setInView(true);
          observer.disconnect();
        }
      },
      { rootMargin: "400px 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [lazy, inView]);

  // The full config is a pure function of (type, theme, settings); the widget
  // script is re-injected whenever that config changes so colorTheme matches
  // the active app theme. The string key keeps the dependency honest for
  // callers that pass a fresh object every render.
  const fullConfig = JSON.stringify({ colorTheme: theme, ...settings });

  useEffect(() => {
    if (!inView) return;
    const container = containerRef.current;
    if (!container) return;

    let cancelled = false;
    setStatus("loading");

    const slot = document.createElement("div");
    slot.className = "tradingview-widget-container__widget tv-widget-slot";

    // Required TradingView attribution. The widget script reads this element
    // and preserves it beside the iframe.
    const copyright = document.createElement("div");
    copyright.className = "tradingview-widget-copyright";
    const link = document.createElement("a");
    link.href = "https://www.tradingview.com/";
    link.rel = "noopener nofollow";
    link.target = "_blank";
    const span = document.createElement("span");
    span.className = "blue-text";
    span.textContent = "Track all markets on TradingView";
    link.appendChild(span);
    copyright.appendChild(link);

    const script = document.createElement("script");
    script.type = "text/javascript";
    script.async = true;
    script.dataset.tvWidget = type;
    script.src = `${SCRIPT_BASE}/${WIDGET_SCRIPTS[type]}`;
    script.textContent = fullConfig;

    container.appendChild(slot);
    container.appendChild(copyright);
    container.appendChild(script);

    const onError = () => {
      if (!cancelled) setStatus("error");
    };
    script.addEventListener("error", onError);

    // The script replaces the slot with the widget's iframe once it runs.
    const observer = new MutationObserver(() => {
      if (!cancelled && container.querySelector("iframe")) setStatus("ready");
    });
    observer.observe(container, { childList: true, subtree: true });

    const timeout = window.setTimeout(() => {
      // Script loaded but no widget rendered (e.g. rejected config): fail
      // closed rather than leave an empty panel.
      if (!cancelled && !container.querySelector("iframe")) setStatus("error");
    }, IFRAME_TIMEOUT_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
      observer.disconnect();
      script.removeEventListener("error", onError);
      script.remove();
      container
        .querySelectorAll("iframe, .tv-widget-slot, .tradingview-widget-copyright, script[data-tv-widget]")
        .forEach((element) => element.parentNode?.removeChild(element));
    };
  }, [type, inView, fullConfig]);

  return (
    <div
      className={`tradingview-widget-container tv-widget-container tv-widget-${type}${className ? ` ${className}` : ""}`}
      ref={containerRef}
      data-theme={theme}
    >
      {status !== "ready" && (
        <div
          className={`tv-widget-state${status === "error" ? " tv-widget-error" : " tv-widget-loading"}`}
          role={status === "error" ? "alert" : "status"}
          aria-live="polite"
        >
          {status === "error" ? "Market widget temporarily unavailable" : "Loading market data…"}
        </div>
      )}
    </div>
  );
}
