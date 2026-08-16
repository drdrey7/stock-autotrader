import { useEffect, useMemo, useRef } from "react";
import type { ShellTheme } from "../../shell/theme";
import { useTradingViewElement } from "./useTradingViewElement";

interface TickerTapeProps {
  symbols: readonly string[];
  colorTheme: ShellTheme;
  /** compact = thin terminal tape (48px); normal = larger items (74px). */
  itemSize?: "compact" | "normal";
  locale?: string;
  className?: string;
}

/**
 * Official `<tv-ticker-tape>` web component.
 *
 * The module is loaded exactly once via `loader.ts`; the element is created
 * immediately (it upgrades in place when the module arrives and shows
 * TradingView's own skeleton while fetching quotes). Theme is applied through
 * the `color-theme` attribute and updates in place — theme changes never tear
 * the tape down and rebuild it.
 */
export function TickerTape({
  symbols,
  colorTheme,
  itemSize = "compact",
  locale = "en",
  className = "",
}: TickerTapeProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const { status } = useTradingViewElement(locale, "tv-ticker-tape");
  // A stable dependency key: callers pass module-level arrays, but joining here
  // also absorbs parents that inline a fresh array literal every render.
  const symbolList = useMemo(() => symbols.join(","), [symbols]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const el = document.createElement("tv-ticker-tape");
    el.setAttribute("symbols", symbolList);
    el.setAttribute("item-size", itemSize);
    el.setAttribute("color-theme", colorTheme);
    host.appendChild(el);
    return () => {
      el.remove();
    };
    // colorTheme intentionally excluded: it is synced in-place below so a theme
    // toggle does not unmount/remount the tape.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbolList, itemSize, locale]);

  useEffect(() => {
    hostRef.current?.querySelector("tv-ticker-tape")?.setAttribute("color-theme", colorTheme);
  }, [colorTheme]);

  return (
    <div
      ref={hostRef}
      className={`tv-wc-host tv-ticker-host${className ? ` ${className}` : ""}`}
      data-tv-status={status}
    >
      {status === "error" && (
        <p className="tv-wc-error" role="alert">
          Market tape temporarily unavailable
        </p>
      )}
    </div>
  );
}
