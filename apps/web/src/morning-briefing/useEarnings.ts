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
const EARNINGS_MONTH_REVALIDATE_MS = 60 * 60_000;
const EARNINGS_MONTH_CACHE_CHECK_MS = 5 * 60_000;
const EARNINGS_MONTH_REVALIDATE_RETRY_MS = 15 * 60_000;
const MAX_MONTH_CACHE_ENTRIES = 8;

type MonthCacheEntry = {
  earnings: EarningsCompany[];
  available: boolean;
  fetchedAt: number;
  /** Last stale-cache refresh attempt; stored inside the bounded cache. */
  lastRevalidationAt?: number;
};

const monthCache = new Map<string, MonthCacheEntry>();
let monthRequestSequence = 0;
const activeMonthRequests = new Map<string, number>();

/** Test helper — clears the bounded month cache between cases. */
export function clearEarningsMonthCache(): void {
  monthCache.clear();
  activeMonthRequests.clear();
  monthRequestSequence = 0;
}

/** Test helper — verifies cache and request bookkeeping stay bounded/ephemeral. */
export function getEarningsMonthCacheStats(): { cacheEntries: number; activeRequests: number } {
  return {
    cacheEntries: monthCache.size,
    activeRequests: activeMonthRequests.size,
  };
}

function rememberMonth(key: string, entry: MonthCacheEntry): void {
  // Refreshing a month also refreshes its eviction position.
  monthCache.delete(key);
  monthCache.set(key, entry);
  while (monthCache.size > MAX_MONTH_CACHE_ENTRIES) {
    const oldest = monthCache.keys().next().value;
    if (oldest === undefined) break;
    monthCache.delete(oldest);
  }
}

function currentMarketMonthKey(now = Date.now()): string {
  return marketTodayKey(now).slice(0, 7);
}

function monthNeedsRevalidation(
  period: CalendarPeriod,
  entry: MonthCacheEntry,
  now = Date.now(),
): boolean {
  // Closed historical months are effectively immutable in the browser cache.
  if (monthCacheKey(period) < currentMarketMonthKey(now)) return false;
  return now - entry.fetchedAt >= EARNINGS_MONTH_REVALIDATE_MS;
}

function monthRevalidationRetryDue(entry: MonthCacheEntry, now = Date.now()): boolean {
  return entry.lastRevalidationAt === undefined
    || now - entry.lastRevalidationAt >= EARNINGS_MONTH_REVALIDATE_RETRY_MS;
}

async function fetchMonth(period: CalendarPeriod, signal?: AbortSignal): Promise<MonthCacheEntry | null> {
  const key = monthCacheKey(period);
  const requestVersion = ++monthRequestSequence;
  activeMonthRequests.set(key, requestVersion);

  try {
    const response = await fetchJson<EarningsApiResponse | unknown>(
      earningsApiPath(monthDateRange(period)),
      { signal },
    );
    if (signal?.aborted || response === null) return null;

    const parsed = earningsFromApi(response);
    if (parsed === null || activeMonthRequests.get(key) !== requestVersion) return null;

    const entry: MonthCacheEntry = {
      earnings: parsed,
      available: true,
      fetchedAt: Date.now(),
    };
    rememberMonth(key, entry);
    return entry;
  } finally {
    // Only the latest same-month request may clear its slot. Superseded requests
    // leave the newer request registered until that request finishes.
    if (activeMonthRequests.get(key) === requestVersion) {
      activeMonthRequests.delete(key);
    }
  }
}

export type EarningsMonthState = {
  earnings: EarningsCompany[];
  /** Whether the latest request for this month completed successfully. */
  available: boolean;
  loading: boolean;
  /** True when last-known-good data is visible past its refresh TTL. */
  stale: boolean;
};

/**
 * Fetch-on-month calendar data from D1 via /api/earnings.
 * Cached by YYYY-MM with stale-while-revalidate for current/future months.
 * Cached data stays visible while a stale entry refreshes in the background.
 * Closed historical months remain cache-stable and request races cannot win.
 */
export function useEarningsMonth(period: CalendarPeriod): EarningsMonthState {
  const periodKey = monthCacheKey(period);
  const [state, setState] = useState<EarningsMonthState>(() => {
    const cached = monthCache.get(periodKey);
    return {
      earnings: cached?.earnings ?? [],
      available: cached?.available ?? false,
      loading: !cached,
      stale: cached ? monthNeedsRevalidation(period, cached) : false,
    };
  });

  useEffect(() => {
    let cancelled = false;
    let requestId = 0;
    let revalidationInFlight = false;
    let activeController: AbortController | null = null;
    const target = { year: period.year, month: period.month };

    const applyEntry = (entry: MonthCacheEntry, stale = false) => {
      setState({
        earnings: entry.earnings,
        available: entry.available,
        loading: false,
        stale,
      });
    };

    const revalidate = async (cached: MonthCacheEntry | null) => {
      if (revalidationInFlight) return;
      revalidationInFlight = true;
      const currentRequest = ++requestId;
      activeController?.abort();
      const controller = new AbortController();
      activeController = controller;

      let revalidationBase = cached;
      if (cached) {
        // Persist attempts inside the bounded month entry, so navigation/remounts
        // cannot bypass the retry cooldown after a failed refresh.
        const latest = monthCache.get(periodKey) ?? cached;
        revalidationBase = { ...latest, lastRevalidationAt: Date.now() };
        monthCache.set(periodKey, revalidationBase);
      } else {
        // Keep previously rendered events until a different uncached month arrives.
        setState((previous) => ({ ...previous, loading: true, stale: false }));
      }

      try {
        const entry = await fetchMonth(target, controller.signal);
        if (cancelled || currentRequest !== requestId) return;

        if (entry) {
          applyEntry(entry, false);
        } else if (!revalidationBase) {
          setState({ earnings: [], available: false, loading: false, stale: false });
        } else {
          // Preserve last-known-good rows after a failed refresh and persist the
          // latest source availability without changing fetchedAt or LRU order.
          const fallback = monthCache.get(periodKey) ?? revalidationBase;
          const unavailable: MonthCacheEntry = { ...fallback, available: false };
          monthCache.set(periodKey, unavailable);
          setState({
            earnings: unavailable.earnings,
            available: false,
            loading: false,
            stale: monthNeedsRevalidation(target, unavailable),
          });
        }
      } finally {
        revalidationInFlight = false;
      }
    };

    const cached = monthCache.get(periodKey) ?? null;
    if (cached) {
      const stale = monthNeedsRevalidation(target, cached);
      applyEntry(cached, stale);
      if (stale && monthRevalidationRetryDue(cached)) void revalidate(cached);
    } else {
      void revalidate(null);
    }

    const refreshIfDue = () => {
      const latest = monthCache.get(periodKey);
      if (!latest || !monthNeedsRevalidation(target, latest)) return;

      applyEntry(latest, true);
      if (!revalidationInFlight && monthRevalidationRetryDue(latest)) {
        void revalidate(latest);
      }
    };
    const interval = window.setInterval(refreshIfDue, EARNINGS_MONTH_CACHE_CHECK_MS);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") refreshIfDue();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      cancelled = true;
      requestId += 1;
      revalidationInFlight = false;
      activeController?.abort();
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
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
