/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { DailyBriefing, EarningsApiResponse, EarningsEngineEvent } from "@stock-autotrader/contracts";
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
  sentiment?: {
    provider: string;
    score: number;
    rating: "extreme_fear" | "fear" | "neutral" | "greed" | "extreme_greed";
    asOf: string;
  } | null;
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
  opportunities: Opportunity[];
  xPosts: XPost[];
  earnings: EarningsCompany[];
  earningsAvailable: boolean;
  // The published edition shown, with the timestamps that label the data.
  editionDate: string | null;
  editionType: DailyBriefing["editionType"] | null;
  opportunitiesUpdatedAt: string | null;
  sentiment: NonNullable<StatusResponse["sentiment"]> | null;
};

const initialData: MorningBriefingData = {
  // Financially actionable sections stay empty until the backend publishes
  // validated data. Earnings has no financial fixture fallback.
  opportunities: [],
  xPosts: [],
  earnings: [],
  earningsAvailable: false,
  editionDate: null,
  editionType: null,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDateKey(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day!));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month! - 1 && date.getUTCDate() === day;
}

const EARNINGS_STRING_FIELDS = [
  "id", "symbol", "company", "cik", "date", "scheduledDate", "scheduledTime",
  "fiscalPeriod", "fiscalPeriodEnd", "reportedAt", "calendarProvider", "consensusProvider",
  "providerEventId", "providerUpdatedAt", "officialReportUrl", "investorRelationsUrl",
  "secFilingUrl", "secAccession", "secForm", "secFiledAt", "createdAt", "updatedAt", "lastCheckedAt",
] as const;
const EARNINGS_NUMBER_FIELDS = [
  "fiscalYear", "fiscalQuarter", "epsEstimate", "epsActual", "epsSurprise", "epsSurprisePct",
  "revenueEstimate", "revenueActual", "revenueSurprise", "revenueSurprisePct",
] as const;
const EARNINGS_BOOLEAN_FIELDS = ["scheduled", "reported", "cancelled", "unknown"] as const;

function invalidEarningsEventField(event: Record<string, unknown>): string | null {
  if (typeof event.symbol !== "string" || event.symbol.trim().length === 0) return "symbol";
  for (const field of EARNINGS_STRING_FIELDS) {
    if (field in event && event[field] !== null && typeof event[field] !== "string") return field;
  }
  for (const field of EARNINGS_NUMBER_FIELDS) {
    if (field in event && event[field] !== null && (typeof event[field] !== "number" || !Number.isFinite(event[field]))) return field;
  }
  for (const field of EARNINGS_BOOLEAN_FIELDS) {
    if (field in event && event[field] !== null && typeof event[field] !== "boolean") return field;
  }
  if (event.date !== undefined && event.date !== null && !isDateKey(event.date)) return "date";
  if (event.scheduledDate !== undefined && event.scheduledDate !== null && !isDateKey(event.scheduledDate)) return "scheduledDate";
  if (event.status !== undefined && event.status !== null && !["scheduled", "reported", "cancelled", "unknown"].includes(String(event.status))) return "status";
  if (event.timing !== undefined && event.timing !== null && !["BMO", "AMC", "TBD"].includes(String(event.timing))) return "timing";
  if (event.epsResult !== undefined && event.epsResult !== null && !["Beat", "In Line", "Miss", "Not Available"].includes(String(event.epsResult))) return "epsResult";
  if (event.revenueResult !== undefined && event.revenueResult !== null && !["Beat", "In Line", "Miss", "Not Available"].includes(String(event.revenueResult))) return "revenueResult";
  if (event.overallResult !== undefined && event.overallResult !== null && !["Beat", "In Line", "Miss", "Mixed", "Not Available"].includes(String(event.overallResult))) return "overallResult";
  return null;
}

function earningsFromApi(payload: unknown): EarningsCompany[] | null {
  const events = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload.events)
      ? payload.events
      : null;
  if (!events) return null;
  // A well-formed empty list is a valid publication (engine not yet
  // populated, holiday weeks); only malformed payloads or fully rejected
  // records are "unavailable". Drop only the invalid records, never blank
  // the whole feature: a single malformed row (provider/contract drift)
  // must not hide the valid ones. Each rejection is logged with symbol +
  // field so the drift is diagnosable.
  if (events.length === 0) return [];
  const valid: EarningsCompany[] = [];
  for (const event of events) {
    if (!isRecord(event)) {
      console.warn("earnings: rejected non-object event", event);
      continue;
    }
    const invalidField = invalidEarningsEventField(event);
    if (invalidField !== null) {
      console.warn("earnings: rejected malformed event", { symbol: event.symbol, field: invalidField, event });
      continue;
    }
    try {
      valid.push(eventWithViewMetadata(event as Partial<EarningsEngineEvent>));
    } catch (error) {
      console.warn("earnings: rejected event that failed to map", { symbol: event.symbol, error });
    }
  }
  return valid.length > 0 ? valid : null;
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
      const sentiment = sentimentFromStatus(status);

      setData((previous) => {
        // A transient refresh failure must not blank a still-valid daily
        // analysis: retain the previous publication while its timestamp is
        // inside the 72h window.
        const retained = isWithinWindow(previous.opportunitiesUpdatedAt, BRIEFING_MAX_AGE_MS);
        const nextOpportunities = liveOpportunities ?? (retained ? previous.opportunities : []);
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
          opportunities: nextOpportunities,
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
