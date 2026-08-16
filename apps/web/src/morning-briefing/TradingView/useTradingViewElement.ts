import { useEffect, useState } from "react";
import { loadTradingViewElement } from "./loader";

export type TradingViewWidgetStatus = "loading" | "ready" | "error";

/**
 * Tracks the load status of one TradingView web-component module.
 *
 * The host component renders its own loading surface until the module is
 * upgradeable and its restrained error state if the module fails (e.g. the
 * third-party host is unreachable) — the page must never crash or go blank
 * because a market widget did not load.
 */
export function useTradingViewElement(locale: string, elementName: string): {
  status: TradingViewWidgetStatus;
  error: string | null;
} {
  const [status, setStatus] = useState<TradingViewWidgetStatus>("loading");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    setError(null);
    loadTradingViewElement(locale, elementName)
      .then(() => {
        if (!cancelled) setStatus("ready");
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setStatus("error");
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [locale, elementName]);

  return { status, error };
}
