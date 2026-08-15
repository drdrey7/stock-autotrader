/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { DailyBriefing, EarningsApiResponse, EarningsEngineEvent } from "@stock-autotrader/contracts";
import type { MarketIndex } from "./data/market";
import { type Opportunity } from "./data/opportunities";
import { type XPost } from "./data/xSurge";
import { eventWithViewMetadata, type EarningsCompany } from "./data/earnings-view";

type BriefingHealth = {
  available: boolean;
  freshness: "fresh" | "stale" | "unavailable";
  publishedAt: string | null;
};

type StatusResponse = {
  briefing?: BriefingHealth;
  market?: {
    indices?: Array<{
      symbol: "SPX" | "NDX" | "DJI" | "VIX";
      name: string;
      value: number;
      change: number;
      updatedAt: string;
    }>;
    latestSourceTimestamp?: string | null;
    latestCollectedAt?: string | null;
  };
  sentiment?: {
    provider: string;
    score: number;
    rating: "extreme_fear" | "fear" | "neutral" | "greed" | "extreme_greed";
    asOf: string;
  } | null;
  sources?: {
    market?: {
      state?: string;
      error?: string | null;
    };
  };
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
  earningsAvailable: boolean;
  // The published edition shown, with the timestamps that label the data.
  editionDate: string | null;
  editionType: DailyBriefing["editionType"] | null;
  marketUpdatedAt: string | null;
  marketStale: boolean;
  opportunitiesUpdatedAt: string | null;
  sentiment: NonNullable<StatusResponse["sentiment"]> | null;
};

