/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type {
  Candidate,
  DailyBriefing,
  EarningsEvent,
  MarketDataSnapshot,
} from "@stock-autotrader/contracts";
import { marketIndexes as mockMarketIndexes, type MarketIndex } from "./data/market";
import { opportunities as mockOpportunities, type Opportunity } from "./data/opportunities";
import { type XPost } from "./data/xSurge";
import { earnings as mockEarnings, type EarningsCompany } from "./data/earnings";
import type { DataSource } from "./data/source";

type BriefingHealth = {
  available: boolean;
  freshness: "fresh" | "stale" | "unavailable";
  publishedAt: string | null;
};

type StatusResponse = {
  status?: { engine?: string; apiHealth?: string; lastDataUpdate?: string | null };
  candidates?: Candidate[];
  marketData?: MarketDataSnapshot;
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

export type BackendSources = {
  briefing: DataSource;
  market: DataSource;
  opportunities: DataSource;
  x: DataSource;
  earnings: DataSource;
  sentiment: DataSource;
  quickStats: DataSource;
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
  editionDate: string | null;
  editionType: DailyBriefing["editionType"] | null;
};

const labelledMockMarketIndexes: MarketIndex[] = mockMarketIndexes.map((item) => ({
  ...item,
  source: "mock",
}));

function normaliseEarnings(items: EarningsCompany[], today = marketTodayKey()): EarningsCompany[] {
  return items.map((item) => item.result === "Upcoming" && item.date < today
    ? { ...item, result: "Pending" as const }
    : item);
}

const initialData: MorningBriefingData = {
  marketIndexes: labelledMockMarketIndexes,
  opportunities: mockOpportunities,
  // Social posts and earnings are backend publications.  Keep the initial
  // state empty so a failed first request never turns demo fixtures into
  // apparently current market information.
  xPosts: [],
  earnings: [],
  sources: {
    briefing: "mock",
    market: "mock",
    opportunities: "mock",
    x: "mock",
    earnings: "mock",
    sentiment: "mock",
    quickStats: "mock",
  },
  backendState: "loading",
  briefingFreshness: "unavailable",
  lastPublishedAt: null,
  editionDate: null,
  editionType: null,
};

const MorningBriefingDataContext = createContext<MorningBriefingData>(initialData);

const numberFrom = (value: string | number | null | undefined): number | null => {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (!value || !/[0-9]/.test(value)) return null;
  const parsed = Number(value.replace(/[^0-9.-]/g, ""));
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

const cachedSource = (source: DataSource | undefined): DataSource =>
  source === "mock" || source === undefined ? "mock" : "cached";

const backendStateFromSources = (sources: BackendSources): MorningBriefingData["backendState"] => {
  const connectedSources = [sources.briefing, sources.market, sources.opportunities, sources.x, sources.earnings];
  if (connectedSources.every((source) => source === "mock")) return "offline";
  if (connectedSources.every((source) => source === "live" || source === "mixed")) return "connected";
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

function marketFromSnapshot(snapshot: MarketDataSnapshot | null | undefined): MarketIndex[] | null {
  if (!snapshot?.benchmarks?.length || snapshot.status !== "healthy") return null;
  const publishedAt = Date.parse(snapshot.lastSuccessfulUpdate ?? "");
  const ageMs = Date.now() - publishedAt;
  if (!Number.isFinite(publishedAt) || ageMs < -5 * 60_000 || ageMs > 26 * 60 * 60_000) return null;
  const mapped = snapshot.benchmarks.map((benchmark) => {
    const isQqq = benchmark.symbol.toUpperCase().includes("QQQ");
    const change = benchmark.open ? ((benchmark.close - benchmark.open) / benchmark.open) * 100 : 0;
    return {
      name: isQqq ? "Nasdaq" : "S&P 500",
      symbol: benchmark.symbol,
      value: benchmark.close,
      decimals: 2,
      change,
      source: "live" as const,
    };
  });
  return mapped.slice(0, 4);
}

function opportunitiesFromBriefing(
  briefing: DailyBriefing,
  candidates: Candidate[],
): Opportunity[] {
  return briefing.ideas.filter((idea) => idea.verdict === "Potential Entry").map((idea) => {
    const candidate = candidates.find((item) => item.symbol === idea.symbol);
    return {
      ticker: idea.symbol,
      company: idea.company,
      change: changeFrom(idea.change),
      confidence: null,
      score: candidate?.quantScore ?? null,
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

function opportunitiesFromCandidates(candidates: Candidate[]): Opportunity[] {
  return candidates.filter((candidate) => candidate.status === "Strong Setup")
    .sort((a, b) => b.quantScore - a.quantScore).slice(0, 4).map((candidate) => ({
    ticker: candidate.symbol,
    company: candidate.company,
    change: null,
    confidence: null,
    score: candidate.quantScore,
    thesis: candidate.reasons.map((reason) => reason.label).join(" · ") || candidate.strategy,
    trigger: candidate.breakout ?? "Not published",
    risk: candidate.riskFlags.join(", ") || "See qualification",
    verdict: candidate.status,
    color: tickerColour(candidate.symbol),
    source: "live",
  }));
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

function readStoredXPosts(): XPost[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(X_CACHE_STORAGE_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    const posts = parsed.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const post = item as Partial<XPost>;
      if (typeof post.createdAt !== "string" || typeof post.handle !== "string" || typeof post.text !== "string" || typeof post.url !== "string") return [];
      return [{ ...post, source: "cached" as const } as XPost];
    });
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
  return Number.isFinite(timestamp) && ageMs >= -5 * 60_000 && ageMs <= 26 * 60 * 60_000;
};

const candidatesAreFresh = (status: StatusResponse | null): boolean =>
  status?.status?.engine === "online" &&
  status.status.apiHealth === "healthy" &&
  isRecentTimestamp(status.status.lastDataUpdate);

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
  const [data, setData] = useState<MorningBriefingData>(initialData);

  useEffect(() => {
    let cancelled = false;
    let coreRequestId = 0;
    let xRequestId = 0;
    let earningsRequestId = 0;
    let lastEarningsAttemptAt = 0;
    let lastEarningsAttemptDate: string | null = null;

    const refreshCore = async () => {
      const currentRequest = ++coreRequestId;
      const [briefing, status, marketData] = await Promise.all([
        fetchJson<DailyBriefing>("/api/briefs/latest"),
        fetchJson<StatusResponse>("/api/status"),
        fetchJson<MarketDataSnapshot>("/api/market-data"),
      ]);
      if (cancelled || currentRequest !== coreRequestId) return;

      const freshBriefing = briefing && status?.briefing?.freshness === "fresh" ? briefing : null;
      const candidateSnapshotAvailable = candidatesAreFresh(status) && Array.isArray(status?.candidates);
      const candidates = candidateSnapshotAvailable
        ? (status?.candidates ?? []).filter((candidate) => isRecentTimestamp(candidate.updatedAt))
        : [];
      const liveMarket = freshBriefing
        ? marketFromBriefing(freshBriefing)
        : marketFromSnapshot(marketData ?? status?.marketData);
      const liveOpportunities = freshBriefing
        ? opportunitiesFromBriefing(freshBriefing, candidates)
        : candidateSnapshotAvailable
          ? opportunitiesFromCandidates(candidates)
          : null;

      setData((previous) => {
        const sources: BackendSources = {
          ...previous.sources,
          briefing: freshBriefing ? "live" : cachedSource(previous.sources.briefing),
          market: liveMarket
            ? (liveMarket.some((item) => item.source === "mock") ? "mixed" : "live")
            : cachedSource(previous.sources.market),
          opportunities: liveOpportunities !== null ? "live" : cachedSource(previous.sources.opportunities),
        };
        return {
          ...previous,
          marketIndexes: liveMarket ?? previous.marketIndexes.map((item) => ({ ...item, source: cachedSource(item.source) })),
          opportunities: liveOpportunities ?? previous.opportunities.map((item) => ({ ...item, source: cachedSource(item.source) })),
          sources,
          backendState: backendStateFromSources(sources),
          briefingFreshness: status?.briefing?.freshness ?? "unavailable",
          lastPublishedAt: freshBriefing
            ? status?.briefing?.publishedAt ?? freshBriefing.preparedAt
            : previous.lastPublishedAt,
          editionDate: freshBriefing?.editionDate ?? previous.editionDate,
          editionType: freshBriefing?.editionType ?? previous.editionType,
        };
      });
    };

    const refreshX = async () => {
      const currentRequest = ++xRequestId;
      const response = await fetchJson<XResponse>("/api/x/posts?limit=50");
      if (cancelled || currentRequest !== xRequestId) return;
      const liveX = response && Array.isArray(response.posts) ? xPostsFromApi(response.posts) : null;
      setData((previous) => {
        const cached = recentCachedPosts([...readStoredXPosts(), ...previous.xPosts]);
        const liveHandles = new Set((liveX ?? []).map((post) => post.handle.toLowerCase()));
        const retained = cached.filter((post) => !liveHandles.has(post.handle.toLowerCase()));
        const nextPosts = liveX === null
          ? cached
          : [...liveX, ...retained].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
        const source = liveX === null
          ? cached.length > 0 ? "cached" as const : cachedSource(previous.sources.x)
          : liveX.length > 0
            ? retained.length > 0 ? "mixed" as const : "live" as const
            : retained.length > 0 ? "cached" as const : "live" as const;
        const sources = { ...previous.sources, x: source };
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
      setData((previous) => {
        const sources = {
          ...previous.sources,
          earnings: apiEarnings !== null ? "live" as const : cachedSource(previous.sources.earnings),
        };
        return {
          ...previous,
          earnings: apiEarnings ?? previous.earnings.map((item) => ({ ...item, source: cachedSource(item.source) })),
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
