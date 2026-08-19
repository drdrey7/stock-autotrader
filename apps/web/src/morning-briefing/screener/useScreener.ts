import { useEffect, useState } from "react";
import type { ScreenerApiResponse } from "@stock-autotrader/contracts";
import { fetchJson } from "../api-client";
import { normalizeScreenerResponse } from "./screener-compat";

/** Silent refresh cadence — the collector owns data freshness, not the UI. */
const REFRESH_INTERVAL_MS = 60_000;

export interface ScreenerState {
  data: ScreenerApiResponse | null;
  loading: boolean;
  /** True when the last fetch failed/non-2xx (distinct from honest empty data). */
  error: boolean;
}

/**
 * Loads /api/screener (D1 only — never Finnhub from the browser) and
 * re-fetches in the background. Uses the shared api-client so raw fetch stays
 * centralized in morning-briefing/api-client.ts.
 *
 * The payload passes through `normalizeScreenerResponse` (screener-compat):
 * the Cloudflare PR preview proxies /api/* to the PRODUCTION worker, which
 * can still emit the pre-PR2 shape whose rows lack the SMA fields. A
 * compatibility boundary maps those missing fields to their unavailable
 * defaults so an old payload renders normally ("—") instead of crashing on
 * `.toFixed(undefined)`.
 */
export function useScreener(intervalMs = REFRESH_INTERVAL_MS): ScreenerState {
  const [state, setState] = useState<ScreenerState>({ data: null, loading: true, error: false });

  useEffect(() => {
    let disposed = false;
    let timer: number | undefined;

    const load = async (): Promise<void> => {
      const result = await fetchJson<unknown>("/api/screener");
      const normalized = normalizeScreenerResponse(result);
      if (disposed) return;
      // Retain the last known data on a transient refresh failure — the
      // explicit error flag is what drives the UI, never a silent stale read.
      setState((previous) => ({
        data: normalized ?? previous.data,
        loading: false,
        error: normalized === null,
      }));
      timer = window.setTimeout(() => void load(), intervalMs);
    };

    void load();
    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [intervalMs]);

  return state;
}
