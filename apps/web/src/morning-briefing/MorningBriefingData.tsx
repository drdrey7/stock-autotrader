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
import { xPosts as mockXPosts, type XPost } from "./data/xSurge";
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
};

const labelledMockMarketIndexes: MarketIndex[] = mockMarketIndexes.map((item) => ({
  ...item,
  source: "mock",
}));

function normaliseMockEarnings(items: EarningsCompany[], today = marketTodayKey()): EarningsCompany[] {
  return items.map((item) => item.result === "Upcoming" && item.date < today
    ? { ...item, result: "Pending" as const, source: "mock" as const }
    : item);
}

const initialData: MorningBriefingData = {
  marketIndexes: labelledMockMarketIndexes,
  opportunities: mockOpportunities,
  xPosts: mockXPosts,
  earnings: normaliseMockEarnings(mockEarnings),
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

async function fetchJson<T>(path: string): Promise<T | null> {
  try {
    const response = await fetch(path, { headers: { accept: "application/json" } });
    if (!response.ok) return null;
    return await response.json() as T;
  } catch {
    return null;
  }
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
  const dow = mockMarketIndexes.find((item) => item.symbol === "DJI");
  const ordered = [
    sp500,
    findBenchmark("nasdaq", "NDX"),
    dow ? { ...dow, source: "mock" as const } : undefined,
    findBenchmark("vix", "VIX"),
  ].filter((item): item is MarketIndex => Boolean(item));
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
  const demoRemainder = mockMarketIndexes
    .filter((item) => !mapped.some((live) => live.name === item.name))
    .map((item) => ({ ...item, source: "mock" as const }));
  return [...mapped, ...demoRemainder].slice(0, 4);
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

function xPostsFromApi(posts: XApiPost[]): XPost[] {
  return [...posts]
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
    const exact = mockEarnings.find((item) => item.ticker === event.symbol && item.date === event.date);
    const known = exact ?? mockEarnings.find((item) => item.ticker === event.symbol);
    const isUpcoming = /^\d{4}-\d{2}-\d{2}$/.test(event.date) && event.date >= today;
    if (!isUpcoming && exact && exact.result !== "Upcoming") {
      return { ...exact, company: event.company, timing: event.timing, source: "mixed" as const, eventSignal: event.eventSignal };
    }
    return {
      ticker: event.symbol,
      company: event.company,
      date: event.date,
      timing: event.timing,
      result: isUpcoming ? "Upcoming" : "Pending",
      epsExpected: exact?.epsExpected ?? "Not published",
      revenueExpected: exact?.revenueExpected ?? "Not published",
      guidance: "Pending",
      officialUrl: known?.officialUrl,
      color: known?.color ?? tickerColour(event.symbol),
      source: exact ? "mixed" : "live",
      eventSignal: event.eventSignal,
    };
  });
}

export function MorningBriefingDataProvider({ children }: { children: React.ReactNode }) {
  const [data, setData] = useState<MorningBriefingData>(initialData);

  useEffect(() => {
    let cancelled = false;
    let requestId = 0;
    const refresh = async () => {
      const currentRequest = ++requestId;
      const [briefing, status, xResponse, liveEarnings, marketData] = await Promise.all([
        fetchJson<DailyBriefing>("/api/briefs/latest"),
        fetchJson<StatusResponse>("/api/status"),
        fetchJson<XResponse>("/api/x/posts?limit=50"),
        fetchJson<EarningsEvent[]>("/api/earnings"),
        fetchJson<MarketDataSnapshot>("/api/market-data"),
      ]);
      if (cancelled || currentRequest !== requestId) return;

      const freshBriefing = briefing && status?.briefing?.freshness === "fresh" ? briefing : null;
      const candidates = candidatesAreFresh(status)
        ? (status?.candidates ?? []).filter((candidate) => isRecentTimestamp(candidate.updatedAt))
        : [];
      const liveMarket = freshBriefing
        ? marketFromBriefing(freshBriefing)
        : marketFromSnapshot(marketData ?? status?.marketData);
      const liveOpportunities = freshBriefing
        ? opportunitiesFromBriefing(freshBriefing, candidates)
        : candidates.length
          ? opportunitiesFromCandidates(candidates)
          : null;
      const liveX = xResponse?.posts?.length ? xPostsFromApi(xResponse.posts) : null;
      const apiEarnings = Array.isArray(liveEarnings) && liveEarnings.length
        ? earningsFromApi(liveEarnings)
        : null;
      const normalisedMocks = normaliseMockEarnings(mockEarnings);
      const demoPast = normalisedMocks.filter((item) => item.result !== "Upcoming");
      const mergedEarnings = apiEarnings
        ? [
            ...apiEarnings,
            ...demoPast
              .filter((demo) => !apiEarnings.some((live) => live.ticker === demo.ticker && live.date === demo.date))
              .map((item) => ({ ...item, source: "mock" as const })),
          ]
        : normalisedMocks;

      const liveCount = [freshBriefing, liveMarket, liveOpportunities, liveX, apiEarnings]
        .filter(Boolean).length;

      setData({
        marketIndexes: liveMarket ?? labelledMockMarketIndexes,
        opportunities: liveOpportunities ?? mockOpportunities,
        xPosts: liveX ?? mockXPosts,
        earnings: mergedEarnings,
        sources: {
          briefing: freshBriefing ? "live" : "mock",
          market: liveMarket ? (liveMarket.some((item) => item.source === "mock") ? "mixed" : "live") : "mock",
          opportunities: liveOpportunities ? "live" : "mock",
          x: liveX ? "live" : "mock",
          earnings: apiEarnings ? (demoPast.length ? "mixed" : "live") : "mock",
          sentiment: "mock",
          quickStats: "mock",
        },
        backendState: liveCount === 0 ? "offline" : liveCount === 5 ? "connected" : "partial",
        briefingFreshness: status?.briefing?.freshness ?? "unavailable",
        lastPublishedAt: status?.briefing?.publishedAt ?? briefing?.preparedAt ?? null,
        editionDate: freshBriefing?.editionDate ?? null,
      });
    };
    void refresh();
    const interval = window.setInterval(() => { void refresh(); }, 60_000);
    const onVisibilityChange = () => { if (document.visibilityState === "visible") void refresh(); };
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

export function DataSourceBadge({ source }: { source: DataSource }) {
  return <span className={`data-source ${source}`}>{source === "live" ? "Live" : source === "mixed" ? "Live + demo" : "Demo"}</span>;
}

export function BackendRibbon() {
  const { backendState, briefingFreshness, lastPublishedAt } = useMorningBriefingData();
  const label = backendState === "connected"
    ? "Backend connected"
    : backendState === "partial"
      ? "Backend partially populated"
      : backendState === "loading"
        ? "Connecting to backend"
        : "Demo fallback active";
  return (
    <div className={`backend-ribbon ${backendState}`} role="status">
      <span><i />{label}</span>
      <span>Briefing: {briefingFreshness}</span>
      {lastPublishedAt ? <time dateTime={lastPublishedAt}>Updated {relativeTime(lastPublishedAt)} ago</time> : null}
    </div>
  );
}
