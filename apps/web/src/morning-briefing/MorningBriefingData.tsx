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

const numberFrom = (value: string | number | null | undefined): number => {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (!value) return 0;
  const parsed = Number(value.replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
};

const changeFrom = (value: string | null | undefined): number => numberFrom(value);

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

function marketFromBriefing(briefing: DailyBriefing): MarketIndex[] {
  const live = briefing.market.map((item) => ({
    name: item.name === "Nasdaq-100" ? "Nasdaq" : item.name,
    symbol: item.symbol.split(":").at(-1) ?? item.symbol,
    value: numberFrom(item.value),
    decimals: 2,
    change: changeFrom(item.change),
    source: "live" as const,
  }));
  const dow = mockMarketIndexes.find((item) => item.symbol === "DJI");
  return dow ? [...live.slice(0, 2), { ...dow, source: "mock" as const }, ...live.slice(2)] : live;
}

function marketFromSnapshot(snapshot: MarketDataSnapshot | null | undefined): MarketIndex[] | null {
  if (!snapshot?.benchmarks?.length) return null;
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
      confidence: idea.verdict === "Potential Entry" ? "High" : "Medium",
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
  return candidates.filter((candidate) => candidate.status === "Strong Setup").slice(0, 4).map((candidate) => ({
    ticker: candidate.symbol,
    company: candidate.company,
    change: 0,
    confidence: candidate.status === "Strong Setup" ? "High" : "Medium",
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

function marketTodayKey(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(Date.now()));
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

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
    void (async () => {
      const [briefing, status, xResponse, liveEarnings, marketData] = await Promise.all([
        fetchJson<DailyBriefing>("/api/briefs/latest"),
        fetchJson<StatusResponse>("/api/status"),
        fetchJson<XResponse>("/api/x/posts?limit=50"),
        fetchJson<EarningsEvent[]>("/api/earnings"),
        fetchJson<MarketDataSnapshot>("/api/market-data"),
      ]);
      if (cancelled) return;

      const candidates = status?.candidates ?? [];
      const liveMarket = briefing
        ? marketFromBriefing(briefing)
        : marketFromSnapshot(marketData ?? status?.marketData);
      const liveOpportunities = briefing
        ? opportunitiesFromBriefing(briefing, candidates)
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

      const liveCount = [briefing, liveMarket, liveOpportunities, liveX, apiEarnings]
        .filter(Boolean).length;

      setData({
        marketIndexes: liveMarket ?? labelledMockMarketIndexes,
        opportunities: liveOpportunities ?? mockOpportunities,
        xPosts: liveX ?? mockXPosts,
        earnings: mergedEarnings,
        sources: {
          briefing: briefing ? "live" : "mock",
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
        editionDate: briefing?.editionDate ?? null,
      });
    })();

    return () => {
      cancelled = true;
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
