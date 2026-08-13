/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { sourceHealthSchema, type DailyBriefing, type EarningsEvent, type PublicSourceHealth, type SourceHealth } from "@stock-autotrader/contracts";
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
  status?: { engine?: string; apiHealth?: string; lastDataUpdate?: string | null };
  briefing?: BriefingHealth;
  sources?: PublicSourceHealth;
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

export type BackendSources = {
  briefing: SourceHealth;
  market: SourceHealth;
  opportunities: SourceHealth;
  x: SourceHealth;
  earnings: SourceHealth;
  sentiment: SourceHealth;
  quickStats: SourceHealth;
};

type MorningBriefingData = {
  marketIndexes: MarketIndex[];
  opportunities: Opportunity[];
  xPosts: XPost[];
  earnings: EarningsCompany[];
  sources: BackendSources;
  backendState: "loading" | "connected" | "partial" | "offline";
  briefingFreshness: BriefingHealth["freshness"];
  lastPublishedAt: string | null;
  marketUpdatedAt: string | null;
  opportunitiesUpdatedAt: string | null;
  editionDate: string | null;
  editionType: DailyBriefing["editionType"] | null;
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
  // Social posts and earnings are backend publications.  Keep the initial
  // state empty so a failed first request never turns demo fixtures into
  // apparently current market information.
  xPosts: [],
  earnings: [],
  sources: {
    briefing: { provider: "unavailable", state: "Unavailable", asOf: null, ageSeconds: null, staleAfterSeconds: 93600, lastSuccess: null, lastAttempt: null, error: "No validated source health has been published." },
    market: { provider: "unavailable", state: "Unavailable", asOf: null, ageSeconds: null, staleAfterSeconds: 93600, lastSuccess: null, lastAttempt: null, error: "No validated source health has been published." },
    opportunities: { provider: "unavailable", state: "Unavailable", asOf: null, ageSeconds: null, staleAfterSeconds: 93600, lastSuccess: null, lastAttempt: null, error: "No validated source health has been published." },
    x: { provider: "unavailable", state: "Unavailable", asOf: null, ageSeconds: null, staleAfterSeconds: 93600, lastSuccess: null, lastAttempt: null, error: "No validated source health has been published." },
    earnings: { provider: "unavailable", state: "Unavailable", asOf: null, ageSeconds: null, staleAfterSeconds: 93600, lastSuccess: null, lastAttempt: null, error: "No validated source health has been published." },
    sentiment: { provider: "unavailable", state: "Unavailable", asOf: null, ageSeconds: null, staleAfterSeconds: 93600, lastSuccess: null, lastAttempt: null, error: "No validated source health has been published." },
    quickStats: { provider: "unavailable", state: "Unavailable", asOf: null, ageSeconds: null, staleAfterSeconds: 93600, lastSuccess: null, lastAttempt: null, error: "No validated source health has been published." },
  },
  backendState: "loading",
  briefingFreshness: "unavailable",
  lastPublishedAt: null,
  marketUpdatedAt: null,
  opportunitiesUpdatedAt: null,
  editionDate: null,
  editionType: null,
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
const FINANCIAL_CACHE_MAX_AGE_MS = 26 * 60 * 60_000;

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

const HEALTHY_STALE_AFTER_SECONDS = 26 * 60 * 60;

const unavailableSource = (error: string): SourceHealth => ({
  provider: "unavailable",
  state: "Unavailable",
  asOf: null,
  ageSeconds: null,
  staleAfterSeconds: HEALTHY_STALE_AFTER_SECONDS,
  lastSuccess: null,
  lastAttempt: null,
  error,
});

const parseSourceHealth = (value: unknown): SourceHealth | null => {
  const parsed = sourceHealthSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};

// Validate every source the backend publishes against the shared contract.
// Invalid or missing entries fall back to the previous validated state, so a
// malformed health payload can never push the UI into a misleading badge.
const mergeSources = (previous: BackendSources, raw: PublicSourceHealth | undefined): BackendSources => {
  if (!raw) return previous;
  return Object.fromEntries(
    (Object.keys(previous) as Array<keyof BackendSources>).map((key) => {
      const candidate = parseSourceHealth(raw[key]);
      return [key, candidate ?? previous[key]] as const;
    }),
  ) as unknown as BackendSources;
};

const backendStateFromSources = (sources: BackendSources): MorningBriefingData["backendState"] => {
  const connectedSources = [sources.briefing, sources.market, sources.opportunities, sources.x, sources.earnings];
  if (connectedSources.every((source) => source.state === "Unavailable" || source.state === "Error")) return "offline";
  if (connectedSources.every((source) => source.state === "Live")) return "connected";
  return "partial";
};

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
    color: tickerColour(post.symbol ?? post.author),
    url: post.url,
    symbol: post.symbol ?? undefined,
    price: post.price ?? undefined,
    change: post.change ?? undefined,
    source: "live",
  }));
}

function isUsableCachedPost(post: XPost): boolean {
  return post.source === "live" || post.source === "cached";
}

function isWithinXCacheWindowForPost(post: XPost): boolean {
  return isWithinXCacheWindow(post.createdAt);
}

function recentCachedPosts(posts: XPost[]): XPost[] {
  return posts
    .filter((post) => isUsableCachedPost(post) && isWithinXCacheWindowForPost(post))
    .map((post) => ({ ...post, time: relativeTime(post.createdAt), source: "cached" as const }))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .filter((post, index, all) => all.findIndex((candidate) => candidate.url === post.url) === index);
}

const X_CACHE_STORAGE_KEY = "morning-briefing-x-post-cache-v1";

