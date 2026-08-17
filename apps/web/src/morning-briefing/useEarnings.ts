import { useEffect, useState } from "react";
import type { EarningsApiResponse } from "@stock-autotrader/contracts";
import { fetchJson } from "./api-client";
import {
  type CalendarPeriod,
  type EarningsCompany,
  earningsApiPath,
  earningsFromApi,
  marketTodayKey,
  monthCacheKey,
  monthDateRange,
  pastEarningsRange,
  readApiSummary,
  shiftMarketDateKey,
  summaryEarningsRange,
  mondayWeekBounds,
  EARNINGS_CLIENT_SUMMARY_FORWARD_DAYS,
} from "./earnings-api";

// Re-export pure helpers so existing imports from ./useEarnings keep working.
export {
  marketTodayKey,
  shiftMarketDateKey,
  monthDateRange,
  pastEarningsRange,
  summaryEarningsRange,
  earningsApiPath,
  monthCacheKey,
  earningsFromApi,
  EARNINGS_CLIENT_PAST_DAYS,
  EARNINGS_CLIENT_SUMMARY_FORWARD_DAYS,
} from "./earnings-api";
export type { CalendarPeriod, EarningsCompany, EarningsDateRange } from "./earnings-api";

const EARNINGS_REFRESH_INTERVAL_MS = 60 * 60_000;
const MAX_MONTH_CACHE_ENTRIES = 8;

type MonthCacheEntry = {
  earnings: EarningsCompany[];
  available: boolean;
};

const monthCache = new Map<string, MonthCacheEntry>();

/** Test helper — clears the bounded month cache between cases. */
export function clearEarningsMonthCache(): void {
  monthCache.clear();
}

function rememberMonth(key: string, entry: MonthCacheEntry): void {
  monthCache.set(key, entry);
  while (monthCache.size > MAX_MONTH_CACHE_ENTRIES) {
    const oldest = monthCache.keys().next().value;
    if (oldest === undefined) break;
    monthCache.delete(oldest);
  }
}

async function loadMonth(period: CalendarPeriod, signal?: AbortSignal): Promise<MonthCacheEntry> {
  const key = monthCacheKey(period);
  const cached = monthCache.get(key);
  if (cached) return cached;

  const response = await fetchJson<EarningsApiResponse | unknown>(
    earningsApiPath(monthDateRange(period)),
    { signal },
  );
  if (signal?.aborted) return { earnings: [], available: false };

  const parsed = response === null ? null : earningsFromApi(response);
  const entry: MonthCacheEntry = {
    earnings: parsed ?? [],
    available: parsed !== null,
  };
  if (parsed !== null) rememberMonth(key, entry);
  return entry;
}

export type EarningsMonthState = {
  earnings: EarningsCompany[];
  available: boolean;
  loading: boolean;
};

/**
 * Fetch-on-month calendar data from D1 via /api/earnings.
 * Cached by YYYY-MM so Aug→Jul→Aug does not immediately refetch August.
 * Stale responses cannot overwrite a newer selected month (effect cleanup + abort).
 */
export function useEarningsMonth(period: CalendarPeriod): EarningsMonthState {
  const periodKey = monthCacheKey(period);
  const [state, setState] = useState<EarningsMonthState>(() => {
    const cached = monthCache.get(periodKey);
    return {
      earnings: cached?.earnings ?? [],
      available: cached?.available ?? false,
      loading: !cached,
    };
  });

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const target = { year: period.year, month: period.month };
    const cached = monthCache.get(periodKey);
    if (cached) {
      setState({
        earnings: cached.earnings,
        available: cached.available,
        loading: false,
      });
      return () => {
        cancelled = true;
        controller.abort();
      };
    }

    // Keep previously rendered events until the new month arrives (no full flash).
    setState((previous) => ({ ...previous, loading: true }));

    void loadMonth(target, controller.signal).then((entry) => {
      if (cancelled) return;
      setState({
        earnings: entry.earnings,
        available: entry.available,
        loading: false,
      });
    });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [period.year, period.month, periodKey]);

  return state;
}

export type PastEarningsState = {
  earnings: EarningsCompany[];
  available: boolean;
};

/**
 * Independent rolling 30-day Past Earnings surface.
 * Always queries from=marketToday-29 .. to=marketToday (Dec→Jan safe).
 */
