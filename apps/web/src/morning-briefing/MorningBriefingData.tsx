/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { DailyBriefing, EarningsEvent } from "@stock-autotrader/contracts";
import type { MarketIndex } from "./data/market";
import { opportunities as mockOpportunities, type Opportunity } from "./data/opportunities";
import { type XPost } from "./data/xSurge";
import { earnings as mockEarnings, type EarningsCompany } from "./data/earnings";

type BriefingHealth = {
  available: boolean;
  freshness: "fresh" | "stale" | "unavailable";
  publishedAt: string | null;
};

type StatusResponse = {
  briefing?: BriefingHealth;
};

type XApiPost = {
  id: string;
  author: string;
  text: string;
  created_at: string;
  url: string;
  symbol: string | null;
  company: string | null;
  price: string | null;
  change: string | null;
};

type XResponse = { posts?: XApiPost[]; count?: number };

export type MorningBriefingData = {
  marketIndexes: MarketIndex[];
  opportunities: Opportunity[];
  xPosts: XPost[];
  earnings: EarningsCompany[];
  // The published edition shown, with the timestamps that label the data.
  editionDate: string | null;
  editionType: DailyBriefing["editionType"] | null;
  marketUpdatedAt: string | null;
  opportunitiesUpdatedAt: string | null;
};

function normaliseEarnings(items: EarningsCompany[], today = marketTodayKey()): EarningsCompany[] {
  return items.map((item) => item.result === "Upcoming" && item.date < today
    ? { ...item, result: "Pending" as const }
    : item);
}

const initialData: MorningBriefingData = {
  // Financially actionable sections stay empty until the backend publishes
  // validated data. Static fixtures remain available internally for colours
  // and development, but are never presented as current market information.
  marketIndexes: [],
  opportunities: [],
  xPosts: [],
  earnings: [],
  editionDate: null,
  editionType: null,
  marketUpdatedAt: null,
  opportunitiesUpdatedAt: null,
};

const MorningBriefingDataContext = createContext<MorningBriefingData>(initialData);