const initialData: MorningBriefingData = {
  // Financially actionable sections stay empty until the backend publishes
  // validated data. Earnings has no financial fixture fallback.
  marketIndexes: [],
  opportunities: [],
  xPosts: [],
  earnings: [],
  earningsAvailable: false,
  editionDate: null,
  editionType: null,
  marketUpdatedAt: null,
  marketStale: false,
  opportunitiesUpdatedAt: null,
  sentiment: null,
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
  let hash = 0;
  for (const character of ticker) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  const colors = ["#176b47", "#4385f5", "#a8730b", "#7c3aed", "#1675d1", "#dc3f48", "#0f766e"];
  return colors[hash % colors.length] ?? colors[0]!;
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

function isWithinWindow(value: string | null | undefined, maxAgeMs: number, now = Date.now()): boolean {
  const timestamp = Date.parse(value ?? "");
  const ageMs = now - timestamp;
  return Number.isFinite(timestamp) && ageMs >= 0 && ageMs <= maxAgeMs;
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

// Real index context (PR #11): the Worker publishes live index quotes in the
// dedicated market-context read model; it is the only source for market cards
// and is gated by the 26h freshness window. The Worker validates that each
// observation belongs to the latest market session; the client must not add a
// calendar-day requirement that hides valid overnight/weekend data.
const INDEX_GATE_MS = 26 * 60 * 60_000;

export function isDisplayableMarketIndex(updatedAt: string | null | undefined, now = Date.now()): boolean {
  return isWithinWindow(updatedAt, INDEX_GATE_MS, now);
}

function indicesFromStatus(status: StatusResponse | null): { indexes: MarketIndex[]; updatedAt: string; stale: boolean } | null {
  const indices = status?.market?.indices;
  if (!Array.isArray(indices) || indices.length === 0) return null;
  // The source timestamp identifies the latest validated market session, but
  // providers often timestamp a daily bar at that session's midnight. Use the
  // Worker read model's collection timestamp for the stale gate so valid
  // overnight/pre-market data is not hidden merely because its source date is
  // yesterday in New York. The Worker only publishes validated observations.
  const latestCollectedAt = status?.market?.latestCollectedAt ?? null;
  let latestUpdatedAt = "";
  const fresh: MarketIndex[] = [];
  for (const index of indices) {
    const displayTimestamp = latestCollectedAt ?? index.updatedAt;
    const parsedTimestamp = Date.parse(displayTimestamp);
    // Keep a validated last-known-good quote visible when the backend marks it
    // stale/degraded. It is labelled below; a transient provider outage should
    // not turn real persisted prices into four empty cards.
    if (
      !Number.isFinite(parsedTimestamp)
      || parsedTimestamp > Date.now() + 5 * 60_000
      || !isDisplayableMarketIndex(displayTimestamp)
    ) continue;
    fresh.push({
      name: index.name,
      symbol: index.symbol,
      value: index.value,
      decimals: 2,
      change: index.change,
      source: "live" as const,
    });
    if (index.updatedAt > latestUpdatedAt) latestUpdatedAt = index.updatedAt;
  }
  if (fresh.length === 0) return null;
  const sourceState = status?.sources?.market?.state;
  const stale = !isDisplayableMarketIndex(latestCollectedAt ?? latestUpdatedAt)
    || (sourceState !== undefined && sourceState !== "Live");
  return { indexes: fresh, updatedAt: latestCollectedAt ?? latestUpdatedAt, stale };
}

// Market sentiment (PR #11): the CNN Fear & Greed reading is published once or
// twice a day. A reading may legitimately be a weekend old before the next
// one; the 72h window matches the daily-publication sections.
const SENTIMENT_GATE_MS = 72 * 60 * 60_000;

function sentimentFromStatus(status: StatusResponse | null): MorningBriefingData["sentiment"] {
  const sentiment = status?.sentiment;
  if (!sentiment) return null;
  if (typeof sentiment.score !== "number" || sentiment.score < 0 || sentiment.score > 100) return null;
  const ratings = ["extreme_fear", "fear", "neutral", "greed", "extreme_greed"] as const;
  if (!ratings.includes(sentiment.rating)) return null;
  if (!isWithinWindow(sentiment.asOf, SENTIMENT_GATE_MS)) return null;
  return sentiment;
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

export function marketTodayKey(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(Date.now()));
  return parts.replace(/-/g, "-");
}

function earningsFromApi(payload: EarningsApiResponse | EarningsEngineEvent[]): EarningsCompany[] {
  const events = Array.isArray(payload) ? payload : payload.events;
  return events.map((event) => eventWithViewMetadata(event));
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
      // Opportunities: a daily publication may be hours old (even 1-2 days)
      // and still be shown, labelled with its analysis date.
      const analysisBriefing = briefing
        && isWithinWindow(briefingUpdatedAt, BRIEFING_MAX_AGE_MS)
        ? briefing
        : null;
      const liveOpportunities = analysisBriefing ? opportunitiesFromBriefing(analysisBriefing) : null;
      // Market cards have one owner: the Worker market-context read model.
      // Briefing market summaries are analysis text and cannot substitute for
      // a source-timestamped index observation.
      const liveIndices = indicesFromStatus(status);
      const sentiment = sentimentFromStatus(status);

      setData((previous) => {
        // A transient refresh failure must not blank a still-valid daily
        // analysis: retain the previous publication while its timestamp is
        // inside the 72h window.
        const retained = isWithinWindow(previous.opportunitiesUpdatedAt, BRIEFING_MAX_AGE_MS);
        const nextOpportunities = liveOpportunities ?? (retained ? previous.opportunities : []);
        const retainedIndices = previous.marketUpdatedAt
          && isDisplayableMarketIndex(previous.marketUpdatedAt)
          ? previous.marketIndexes
          : [];
        const nextMarketIndexes = liveIndices?.indexes ?? retainedIndices;
        const marketUpdatedAt = liveIndices?.updatedAt
          ?? (nextMarketIndexes.length > 0 ? previous.marketUpdatedAt : null);
        const retainedSentiment = previous.sentiment && isWithinWindow(previous.sentiment.asOf, SENTIMENT_GATE_MS)
          ? previous.sentiment
          : null;
        // The welcome card's date/edition label only describes what is being
        // shown: expire it together with the analysis instead of keeping an
        // old date under a post-close greeting for a cleared section. The
        // retention is timestamp-based so a valid empty publication (zero
        // ideas) keeps its edition label too.
        const nextEditionDate = analysisBriefing?.editionDate ?? (retained ? previous.editionDate : null);
        return {
          ...previous,
          marketIndexes: nextMarketIndexes,
          opportunities: nextOpportunities,
          marketUpdatedAt,
          marketStale: liveIndices?.stale ?? (nextMarketIndexes.length > 0 ? previous.marketStale : false),
          opportunitiesUpdatedAt: liveOpportunities !== null && briefingUpdatedAt ? briefingUpdatedAt : previous.opportunitiesUpdatedAt,
          editionDate: nextEditionDate,
          editionType: nextEditionDate !== null ? (analysisBriefing?.editionType ?? previous.editionType) : null,
          sentiment: sentiment ?? retainedSentiment,
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
        earnings: previous.earnings,
      }));
      const now = Date.now();
      const refreshDue = force
        || lastEarningsAttemptDate !== today
        || now - lastEarningsAttemptAt >= EARNINGS_REFRESH_INTERVAL_MS;
      if (!refreshDue) return;
      lastEarningsAttemptAt = now;
      lastEarningsAttemptDate = today;
      const currentRequest = ++earningsRequestId;
      const response = await fetchJson<EarningsApiResponse | EarningsEngineEvent[]>("/api/earnings");
      if (cancelled || currentRequest !== earningsRequestId) return;
      const apiEarnings = response ? earningsFromApi(response) : null;
      setData((previous) => ({
        ...previous,
        // A failed fetch must not present yesterday's schedule as current.
        // Empty is a valid publication; failure is explicitly unavailable.
        earnings: apiEarnings ?? [],
        earningsAvailable: apiEarnings !== null,
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
