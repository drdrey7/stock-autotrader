import { useEffect, useMemo, useRef } from "react";
import type { ShellTheme } from "../../shell/theme";
import { useTradingViewElement } from "./useTradingViewElement";
import { MARKET_OVERVIEW_PROPS, type TradingViewMarketSection } from "./tradingview-config";

interface MarketOverviewProps {
  sections: readonly TradingViewMarketSection[];
  colorTheme: ShellTheme;
  /** Chart period applied to each section's rows. */
  timeFrame?: string;
  /** custom = the `sections` list above; movers = TV's default movers feed. */
  mode?: "custom" | "movers";
  locale?: string;
  className?: string;
}

/**
 * Official `<tv-market-overview>` web component.
 *
 * Renders the section tabs plus the active section's rows, updating in place
 * on `theme` changes. TradingView's current web-component API uses `theme`
 * (not the legacy iframe-style `colorTheme` / `color-theme`) to force light or
 * dark mode. The `symbol-sectors` attribute carries the JSON sections config,
 * so every row is a pre-verified symbol (see tradingview-config.ts) — no blank
 * rows, no "No data here yet".
 */
export function MarketOverview({
  sections,
  colorTheme,
  timeFrame = MARKET_OVERVIEW_PROPS.timeFrame,
  mode = MARKET_OVERVIEW_PROPS.mode,
  locale = "en",
  className = "",
}: MarketOverviewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const { status } = useTradingViewElement(locale, "tv-market-overview");
  const sectionsJson = useMemo(() => JSON.stringify(sections), [sections]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const el = document.createElement("tv-market-overview");
    el.setAttribute("mode", mode);
    el.setAttribute("symbol-sectors", sectionsJson);
    el.setAttribute("time-frame", timeFrame);
    el.setAttribute("theme", colorTheme);
    host.appendChild(el);
    return () => {
      el.remove();
    };
    // colorTheme intentionally excluded: synced in-place below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sectionsJson, mode, timeFrame, locale]);

  useEffect(() => {
    hostRef.current?.querySelector("tv-market-overview")?.setAttribute("theme", colorTheme);
  }, [colorTheme]);

  return (
    <div
      ref={hostRef}
      className={`tv-wc-host tv-market-overview-host${className ? ` ${className}` : ""}`}
      data-tv-status={status}
    >
      {status === "error" && (
        <p className="tv-wc-error" role="alert">
          Market overview temporarily unavailable
        </p>
      )}
    </div>
  );
}