const numberFrom = (value: string | number | null | undefined): number | null => {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (!value || !/[0-9]/.test(value)) return null;
  const parsed = Number(value.replace(/[−–—]/g, "-").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
};

const changeFrom = (value: string | null | undefined): number | null => numberFrom(value);

const tickerColour = (ticker: string): string => {
  const known = [...mockOpportunities, ...mockEarnings].find((item) =>
    "ticker" in item && item.ticker === ticker
  );
  return known?.color ?? "#176b47";
};

const relativeTime = (iso: string): string => {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "recent";
  const minutes = Math.max(0, Math.floor((Date.now() - then) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours ? `${days}d ${remainingHours}h` : `${days}d`;
};

const REQUEST_TIMEOUT_MS = 8_000;
const EARNINGS_REFRESH_INTERVAL_MS = 60 * 60_000;
const X_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
// Market data is the only section that must never show stale numbers as
// today's: a fresh briefing (status freshness "fresh") published within this
// window is the gate for market cards.
const MARKET_DATA_MAX_AGE_MS = 26 * 60 * 60_000;
// Everything else (opportunities, earnings) is a daily publication: hours or
// even a couple of days of age are fine as long as the edition date is shown.
const BRIEFING_MAX_AGE_MS = 72 * 60 * 60_000;

async function fetchJson<T>(path: string): Promise<T | null> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(path, { headers: { accept: "application/json" }, signal: controller.signal });
    if (!response.ok) return null;
    return await response.json() as T;
  } catch {
    return null;
  } finally {
    window.clearTimeout(timeout);
  }
}

function isWithinWindow(value: string | null | undefined, maxAgeMs: number): boolean {
  const timestamp = Date.parse(value ?? "");
  const ageMs = Date.now() - timestamp;
  return Number.isFinite(timestamp) && ageMs >= -5 * 60_000 && ageMs <= maxAgeMs;
}

function marketFromBriefing(briefing: DailyBriefing): MarketIndex[] | null {
  const live = briefing.market.flatMap((item) => {
    const value = numberFrom(item.value); const change = changeFrom(item.change);
    if (value === null || change === null) return [];
    return [{
      name: item.name === "Nasdaq-100" ? "Nasdaq" : item.name,
      symbol: item.symbol.split(":").at(-1) ?? item.symbol,
      value,
      decimals: 2,
      change,
      source: "live" as const,
    }];
  });
  const findBenchmark = (name: string, symbol: string) => live.find((item) =>
    item.name.toLowerCase().includes(name) || item.symbol.toUpperCase() === symbol
  );
  const sp500 = findBenchmark("s&p", "SPX");
  const ordered: MarketIndex[] = [];
  if (sp500) ordered.push(sp500);
  const nasdaq = findBenchmark("nasdaq", "NDX");
  if (nasdaq) ordered.push(nasdaq);
  const vix = findBenchmark("vix", "VIX");
  if (vix) ordered.push(vix);
  return sp500
    ? [...ordered, ...live.filter((item) => !ordered.includes(item))].slice(0, 4)
    : null;
}

function opportunitiesFromBriefing(
  briefing: DailyBriefing,
): Opportunity[] {
  return briefing.ideas.filter((idea) => idea.verdict === "Potential Entry").map((idea) => {
    return {
      ticker: idea.symbol,
      company: idea.company,
      change: changeFrom(idea.change),
      confidence: null,
      score: null,
      thesis: idea.thesis,
      trigger: idea.levels.trigger,
      invalidation: idea.levels.invalidation,
      objective: idea.levels.objective,
      risk: idea.levels.invalidation,
      verdict: idea.verdict,
      reference: idea.source.reference,
      color: tickerColour(idea.symbol),
      source: "live",
    };
  });
}

function isWithinXCacheWindow(createdAt: string): boolean {
  const timestamp = Date.parse(createdAt);
  const ageMs = Date.now() - timestamp;
  return Number.isFinite(timestamp) && ageMs >= -5 * 60_000 && ageMs <= X_CACHE_MAX_AGE_MS;
}

function xPostsFromApi(posts: XApiPost[]): XPost[] {
  return [...posts]
    .filter((post) => isWithinXCacheWindow(post.created_at))
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
    .map((post) => ({
    category: "Markets",
    name: post.company || post.author.replace(/^@/, ""),
    handle: post.author,
    time: relativeTime(post.created_at),
    createdAt: post.created_at,
    text: post.text,
    likes: "—",
    reposts: "—",
    replies: "—",
    color: "#176b47",
    url: post.url,
    source: "live",
  }));
}

const X_CACHE_KEY = "morning-briefing-x-post-cache-v1";

function readStoredXPosts(): XPost[] {
  try {
    const raw = window.localStorage.getItem(X_CACHE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((post): post is XPost => (
      typeof post === "object" && post !== null
      && typeof (post as XPost).name === "string"
      && typeof (post as XPost).handle === "string"
      && typeof (post as XPost).text === "string"
      && typeof (post as XPost).createdAt === "string"
      && typeof (post as XPost).url === "string"
      && typeof (post as XPost).likes === "string"
      && typeof (post as XPost).reposts === "string"
      && typeof (post as XPost).replies === "string"
      && typeof (post as XPost).color === "string"
    ));
  } catch {
    return [];
  }
}

function writeStoredXPosts(posts: XPost[]): void {
  try {
    window.localStorage.setItem(X_CACHE_KEY, JSON.stringify(posts));
  } catch {
    // Storage full or unavailable: the in-memory list still works.
  }
}

function recentCachedPosts(posts: XPost[]): XPost[] {
  const byCreatedAt = new Map<string, XPost>();
  for (const post of posts) {
    const existing = byCreatedAt.get(post.url);
    if (!existing || Date.parse(post.createdAt) > Date.parse(existing.createdAt)) {
      byCreatedAt.set(post.url, post);
    }
  }
  return [...byCreatedAt.values()].filter((post) => isWithinXCacheWindow(post.createdAt));
}

const isRecentTimestamp = isWithinWindow;

export function marketTodayKey(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(Date.now()));
  return parts.replace(/-/g, "-");
}

function earningsFromApi(events: EarningsEvent[]): EarningsCompany[] {
  const today = marketTodayKey();
  return events.map<EarningsCompany>((event) => {
    const known = mockEarnings.find((item) => item.ticker === event.symbol);
    const isUpcoming = /^\d{4}-\d{2}-\d{2}$/.test(event.date) && event.date >= today;
    return {
      ticker: event.symbol,
      company: event.company,
      date: event.date,
      timing: event.timing,
      result: isUpcoming ? "Upcoming" : "Pending",
      epsExpected: "Not published",
      revenueExpected: "Not published",
      guidance: "Pending",
      officialUrl: known?.officialUrl,
      color: known?.color ?? tickerColour(event.symbol),
      source: "live",
      eventSignal: event.eventSignal,
    };
  });
}

export function MorningBriefingDataProvider({ children }: { children: React.ReactNode }) {
  const [data, setData] = useState<MorningBriefingData>(() => ({
    ...initialData,
    xPosts: readStoredXPosts(),
  }));

  useEffect(() => {
    let cancelled = false;
    let coreRequestId = 0;
    let xRequestId = 0;
    let earningsRequestId = 0;
    let lastEarningsAttemptAt = 0;
    let lastEarningsAttemptDate: string | null = null;

    const refreshCore = async () => {
      const currentRequest = ++coreRequestId;
      const [briefing, status] = await Promise.all([
        fetchJson<DailyBriefing>("/api/briefs/latest"),
        fetchJson<StatusResponse>("/api/status"),
      ]);
      if (cancelled || currentRequest !== coreRequestId) return;

      const briefingUpdatedAt = briefing
        ? status?.briefing?.publishedAt ?? briefing.preparedAt
        : null;
      // Market data: only today's fresh edition may fill the market cards.
      // Never present stale numbers as today's market data.
      const marketBriefing = briefing
        && status?.briefing?.freshness === "fresh"
        && isRecentTimestamp(briefingUpdatedAt, MARKET_DATA_MAX_AGE_MS)
        ? briefing
        : null;
      // Opportunities: a daily publication may be hours old (even 1-2 days)
      // and still be shown, labelled with its analysis date.
      const analysisBriefing = briefing
        && isWithinWindow(briefingUpdatedAt, BRIEFING_MAX_AGE_MS)
        ? briefing
        : null;
      const liveMarket = marketBriefing ? marketFromBriefing(marketBriefing) : null;
      const liveOpportunities = analysisBriefing ? opportunitiesFromBriefing(analysisBriefing) : null;

      setData((previous) => {
        // A transient refresh failure must not blank a still-valid daily
        // analysis: retain the previous publication while its timestamp is
        // inside the 72h window.
        const retainedOpportunities = isWithinWindow(previous.opportunitiesUpdatedAt, BRIEFING_MAX_AGE_MS) ? previous.opportunities : [];
        const nextOpportunities = liveOpportunities ?? retainedOpportunities;
        // The welcome card's date/edition label only describes what is being
        // shown: expire it together with the analysis instead of keeping an
        // old date under a post-close greeting for a cleared section.
        const nextEditionDate = analysisBriefing?.editionDate ?? (nextOpportunities.length > 0 ? previous.editionDate : null);
        return {
          ...previous,
          marketIndexes: liveMarket ?? [],
          opportunities: nextOpportunities,
          marketUpdatedAt: liveMarket && briefingUpdatedAt ? briefingUpdatedAt : null,
          opportunitiesUpdatedAt: liveOpportunities !== null && briefingUpdatedAt ? briefingUpdatedAt : previous.opportunitiesUpdatedAt,
          editionDate: nextEditionDate,
          editionType: nextEditionDate !== null ? (analysisBriefing?.editionType ?? previous.editionType) : null,
        };
      });
    };

    const refreshX = async () => {
      const currentRequest = ++xRequestId;
      const response = await fetchJson<XResponse>("/api/x/posts?limit=50");
      if (cancelled || currentRequest !== xRequestId) return;
      const liveX = response && Array.isArray(response.posts) ? xPostsFromApi(response.posts) : null;
      // Re-check after the first await: a newer invocation may have started
      // while this one was fetching, and must not be overwritten.
      if (cancelled || currentRequest !== xRequestId) return;
      setData((previous) => {
        const cached = recentCachedPosts([...readStoredXPosts(), ...previous.xPosts]);
        const liveHandles = new Set((liveX ?? []).map((post) => post.handle.toLowerCase()));
        const retained = cached.filter((post) => !liveHandles.has(post.handle.toLowerCase()));
        // Timestamps are re-derived on every write so retained posts keep
        // showing how old they are, not their age at collection time.
        const retimed = (posts: XPost[]) => posts.map((post) => ({ ...post, time: relativeTime(post.createdAt) }));
        const nextPosts = liveX === null
          ? retimed(cached)
          : [...liveX, ...retimed(retained)].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
        writeStoredXPosts(nextPosts);
        return { ...previous, xPosts: nextPosts };
      });
    };

    const refreshEarnings = async (force = false) => {
      const today = marketTodayKey();
      setData((previous) => ({
        ...previous,
        earnings: normaliseEarnings(previous.earnings, today),
      }));
      const now = Date.now();
      const refreshDue = force
        || lastEarningsAttemptDate !== today
        || now - lastEarningsAttemptAt >= EARNINGS_REFRESH_INTERVAL_MS;
      if (!refreshDue) return;
      lastEarningsAttemptAt = now;
      lastEarningsAttemptDate = today;
      const currentRequest = ++earningsRequestId;
      const response = await fetchJson<EarningsEvent[]>("/api/earnings");
      if (cancelled || currentRequest !== earningsRequestId) return;
      const apiEarnings = Array.isArray(response) ? earningsFromApi(response) : null;
      setData((previous) => ({
        ...previous,
        // A failed or empty fetch keeps the last known calendar usable;
        // earnings are a daily publication, not realtime quotes.
        earnings: apiEarnings ?? previous.earnings,
      }));
    };

    void refreshCore();
    void refreshX();
    void refreshEarnings(true);
    const interval = window.setInterval(() => { void refreshCore(); void refreshX(); void refreshEarnings(); }, 60_000);
    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible") return;
      void refreshCore();
      void refreshX();
      void refreshEarnings();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  const value = useMemo(() => data, [data]);
  return (
    <MorningBriefingDataContext.Provider value={value}>
      {children}
    </MorningBriefingDataContext.Provider>
  );
}

export function useMorningBriefingData(): MorningBriefingData {
  return useContext(MorningBriefingDataContext);
}