export function usePastEarnings(): PastEarningsState {
  const [state, setState] = useState<PastEarningsState>({ earnings: [], available: false });

  useEffect(() => {
    let cancelled = false;
    let requestId = 0;
    let lastAttemptAt = 0;
    let lastAttemptDate: string | null = null;
    let activeController: AbortController | null = null;

    const refresh = async (force = false) => {
      const today = marketTodayKey();
      const now = Date.now();
      const refreshDue = force
        || lastAttemptDate !== today
        || now - lastAttemptAt >= EARNINGS_REFRESH_INTERVAL_MS;
      if (!refreshDue) return;

      lastAttemptAt = now;
      lastAttemptDate = today;
      const currentRequest = ++requestId;
      activeController?.abort();
      const controller = new AbortController();
      activeController = controller;

      const range = pastEarningsRange(today);
      const response = await fetchJson<EarningsApiResponse | unknown>(
        earningsApiPath(range),
        { signal: controller.signal },
      );
      if (cancelled || currentRequest !== requestId) return;

      const parsed = response === null ? null : earningsFromApi(response);
      const past = (parsed ?? []).filter((event) => (
        event.scheduledDate !== null
        && event.scheduledDate >= range.from
        && event.scheduledDate <= range.to
        && event.status !== "scheduled"
      )).sort((a, b) => (b.scheduledDate ?? "").localeCompare(a.scheduledDate ?? ""));

      setState({
        earnings: past,
        available: parsed !== null,
      });
    };

    void refresh(true);
    const interval = window.setInterval(() => { void refresh(); }, 60_000);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      cancelled = true;
      activeController?.abort();
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  return state;
}

export type EarningsSummaryState = {
  today: number;
  thisWeek: number;
  next30Days: number;
  available: boolean;
};

/**
 * TODAY / THIS WEEK / NEXT 30 DAYS — independent of the viewed calendar month.
 * Queries Monday-start week through marketToday+30.
 */
export function useEarningsSummary(): EarningsSummaryState {
  const [state, setState] = useState<EarningsSummaryState>({
    today: 0,
    thisWeek: 0,
    next30Days: 0,
    available: false,
  });

  useEffect(() => {
    let cancelled = false;
    let requestId = 0;
    let lastAttemptAt = 0;
    let lastAttemptDate: string | null = null;
    let activeController: AbortController | null = null;

    const refresh = async (force = false) => {
      const today = marketTodayKey();
      const now = Date.now();
      const refreshDue = force
        || lastAttemptDate !== today
        || now - lastAttemptAt >= EARNINGS_REFRESH_INTERVAL_MS;
      if (!refreshDue) return;

      lastAttemptAt = now;
      lastAttemptDate = today;
      const currentRequest = ++requestId;
      activeController?.abort();
      const controller = new AbortController();
      activeController = controller;

      const range = summaryEarningsRange(today);
      const response = await fetchJson<EarningsApiResponse | unknown>(
        earningsApiPath(range),
        { signal: controller.signal },
      );
      if (cancelled || currentRequest !== requestId) return;

      if (response === null) {
        setState({ today: 0, thisWeek: 0, next30Days: 0, available: false });
        return;
      }

      const apiSummary = readApiSummary(response);
      if (apiSummary) {
        setState({ ...apiSummary, available: true });
        return;
      }

      const events = earningsFromApi(response);
      if (events === null) {
        setState({ today: 0, thisWeek: 0, next30Days: 0, available: false });
        return;
      }

      const { weekStart, weekEnd } = mondayWeekBounds(today);
      const next30Key = shiftMarketDateKey(today, EARNINGS_CLIENT_SUMMARY_FORWARD_DAYS);
      setState({
        today: events.filter((event) => event.scheduledDate === today).length,
        thisWeek: events.filter((event) => (
          event.scheduledDate !== null
          && event.scheduledDate >= weekStart
          && event.scheduledDate <= weekEnd
        )).length,
        next30Days: events.filter((event) => (
          event.scheduledDate !== null
          && event.scheduledDate >= today
          && event.scheduledDate <= next30Key
        )).length,
        available: true,
      });
    };

    void refresh(true);
    const interval = window.setInterval(() => { void refresh(); }, 60_000);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      cancelled = true;
      activeController?.abort();
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  return state;
}

/**
 * @deprecated Prefer useEarningsMonth / usePastEarnings / useEarningsSummary.
 * Thin Past Earnings alias for isolation tests and barrel re-exports.
 */
export function useEarnings(): PastEarningsState {
  return usePastEarnings();
}
