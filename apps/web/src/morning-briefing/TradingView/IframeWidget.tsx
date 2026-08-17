import { useEffect, useRef, useState } from "react";
import { useShellTheme } from "../../shell/theme";

const SCRIPT_BASE = "https://s3.tradingview.com/external-embedding";
const IFRAME_TIMEOUT_MS = 20_000;

interface TradingViewIframeWidgetProps {
  /** Container-id suffix; TradingView renders its iframe into `tradingview-${id}`. */
  id: string;
  /** Official embed script filename, e.g. "embed-widget-events.js". */
  script: string;
  /** Non-theme widget config (theme + container id are merged in here). */
  config: Record<string, unknown>;
  /** Widget iframe height in px; also holds the loading surface open. */
  height: number;
  /** Lazy-load below the fold via IntersectionObserver. */
  lazy?: boolean;
  className?: string;
}

/**
 * TradingView iframe widget (Economic Calendar, Top Stories).
 *
 * The official embed snippet injects an `embed-widget-*.js` script whose own
 * JSON text is the config; the script self-replaces with an <iframe> hosted on
 * tradingview-widget.com. The script and its config are re-injected whenever
 * the theme changes so `colorTheme` always matches (iframe widgets cannot
 * re-theme in place, so we remount cleanly). We never fabricate data: if the
 * script fails or no iframe appears within the timeout, a restrained
 * "temporarily unavailable" state is shown.
 */
export function TradingViewIframeWidget({
  id,
  script,
  config,
  height,
  lazy = true,
  className = "",
}: TradingViewIframeWidgetProps) {
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

  const containerId = `tradingview-${id}`;
  // Theme-controlled fields are applied last on purpose. This prevents any
  // caller config from accidentally overriding the shell theme and leaving an
  // iframe light while the rest of the application is dark (or vice versa).
  const fullConfig = JSON.stringify({
    ...config,
    container_id: containerId,
    width: "100%",
    height,
    colorTheme: theme,
  });

  useEffect(() => {
    if (!inView) return;
    const container = containerRef.current;
    if (!container) return;

    let cancelled = false;
    setStatus("loading");

    // The official embed snippet ships this attribution next to the widget and
    // TradingView's script preserves it beside the iframe it renders.
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

    const slot = document.createElement("div");
    slot.id = containerId;
    slot.className = "tv-widget-slot";

    const scriptEl = document.createElement("script");
    scriptEl.type = "text/javascript";
    scriptEl.async = true;
    scriptEl.dataset.tvIframeWidget = id;
    scriptEl.src = `${SCRIPT_BASE}/${script}`;
    scriptEl.textContent = fullConfig;

    container.appendChild(copyright);
    container.appendChild(slot);
    container.appendChild(scriptEl);

    const onError = () => {
      if (!cancelled) setStatus("error");
    };
    scriptEl.addEventListener("error", onError);

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
      scriptEl.removeEventListener("error", onError);
      scriptEl.remove();
      container
        .querySelectorAll("iframe, .tv-widget-slot, .tradingview-widget-copyright, script[data-tv-iframe-widget]")
        .forEach((element) => element.remove());
    };
  }, [script, id, containerId, fullConfig, inView]);

  return (
    <div
      ref={containerRef}
      data-tv-widget={id}
      data-theme={theme}
      style={{ minHeight: height }}
      className={`tradingview-widget-container tv-widget-container tv-widget-iframe tv-widget-${id}${className ? ` ${className}` : ""}`}
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