function isXCategory(value: unknown): value is XPost["category"] {
  return value === "AI" || value === "Markets" || value === "Tech" || value === "Investing";
}

function isStoredXPost(value: unknown): value is XPost {
  if (!value || typeof value !== "object") return false;
  const post = value as Record<string, unknown>;
  return isXCategory(post.category)
    && typeof post.name === "string"
    && typeof post.handle === "string"
    && typeof post.time === "string"
    && typeof post.createdAt === "string"
    && typeof post.text === "string"
    && typeof post.likes === "string"
    && typeof post.reposts === "string"
    && typeof post.replies === "string"
    && typeof post.color === "string"
    && typeof post.url === "string";
}

function readStoredXPosts(): XPost[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(X_CACHE_STORAGE_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    const posts = parsed.filter(isStoredXPost).map((post) => ({ ...post, source: "cached" as const }));
    return recentCachedPosts(posts);
  } catch {
    return [];
  }
}

function writeStoredXPosts(posts: XPost[]): void {
  if (typeof window === "undefined") return;
  try {
    const recent = recentCachedPosts(posts);
    if (recent.length === 0) window.localStorage.removeItem(X_CACHE_STORAGE_KEY);
    else window.localStorage.setItem(X_CACHE_STORAGE_KEY, JSON.stringify(recent));
  } catch {
    // Storage is an optional durability layer; in-memory retention still works.
  }
}

export function marketTodayKey(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(Date.now()));
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

const isRecentTimestamp = (value: string | null | undefined): boolean => {
  const timestamp = Date.parse(value ?? "");
  const ageMs = Date.now() - timestamp;
  return Number.isFinite(timestamp) && ageMs >= -5 * 60_000 && ageMs <= FINANCIAL_CACHE_MAX_AGE_MS;
};

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
  const [data, setData] = useState<MorningBriefingData>(() => {
    const cachedPosts = readStoredXPosts();
    const sources = { ...initialData.sources };
    return {
      ...initialData,
      xPosts: cachedPosts,
      sources,
      backendState: backendStateFromSources(sources),
    };
  });

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
      const freshBriefing = briefing
        && status?.briefing?.freshness === "fresh"
        && isRecentTimestamp(briefingUpdatedAt)
        ? briefing
        : null;
      const liveMarket = freshBriefing ? marketFromBriefing(freshBriefing) : null;
      const liveOpportunities = freshBriefing ? opportunitiesFromBriefing(freshBriefing) : null;
      const marketTimestamp = liveMarket
        ? freshBriefing
          ? briefingUpdatedAt
          : null
        : null;
      const opportunitiesTimestamp = liveOpportunities !== null
        ? freshBriefing
          ? briefingUpdatedAt
          : null
        : null;

      setData((previous) => {
        const retainBriefing = isRecentTimestamp(previous.lastPublishedAt);
        const nextMarketIndexes = liveMarket ?? [];
        const nextOpportunities = liveOpportunities ?? [];
        const parsedSources = mergeSources(previous.sources, status?.sources);
        // Fail closed: if the briefing endpoint itself is unreachable, the
        // sections that depend on it must not keep a Live badge from an
        // earlier status response.
        const sources: BackendSources = briefing === null
          ? {
              ...parsedSources,
              briefing: unavailableSource("Backend is unreachable."),
              market: unavailableSource("Backend is unreachable."),
              opportunities: unavailableSource("Backend is unreachable."),
            }
          : parsedSources;
        return {
          ...previous,
          marketIndexes: nextMarketIndexes,
          opportunities: nextOpportunities,
          sources,
          backendState: backendStateFromSources(sources),
          briefingFreshness: status?.briefing?.freshness ?? "unavailable",
          lastPublishedAt: freshBriefing ? briefingUpdatedAt : null,
          marketUpdatedAt: liveMarket ? marketTimestamp : null,
          opportunitiesUpdatedAt: liveOpportunities !== null ? opportunitiesTimestamp : null,
          editionDate: freshBriefing?.editionDate ?? (retainBriefing ? previous.editionDate : null),
          editionType: freshBriefing?.editionType ?? (retainBriefing ? previous.editionType : null),
        };
      });
    };

    const refreshX = async () => {
      const currentRequest = ++xRequestId;
      const response = await fetchJson<XResponse>("/api/x/posts?limit=50");
      if (cancelled || currentRequest !== xRequestId) return;
      const liveX = response && Array.isArray(response.posts) ? xPostsFromApi(response.posts) : null;
      const status = await fetchJson<StatusResponse>("/api/status");
      setData((previous) => {
        const cached = recentCachedPosts([...readStoredXPosts(), ...previous.xPosts]);
        const liveHandles = new Set((liveX ?? []).map((post) => post.handle.toLowerCase()));
        const retained = cached.filter((post) => !liveHandles.has(post.handle.toLowerCase()));
        const nextPosts = liveX === null
          ? cached
          : [...liveX, ...retained].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
        const sources = mergeSources(previous.sources, status?.sources);
        writeStoredXPosts(nextPosts);
        return {
          ...previous,
          xPosts: nextPosts,
          sources,
          backendState: backendStateFromSources(sources),
        };
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
      const status = await fetchJson<StatusResponse>("/api/status");
      setData((previous) => {
        const sources = mergeSources(previous.sources, status?.sources);
        if (apiEarnings === null) sources.earnings = unavailableSource("Backend is unreachable.");
        return {
          ...previous,
          earnings: apiEarnings ?? previous.earnings.map((item) => ({ ...item, source: "cached" as const })),
          sources,
          backendState: backendStateFromSources(sources),
        };
      });
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
