import { z } from "zod";
import {
  dashboardCandidateSchema,
  dashboardPortfolioSchema,
  dashboardPositionSchema,
  dashboardReadSchema,
  dashboardStrategySchema,
  isoTimestampSchema,
  marketDataSchema,
  publicSourceHealthSchema,
  sourceHealthSchema,
  type Candidate,
  type DashboardData,
  type EarningsEngineState,
  type MarketDataSnapshot,
  type PublicSourceHealth,
  type SourceHealth,
  type StrategySummary,
} from "@stock-autotrader/contracts";
import type { Env } from "./index";
import type { BriefingStatus } from "./daily-briefings";
import { EARNINGS_ENGINE_STALE_AFTER_SECONDS } from "./earnings";
import {
  INDEX_DEFINITIONS,
  MARKET_CONTEXT_STALE_AFTER_SECONDS,
  SENTIMENT_STALE_AFTER_SECONDS,
  marketCollectionWindow,
  readMarketContextHealth,
  type MarketContextHealthRecord,
  type MarketContextReadModel,
} from "./market-context";
import { activeUniverseExistsSql } from "./stock-universe";

/**
 * The public dashboard/source-health read model: builds validated responses
 * from D1 for /api/dashboard, /api/status and the narrower endpoints derived
 * from it. index.ts only routes requests here and serializes the result.
 */

export const unavailableBriefingStatus = (): BriefingStatus => ({
  available: false,
  freshness: "unavailable",
  editionDate: null,
  editionType: null,
  preparedAt: null,
  publishedAt: null,
  ageSeconds: null,
});

const int = (v: unknown): number => Number(v) || 0;
const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const bool = (v: unknown): boolean => Number(v) === 1;

const parseJson = (v: unknown, fallback: unknown) => {
  if (v === null || v === undefined) return fallback;
  try {
    return JSON.parse(String(v));
  } catch {
    return fallback;
  }
};

export const emptyMarketData: MarketDataSnapshot = {
  provider: "unavailable",
  status: "offline",
  asOf: null,
  lastSuccessfulUpdate: null,
  universe: { total: 0, eligible: 0, excluded: 0 },
  benchmarks: [],
  warnings: ["No validated market-data snapshot has been published."],
  updatedAt: null,
};

export const emptyDashboard: DashboardData = {
  demo: false,
  status: { engine: "offline", latestScan: null, nextScan: null, lastDataUpdate: null, apiHealth: "degraded" },
  marketData: emptyMarketData,
  scan: { universe: 0, passedFilters: 0, candidates: 0, setups: 0, watch: 0 },
  portfolio: {
    initialCapital: 10000,
    equity: 0,
    returnPct: 0,
    cash: 0,
    invested: 0,
    openPositions: 0,
    openRiskPct: 0,
    grossExposurePct: 0,
    riskPolicy: {
      riskPerTradePct: 1,
      maxPositions: 1,
      maxOpenRiskPct: 1,
      maxSinglePositionPct: 1,
      maxSectorExposurePct: 1,
      maxGrossExposurePct: 1,
      leverage: "1x",
      averagingDown: false,
      martingale: false,
    },
  },
  strategies: [],
  candidates: [],
  events: [],
  earnings: [],
  positions: [],
  research: [],
};

const parseIsoTimestamp = (value: unknown): string | null => {
  const candidate = str(value);
  return candidate && isoTimestampSchema.safeParse(candidate).success ? candidate : null;
};

const HEALTHY_STALE_AFTER_SECONDS = 26 * 60 * 60;
const X_STALE_AFTER_SECONDS = 7 * 24 * 60 * 60;

const parseSafeTimestamp = (value: string | null): number | null => {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const latestTimestamp = (...values: Array<string | null | undefined>): string | null => {
  let latestMs: number | null = null;
  for (const value of values) {
    const parsed = parseSafeTimestamp(value ?? null);
    if (parsed !== null && (latestMs === null || parsed > latestMs)) latestMs = parsed;
  }
  return latestMs === null ? null : new Date(latestMs).toISOString();
};

/**
 * Single, honest freshness boundary shared by every public data source.
 * Sources without a validated success stay Unavailable/Error; a success
 * older than the domain stale-after window becomes Stale, never Live.
 */
export function buildSourceHealth(
  lastSuccessAt: string | null,
  lastAttemptAt: string | null,
  options: { provider: string; staleAfterSeconds: number; error?: string | null; nowMs?: number },
): SourceHealth {
  const nowMs = options.nowMs ?? Date.now();
  const lastSuccessMs = parseSafeTimestamp(lastSuccessAt);
  const lastAttemptMs = parseSafeTimestamp(lastAttemptAt);
  const hasValidSuccess = lastSuccessMs !== null && lastSuccessMs <= nowMs;
  const hasError = options.error !== null && options.error !== undefined;
  // Evidence of activity: an explicit attempt wins; a current error is an
  // attempt; otherwise the last success is the latest confirmed activity (an
  // attempt necessarily happened at or before it). Keeps every emitted state
  // schema-valid — e.g. Live requires an attempt timestamp.
  const effectiveLastAttemptMs = lastAttemptMs !== null && lastAttemptMs <= nowMs
    ? lastAttemptMs
    : hasError
      ? nowMs
      : lastSuccessMs;
  const ageSeconds = hasValidSuccess ? Math.floor((nowMs - (lastSuccessMs ?? 0)) / 1000) : null;
  const state = !hasValidSuccess
    ? hasError ? "Error" : "Unavailable"
    : hasError
      ? "Cached"
      : ageSeconds !== null && ageSeconds <= options.staleAfterSeconds ? "Live" : "Stale";
  return {
    provider: options.provider,
    state,
    asOf: hasValidSuccess ? new Date(lastSuccessMs ?? 0).toISOString() : null,
    ageSeconds,
    staleAfterSeconds: options.staleAfterSeconds,
    lastSuccess: hasValidSuccess ? new Date(lastSuccessMs ?? 0).toISOString() : null,
    lastAttempt: effectiveLastAttemptMs !== null ? new Date(effectiveLastAttemptMs).toISOString() : null,
    error: options.error ?? null,
  };
}

export function buildMarketSourceHealth(market: MarketDataSnapshot, nowMs = Date.now()): SourceHealth {
  const provider = market.status === "offline" ? "unavailable" : market.provider;
  const error = market.status === "offline"
    ? market.warnings[0] ?? "Market data is unavailable."
    : market.status === "degraded"
      ? market.warnings[0] ?? "Market data is degraded."
      : null;
  // The freshness gate must observe the data, not the collection time: on a
  // holiday or right after the open the bars are older than the request.
  // The first argument drives Live/Stale, so the most recent bar wins.
  const indices = market.indices ?? [];
  const observation = indices.length > 0
    ? indices.reduce((latest, index) => (index.updatedAt > latest ? index.updatedAt : latest), indices[0]!.updatedAt)
    : (market.updatedAt ?? market.lastSuccessfulUpdate);
  return buildSourceHealth(observation, market.lastSuccessfulUpdate ?? observation, {
    provider,
    staleAfterSeconds: HEALTHY_STALE_AFTER_SECONDS,
    error,
    nowMs,
  });
}

const MARKET_SET_INCOMPLETE_OR_PRIOR_SESSION = "Market index set is incomplete or from a prior session.";

export function buildMarketContextHealth(
  context: MarketContextReadModel,
  nowMs = Date.now(),
  health: MarketContextHealthRecord | null = null,
): SourceHealth {
  const latestSourceMs = parseSafeTimestamp(context.latestSourceTimestamp);
  if (latestSourceMs === null) {
    return buildSourceHealth(null, null, {
      provider: health?.provider ?? "unavailable",
      staleAfterSeconds: MARKET_CONTEXT_STALE_AFTER_SECONDS,
      error: health?.lastError ?? "No market index data has been collected.",
      nowMs,
    });
  }
  const expectedSymbols = new Set(["SPX", "NDX", "DJI", "VIX"]);
  const complete = context.indices.length === expectedSymbols.size
    && context.indices.every((index) => expectedSymbols.has(index.symbol));
  const latestDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(latestSourceMs));
  const currentDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(nowMs));
  const indexDates = new Set(context.indices.flatMap((index) => {
    const timestamp = parseSafeTimestamp(index.updatedAt);
    return timestamp === null ? [] : [new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(timestamp))];
  }));
  return buildSourceHealth(new Date(latestSourceMs).toISOString(), health?.lastAttemptAt ?? context.latestCollectedAt ?? context.latestSourceTimestamp, {
    provider: health?.provider ?? context.provider ?? "unavailable",
    staleAfterSeconds: MARKET_CONTEXT_STALE_AFTER_SECONDS,
    error: health?.lastError ?? (complete && indexDates.size === 1 && latestDate === currentDate
      ? null
      : MARKET_SET_INCOMPLETE_OR_PRIOR_SESSION),
    nowMs,
  });
}

export async function buildSources(
  env: Env,
  options: {
    briefing: BriefingStatus;
    dashboard: DashboardData;
    marketContext?: MarketContextReadModel;
    marketContextHealth?: MarketContextHealthRecord | null;
    nowMs?: number;
  },
): Promise<PublicSourceHealth> {
  const nowMs = options.nowMs ?? Date.now();
  const brief = options.briefing;
  const market = options.dashboard.marketData;
  // /healthz/sources passes the strict-read record in (it must fail closed
  // when the record is unreadable); every other caller lets the lenient read
  // collapse absent/unreadable into null, as the public UI expects.
  const marketContextHealth = options.marketContextHealth !== undefined
    ? options.marketContextHealth
    : options.marketContext ? await readMarketContextHealth(env.DB) : null;

  let xLastSuccess: string | null = null;
  let xError: string | null = null;
  try {
    // Freshness follows the latest successful collection, not the
    // newest-created post: out-of-order collection/backfill and all-duplicate
    // runs are recorded in app_meta, with MAX(collected_at) as fallback.
    const row = await env.DB.prepare(
      "SELECT COALESCE((SELECT value FROM app_meta WHERE key = 'xPostsUpdatedAt'), (SELECT MAX(collected_at) FROM x_posts)) AS ts",
    ).first<{ ts: string | null }>();
    xLastSuccess = row?.ts ? new Date(row.ts).toISOString() : null;
  } catch {
    xError = "X store is unavailable.";
  }

  let earningsLastSuccess: string | null = null;
  let earningsLastAttempt: string | null = null;
  let earningsError: string | null = null;
  let earningsUniverseCount = 0;
  let secLastAttempt: string | null = null;
  let secLastSuccess: string | null = null;
  let secLastError: string | null = null;
  let secConsecutiveFailures = 0;
  let metadataLastAttempt: string | null = null;
  let metadataLastSuccess: string | null = null;
  let metadataLastError: string | null = null;
  let metadataConsecutiveFailures = 0;
  try {
    // Publication metadata records a successful empty calendar too: a valid
    // update with zero rows is healthy. Universe count is checked separately
    // so an empty filtered date range is never mistaken for initialization.
    // The sec_* / metadata_* keys are enrichment diagnostics only: they never
    // feed earningsError, so a SEC or Finnhub-profile outage cannot degrade
    // the critical gate.
    const row = await env.DB.prepare(
      "SELECT (SELECT value FROM app_meta WHERE key = 'earningsEngineUpdatedAt') AS updated_at, (SELECT value FROM app_meta WHERE key = 'earningsEngineCheckedAt') AS checked_at, (SELECT value FROM app_meta WHERE key = 'earningsEngineLastAttemptAt') AS attempt_at, (SELECT value FROM app_meta WHERE key = 'earningsCalendarLastError') AS calendar_error, (SELECT value FROM app_meta WHERE key = 'earningsMonitorLastError') AS monitor_error, (SELECT value FROM app_meta WHERE key = 'earningsEngineLastError') AS last_error, (SELECT value FROM app_meta WHERE key = 'earningsSecLastAttemptAt') AS sec_attempt_at, (SELECT value FROM app_meta WHERE key = 'earningsSecLastSuccessAt') AS sec_success_at, (SELECT value FROM app_meta WHERE key = 'earningsSecLastError') AS sec_error, (SELECT value FROM app_meta WHERE key = 'earningsSecConsecutiveFailures') AS sec_failures, (SELECT value FROM app_meta WHERE key = 'earningsMetadataLastAttemptAt') AS metadata_attempt_at, (SELECT value FROM app_meta WHERE key = 'earningsMetadataLastSuccessAt') AS metadata_success_at, (SELECT value FROM app_meta WHERE key = 'earningsMetadataLastError') AS metadata_error, (SELECT value FROM app_meta WHERE key = 'earningsMetadataConsecutiveFailures') AS metadata_failures, (SELECT COUNT(*) FROM earnings_universe WHERE active = 1 AND source = 'core') AS universe_count",
    ).first<{
      updated_at: string | null;
      checked_at: string | null;
      attempt_at: string | null;
      calendar_error: string | null;
      monitor_error: string | null;
      last_error: string | null;
      sec_attempt_at: string | null;
      sec_success_at: string | null;
      sec_error: string | null;
      sec_failures: string | null;
      metadata_attempt_at: string | null;
      metadata_success_at: string | null;
      metadata_error: string | null;
      metadata_failures: string | null;
      universe_count: number | string | null;
    }>();
    const updatedAt = parseIsoTimestamp(row?.updated_at);
    const checkedAt = parseIsoTimestamp(row?.checked_at);
    earningsLastSuccess = updatedAt;
    earningsLastAttempt = latestTimestamp(updatedAt, checkedAt, parseIsoTimestamp(row?.attempt_at));
    earningsError = row?.calendar_error?.trim()
      || row?.monitor_error?.trim()
      || row?.last_error?.trim()
      || null;
    earningsUniverseCount = Number(row?.universe_count ?? 0) || 0;
    secLastAttempt = parseIsoTimestamp(row?.sec_attempt_at);
    secLastSuccess = parseIsoTimestamp(row?.sec_success_at);
    // Runtime writes are bounded (480 chars), but clamp again so an oversized
    // app_meta value can never fail the strict source-health schema parse.
    secLastError = row?.sec_error?.trim().slice(0, 500) || null;
    const secFailuresRaw = row?.sec_failures;
    secConsecutiveFailures = typeof secFailuresRaw === "string" && /^\d+$/.test(secFailuresRaw) ? Number(secFailuresRaw) : 0;
    metadataLastAttempt = parseIsoTimestamp(row?.metadata_attempt_at);
    metadataLastSuccess = parseIsoTimestamp(row?.metadata_success_at);
    metadataLastError = row?.metadata_error?.trim().slice(0, 500) || null;
    const metadataFailuresRaw = row?.metadata_failures;
    metadataConsecutiveFailures = typeof metadataFailuresRaw === "string" && /^\d+$/.test(metadataFailuresRaw)
      ? Number(metadataFailuresRaw)
      : 0;
  } catch {
    earningsError = "Earnings store is unavailable.";
  }

  const earningsUninitialized = earningsUniverseCount <= 0 || earningsLastSuccess === null;
  const earningsLastSuccessMs = parseSafeTimestamp(earningsLastSuccess);
  const earningsHasValidSuccess = earningsLastSuccessMs !== null && earningsLastSuccessMs <= nowMs;
  const earningsEngineState: EarningsEngineState = earningsUninitialized
    ? "UNINITIALIZED"
    : earningsError
      ? "DEGRADED"
      : earningsHasValidSuccess
        && earningsLastSuccessMs !== null
        && nowMs - earningsLastSuccessMs <= EARNINGS_ENGINE_STALE_AFTER_SECONDS * 1000
        ? "HEALTHY"
        : "STALE";

  const lastDataUpdate = options.dashboard.status.lastDataUpdate;
  // The scan completion timestamp is the authoritative success evidence,
  // whether the scan yielded zero or many candidates.
  const scanSuccessAt = options.dashboard.status.latestScan;
  // A degraded or delayed engine must not keep presenting retained results
  // as Live: pass the failure through so buildSourceHealth classifies them
  // Cached.
  const scanEngineDegraded = options.dashboard.status.engine !== "online"
    || options.dashboard.status.apiHealth === "degraded";

  const sources = {
    briefing: buildSourceHealth(brief.publishedAt, brief.publishedAt, {
      provider: "stock-autotrader publisher",
      staleAfterSeconds: HEALTHY_STALE_AFTER_SECONDS,
      error: null,
      nowMs,
    }),
    market: options.marketContext ? buildMarketContextHealth(options.marketContext, nowMs, marketContextHealth) : buildMarketSourceHealth(market, nowMs),
    opportunities: buildSourceHealth(scanSuccessAt, lastDataUpdate, {
      provider: "scan engine",
      staleAfterSeconds: HEALTHY_STALE_AFTER_SECONDS,
      error: scanSuccessAt === null
        ? "No scan has completed."
        : scanEngineDegraded
          ? "Scan engine is degraded."
          : null,
      nowMs,
    }),
    x: buildSourceHealth(xLastSuccess, xLastSuccess, {
      provider: "x-search collector",
      staleAfterSeconds: X_STALE_AFTER_SECONDS,
      error: xError,
      nowMs,
    }),
    earnings: {
      ...buildSourceHealth(earningsLastSuccess, earningsLastAttempt, {
        provider: "finnhub-earnings-calendar",
        staleAfterSeconds: EARNINGS_ENGINE_STALE_AFTER_SECONDS,
        // UNINITIALIZED is an unavailable state, not a synthetic failed job.
        // Real attempt timestamps remain visible when an actual pre-bootstrap
        // provider attempt occurred, but a status read creates none.
        error: earningsUninitialized ? null : earningsError,
        nowMs,
      }),
      engineState: earningsEngineState,
      // Best-effort enrichment diagnostics only. SEC EDGAR (filings) and
      // Finnhub Company Profile 2 (logos/industry) are independent paths;
      // neither feeds engineState or downCriticalSources.
      enrichment: {
        sec: {
          provider: "sec-edgar",
          lastAttempt: secLastAttempt,
          lastSuccess: secLastSuccess,
          lastError: secLastError,
          consecutiveFailures: secConsecutiveFailures,
        },
        metadata: {
          provider: "finnhub-company-profile",
          lastAttempt: metadataLastAttempt,
          lastSuccess: metadataLastSuccess,
          lastError: metadataLastError,
          consecutiveFailures: metadataConsecutiveFailures,
        },
      },
    },
    sentiment: options.marketContext?.sentiment
      ? buildSourceHealth(options.marketContext.sentiment.asOf, options.marketContext.sentiment.asOf, {
          provider: options.marketContext.sentiment.provider,
          staleAfterSeconds: SENTIMENT_STALE_AFTER_SECONDS,
          error: null,
          nowMs,
        })
      : buildSourceHealth(null, null, {
          provider: "unavailable",
          staleAfterSeconds: SENTIMENT_STALE_AFTER_SECONDS,
          error: null,
          nowMs,
        }),
    quickStats: buildSourceHealth(null, null, {
      provider: "unavailable",
      staleAfterSeconds: HEALTHY_STALE_AFTER_SECONDS,
      error: null,
      nowMs,
    }),
  };
  return validateSourceHealth(sources);
}

/**
 * Canonical health gate for /healthz/sources. Returns the critical sources
 * that are *effectively unhealthy* according to the runtime's own health
 * model (buildSources + buildMarketContextHealth) — the error path comes
 * straight from canonical state, and the one gap the runtime cannot record
 * itself (a collection that silently stops without ever producing an error)
 * is covered by a monotonic session-time check over the canonical read model:
 *
 * - `market` is down when its canonical state is `Unavailable`/`Error` (no
 *   valid data: never collected, corrupt/future timestamps, or an empty
 *   read model), when the canonical Market Context health record carries a
 *   runtime failure (`lastError` surfaces verbatim as `sources.market.error`,
 *   distinguishing an active collection failure from the ordinary
 *   prior-session marker), or when the required index set is incomplete.
 *   A complete set from a prior NY session date (`Cached` with only the
 *   "incomplete or from a prior session" marker) is NOT down — that is a
 *   closed market (overnight/weekend/holiday), not an outage.
 * - `marketDataOverdue()` below closes the no-error gaps: a collection job
 *   that never runs (dead scheduler/trigger), a provider that keeps
 *   answering 200 with frozen quotes, or a single index that silently stops
 *   updating while the others move. It counts minutes of *actual session
 *   time* (regular + post-close, via the canonical
 *   `marketCollectionWindow()`) since each required index's own `updatedAt`,
 *   flagging once that exceeds MARKET_DATA_MAX_ACTIVE_MINUTES (45 — three
 *   missed 15-minute ticks). The count is monotonic — session time never
 *   un-counts when the window closes — so an incident flagged mid-session
 *   stays flagged through the close and across the weekend until fresh data
 *   actually arrives (it never "heals" merely because the market closed),
 *   while a set that was genuinely fresh at Friday's close accrues at most
 *   the 30 post-close minutes, under the threshold, over the weekend. A
 *   late-session freeze that misses the closing print keeps accumulating
 *   through the post-close window and is flagged by ~16:45 ET. A 96h
 *   absolute backstop catches outages spanning implausibly long closed
 *   stretches (multiple back-to-back holidays) that accumulate no session
 *   minutes at all.
 * - `earnings` is down unless the canonical engine state is `HEALTHY`.
 *   `engineState` is derived by buildSources from the live
 *   `earnings_universe` row count + last success + error + the canonical
 *   26h stale window, so an empty/invalid universe can never read as
 *   healthy off a cached timestamp (UNINITIALIZED always down), and an
 *   active collection failure (DEGRADED) or missed daily sync (STALE) is
 *   always down.
 *
 * Non-critical sources (`opportunities`, `x`, `sentiment`, `quickStats`,
 * `briefing`) never gate this endpoint.
 */
const MARKET_DATA_MAX_ACTIVE_MINUTES = 45;
const MARKET_DATA_MAX_AGE_SECONDS_CLOSED = 96 * 60 * 60;

/**
 * Whether at least `thresholdMinutes` of session time have elapsed between
 * two instants, sampled every 5 minutes rather than exactly (a per-minute
 * sweep over a MARKET_DATA_MAX_AGE_SECONDS_CLOSED-wide span is ~5760
 * Intl-backed date computations — measurably slow on every poll of a health
 * endpoint). 5-minute steps cap the scan at ~1150 and can only misjudge a
 * real span by up to one step (5 minutes) right at the threshold boundary.
 * Both the regular and the post-close window count as session time: a
 * freeze in the final regular minutes then misses the closing and post-close
 * collections, which together accumulate past the 45-minute allowance by
 * ~16:45 ET and keep the incident flagged through the close — a healthy
 * runtime's post-close runs reset the clock with the closing print, landing
 * at most 30 minutes below the threshold. Returns as soon as the threshold
 * is crossed — the case that matters most (data that is actually overdue)
 * is also the cheapest, while only the "still within tolerance" case scans
 * further.
 */
function regularSessionMinutesExceed(fromMs: number, toMs: number, thresholdMinutes: number): boolean {
  const stepMs = 5 * 60 * 1000;
  let minutes = 0;
  for (let t = fromMs; t < toMs; t += stepMs) {
    if (marketCollectionWindow(new Date(t)) !== null) {
      minutes += 5;
      if (minutes > thresholdMinutes) return true;
    }
  }
  return false;
}

/**
 * Monotonic session-time staleness for the market read model. Checks every
 * required index's own `updatedAt` (not the aggregate newest row, which a
 * single stuck index would hide), accumulating only regular-session minutes.
 * Corrupt data (missing index, unparseable/future timestamps) fails closed.
 */
function marketDataOverdue(context: MarketContextReadModel, nowMs: number): boolean {
  const bySymbol = new Map(context.indices.map((index) => [index.symbol, index]));
  // Indices normally share one updatedAt (one atomic collection tick), so
  // the multi-hour scan runs once per distinct timestamp, not per index.
  const overdueByUpdatedMs = new Map<number, boolean>();
  return INDEX_DEFINITIONS.some((definition) => {
    const index = bySymbol.get(definition.symbol);
    if (!index) return true;
    const updatedMs = parseSafeTimestamp(index.updatedAt);
    if (updatedMs === null) return true;
    const ageSeconds = (nowMs - updatedMs) / 1000;
    if (ageSeconds < 0 || ageSeconds > MARKET_DATA_MAX_AGE_SECONDS_CLOSED) return true;
    const cached = overdueByUpdatedMs.get(updatedMs);
    if (cached !== undefined) return cached;
    const overdue = regularSessionMinutesExceed(updatedMs, nowMs, MARKET_DATA_MAX_ACTIVE_MINUTES);
    overdueByUpdatedMs.set(updatedMs, overdue);
    return overdue;
  });
}

export function downCriticalSources(
  sources: PublicSourceHealth,
  marketContext: MarketContextReadModel,
  nowMs = Date.now(),
): ("market" | "earnings")[] {
  const down: ("market" | "earnings")[] = [];
  const market = sources.market;
  const marketSetComplete = marketContext.indices.length === INDEX_DEFINITIONS.length
    && INDEX_DEFINITIONS.every((definition) =>
      marketContext.indices.some((index) => index.symbol === definition.symbol));
  const marketDown = market.state === "Unavailable"
    || market.state === "Error"
    || (market.state === "Cached" && market.error !== MARKET_SET_INCOMPLETE_OR_PRIOR_SESSION)
    || !marketSetComplete
    || marketDataOverdue(marketContext, nowMs);
  if (marketDown) down.push("market");
  if (sources.earnings.engineState !== "HEALTHY") down.push("earnings");
  return down;
}

/**
 * Fail closed per source: a source that violates the shared contract degrades
 * to Unavailable on its own — it never wipes the health of the other sources.
 */
export function validateSourceHealth(sources: PublicSourceHealth): PublicSourceHealth {
  const validated = publicSourceHealthSchema.safeParse(sources);
  if (validated.success) return validated.data;
  console.error("source-health validation failed", validated.error.issues.length);
  const sanitize = (source: SourceHealth): SourceHealth =>
    sourceHealthSchema.safeParse(source).success
      ? source
      : buildSourceHealth(null, null, {
          provider: "unavailable",
          staleAfterSeconds: HEALTHY_STALE_AFTER_SECONDS,
          error: null,
        });
  return {
    briefing: sanitize(sources.briefing),
    market: sanitize(sources.market),
    opportunities: sanitize(sources.opportunities),
    x: sanitize(sources.x),
    earnings: sanitize(sources.earnings),
    sentiment: sanitize(sources.sentiment),
    quickStats: sanitize(sources.quickStats),
  };
}

/**
 * Fail-closed source health for degraded fallback responses: every source is
 * Unavailable so the public contract keeps its shape even when the dashboard
 * read fails.
 */
export function unavailableSources(): PublicSourceHealth {
  const unavailable = (error: string): SourceHealth => buildSourceHealth(null, null, {
    provider: "unavailable",
    staleAfterSeconds: HEALTHY_STALE_AFTER_SECONDS,
    error,
  });
  const reason = "Source health is unavailable.";
  return {
    briefing: unavailable(reason),
    market: unavailable(reason),
    opportunities: unavailable(reason),
    x: unavailable(reason),
    earnings: { ...unavailable(reason), engineState: "UNINITIALIZED" },
    sentiment: unavailable(reason),
    quickStats: unavailable(reason),
  };
}

export const normalizeDirection = (value: unknown): Candidate["direction"] =>
  value === "Long" ? "Bullish" : String(value) as Candidate["direction"];

interface ScanRow {
  id: number;
  scanned_at: string;
  universe: number;
  passed_filters: number;
  candidates: number;
  setups: number;
  watch: number;
}

function mapStrategyRow(s: Record<string, unknown>): StrategySummary {
  return {
    id: String(s.id),
    name: String(s.name),
    version: String(s.version),
    description: str(s.description) ?? "",
    state: String(s.status) as StrategySummary["state"],
    enabled: true,
    universe: str(s.universe) ?? "",
    holdingPeriod: str(s.typical_holding_period) ?? "",
    signalsToday: int(s.signals_today),
    openPositions: int(s.open_shadow_positions),
    parameters: parseJson(s.metadata, {}),
  };
}

function mapCandidateRow(c: Record<string, unknown>, reasons: Record<string, unknown>[]): Candidate {
  return {
    symbol: String(c.symbol),
    company: str(c.company) ?? "",
    sector: str(c.sector) ?? "",
    marketCap: int(c.market_cap),
    price: num(c.price),
    quantScore: int(c.quant_score),
    strategyId: String(c.strategy_id),
    strategyVersion: String(c.strategy_version),
    strategy: String(c.strategy),
    trend: (str(c.trend) ?? "") as Candidate["trend"],
    momentum: num(c.momentum),
    relativeStrength: num(c.relative_strength),
    relativeVolume: num(c.relative_volume),
    breakout: str(c.breakout),
    earningsDate: str(c.earnings_date),
    earningsProximityDays: c.earnings_proximity_days === null ? null : int(c.earnings_proximity_days),
    status: String(c.status) as Candidate["status"],
    direction: normalizeDirection(c.direction),
    riskFlags: parseJson(c.risk_flags, []) as string[],
    updatedAt: String(c.updated_at),
    reasons: reasons.map((r) => ({
      id: String(r.reason_code),
      outcome: String(r.outcome) as "pass" | "reject" | "info",
      code: String(r.reason_code),
      label: String(r.reason_label),
      observed: str(r.observed) ?? undefined,
      threshold: str(r.threshold) ?? undefined,
    })),
  };
}

function mapPositionRow(p: Record<string, unknown>): DashboardData["positions"][number] {
  return {
    symbol: String(p.symbol),
    strategy: String(p.strategy),
    entryPrice: num(p.entry_price),
    currentPrice: num(p.current_price),
    stopPrice: num(p.stop_price),
    quantity: int(p.quantity),
    riskAmount: num(p.risk_amount),
    unrealizedPnl: num(p.unrealized_pnl),
    returnPct: num(p.return_pct),
    rMultiple: num(p.r_multiple),
    openedAt: String(p.opened_at),
  };
}

/**
 * Derive portfolio totals from the same active-universe positions that are
 * returned publicly. Cash is authoritative from app_meta; active-universe
 * equity is that real cash plus only the visible holdings. This prevents a
 * hidden position's value from being reclassified as public cash and keeps
 * exposure and risk denominators on the same scope as the positions.
 */
function derivePortfolioFromActivePositions(
  metaMap: Map<string, string>,
  positions: DashboardData["positions"],
) {
  const cash = Math.max(num(metaMap.get("cash") ?? 0), 0);
  const initialCapital = num(metaMap.get("initialCapital") ?? 10000);
  const invested = positions.reduce(
    (total, position) => total + Math.max(position.currentPrice * position.quantity, 0),
    0,
  );
  const equity = cash + invested;
  const openRisk = positions.reduce((total, position) => total + Math.max(position.riskAmount, 0), 0);
  const equityDenominator = equity > 0 ? equity : 0;

  return {
    initialCapital,
    equity,
    returnPct: initialCapital > 0 ? ((equity - initialCapital) / initialCapital) * 100 : 0,
    cash,
    invested,
    openPositions: positions.length,
    openRiskPct: equityDenominator > 0 ? (openRisk / equityDenominator) * 100 : 0,
    grossExposurePct: equityDenominator > 0 ? (invested / equityDenominator) * 100 : 0,
    riskPolicy: parseJson(metaMap.get("riskPolicy"), {}),
  };
}

/**
 * Parse+validate the published `marketData` app_meta snapshot and apply the
 * shared staleness gate: a "healthy" snapshot whose publish timestamp has
 * gone stale (or is malformed) is degraded rather than presented as current.
 * Shared by buildDashboard() and the scoped /api/market-data reader so they
 * can never disagree about what "current" market data means.
 */
function deriveMarketData(rawValue: unknown): MarketDataSnapshot {
  const parsed = marketDataSchema.safeParse(parseJson(rawValue, null));
  let marketData: MarketDataSnapshot = parsed.success ? parsed.data : emptyMarketData;
  if (marketData.status === "healthy" && marketData.lastSuccessfulUpdate) {
    const publishedAt = Date.parse(marketData.lastSuccessfulUpdate);
    const ageMs = Date.now() - publishedAt;
    if (!Number.isFinite(publishedAt) || ageMs < -5 * 60 * 1000 || ageMs > 26 * 60 * 60 * 1000) {
      marketData = {
        ...marketData,
        status: "degraded",
        warnings: [...marketData.warnings, "Last healthy market-data snapshot is stale or has an invalid timestamp."],
      };
    }
  }
  return marketData;
}

export async function buildDashboard(env: Env): Promise<DashboardData> {
  // A single db.batch() round trip instead of 8 separate ones: these queries
  // are already all-or-nothing (a failure on any of them was already fatal
  // to the whole call, via the .first()/Promise.all() this replaces), so
  // batching changes nothing about failure semantics.
  // A fixed 8-statement batch: each index below is guaranteed present.
  const batchResults = await env.DB.batch([
    env.DB.prepare("SELECT key, value FROM app_meta"),
    env.DB.prepare("SELECT * FROM scans ORDER BY id DESC LIMIT 1"),
    env.DB.prepare("SELECT * FROM strategies ORDER BY id"),
    // Surface only active-universe candidates from the latest scan (older scans
    // are history, and removed symbols remain stored but are not public).
    env.DB.prepare(`SELECT c.* FROM scan_candidates AS c WHERE c.scan_id = (SELECT MAX(id) FROM scans) AND ${activeUniverseExistsSql("c.symbol")} ORDER BY c.id`),
    // `earnings` is the legacy quant/screening table, not the Automated
    // Earnings Engine's read model — see README.md "Automated Earnings
    // Engine (PR #12)". /api/earnings reads `earnings_events` instead,
    // via readEarningsApi() in worker/earnings/.
    env.DB.prepare(`SELECT e.* FROM earnings AS e WHERE ${activeUniverseExistsSql("e.symbol")} ORDER BY e.date`),
    env.DB.prepare(`SELECT p.* FROM shadow_positions AS p WHERE ${activeUniverseExistsSql("p.symbol")} ORDER BY p.id`),
    env.DB.prepare(`SELECT e.* FROM bot_events AS e WHERE e.symbol IS NULL OR ${activeUniverseExistsSql("e.symbol")} ORDER BY e.id`),
    env.DB.prepare("SELECT * FROM research ORDER BY id"),
  ]);
  const [metaRes, scanRes, strategiesRes, candidatesRes, earningsRes, positionsRes, eventsRes, researchRes] =
    batchResults as [
      D1Result, D1Result, D1Result, D1Result, D1Result, D1Result, D1Result, D1Result,
    ];
  const metaMap = new Map<string, string>((metaRes.results as { key: string; value: string }[]).map((r) => [r.key, r.value]));
  const scan = (scanRes.results[0] ?? null) as ScanRow | null;

  const candidateRows = (candidatesRes.results as Record<string, unknown>[]).map((r) => Number(r.id));
  let reasons: Record<string, unknown>[] = [];
  if (candidateRows.length > 0) {
    const placeholders = candidateRows.map(() => "?").join(",");
    reasons = (
      await env.DB.prepare(`SELECT * FROM decision_reasons WHERE candidate_id IN (${placeholders})`).bind(...candidateRows).all()
    ).results as Record<string, unknown>[];
  }
  const reasonsByCandidate = new Map<number, Record<string, unknown>[]>();
  for (const r of reasons) {
    const cid = Number(r.candidate_id);
    if (!reasonsByCandidate.has(cid)) reasonsByCandidate.set(cid, []);
    reasonsByCandidate.get(cid)!.push(r);
  }

  const strategies = (strategiesRes.results as Record<string, unknown>[]).map(mapStrategyRow);
  const candidates = (candidatesRes.results as Record<string, unknown>[])
    .map((c) => mapCandidateRow(c, reasonsByCandidate.get(Number(c.id)) ?? []));
  const candidateCounts = {
    candidates: candidates.length,
    setups: candidates.filter((candidate) => candidate.status === "Strong Setup").length,
    watch: candidates.filter((candidate) => candidate.status === "Watch").length,
  };

  const earnings = (earningsRes.results as Record<string, unknown>[]).map((e) => ({
    symbol: String(e.symbol),
    company: String(e.company),
    date: String(e.date),
    timing: String(e.timing) as "BMO" | "AMC" | "TBD",
    eventSignal: String(e.event_signal) as "Confirmed" | "Pending" | "Risk Window",
    engineRelevant: bool(e.engine_relevant),
    signal: (str(e.signal) ?? null) as Candidate["status"] | null,
    strategy: str(e.strategy),
    hasPosition: bool(e.has_position),
    tracked: bool(e.tracked),
    updatedAt: String(e.updated_at),
  }));

  const positions = (positionsRes.results as Record<string, unknown>[]).map(mapPositionRow);

  const events = (eventsRes.results as Record<string, unknown>[]).map((e) => ({
    id: String(e.event_id),
    type: String(e.event_type),
    message: String(e.message),
    severity: String(e.severity) as "success" | "warning" | "info",
    symbol: str(e.symbol) ?? undefined,
    strategyId: str(e.strategy_id) ?? undefined,
    createdAt: String(e.created_at),
  }));

  const research = (researchRes.results as Record<string, unknown>[]).map((r) => ({
    id: String(r.id),
    strategyId: String(r.strategy_id),
    strategy: String(r.strategy),
    stage: String(r.stage) as "Research" | "Validation" | "Out-of-Sample" | "Shadow" | "Live",
    period: String(r.period),
    status: String(r.status) as "Demo" | "Pending" | "Complete",
    metrics: parseJson(r.metrics, {}),
  }));

  const portfolio = derivePortfolioFromActivePositions(metaMap, positions);

  const marketData = deriveMarketData(metaMap.get("marketData"));

  // Stale-data detection: if the engine has not published in 26h (daily scans +
  // margin), surface it as delayed/degraded instead of pretending health.
  const latestScan = parseIsoTimestamp(scan?.scanned_at);
  const nextScan = parseIsoTimestamp(metaMap.get("nextScan"));
  const rawLastDataUpdate = str(metaMap.get("lastDataUpdate"));
  const lastDataUpdate = parseIsoTimestamp(rawLastDataUpdate);
  const lastUpdateMs = lastDataUpdate ? Date.parse(lastDataUpdate) : Number.NaN;
  const stale = !Number.isNaN(lastUpdateMs) && Date.now() - lastUpdateMs > 26 * 3600_000;
  const malformedFreshness =
    (scan !== null && latestScan === null) ||
    (metaMap.has("nextScan") && nextScan === null) ||
    (rawLastDataUpdate !== null && lastDataUpdate === null);
  const engine = (metaMap.get("engine") as DashboardData["status"]["engine"] | undefined) ?? "online";
  const apiHealth = (metaMap.get("apiHealth") as DashboardData["status"]["apiHealth"] | undefined) ?? "healthy";

  const dashboard = {
    demo: false,
    status: {
      engine: stale || malformedFreshness ? "delayed" : engine,
      latestScan,
      nextScan,
      lastDataUpdate,
      apiHealth: stale || malformedFreshness ? "degraded" : apiHealth,
    },
    marketData,
    scan: {
      universe: scan ? int(scan.universe) : 0,
      passedFilters: scan ? int(scan.passed_filters) : 0,
      candidates: candidateCounts.candidates,
      setups: candidateCounts.setups,
      watch: candidateCounts.watch,
    },
    portfolio,
    strategies,
    candidates,
    events,
    earnings,
    positions,
    research,
  };
  const validated = dashboardReadSchema.safeParse(dashboard);
  if (!validated.success) {
    console.error("dashboard read-model validation failed", validated.error.issues.length);
    return emptyDashboard;
  }
  return validated.data as DashboardData;
}

const PORTFOLIO_META_KEYS = [
  "initialCapital", "cash", "riskPolicy",
] as const;

/** Scoped read for /api/strategies: only the strategies table. */
export async function readStrategies(db: D1Database): Promise<StrategySummary[]> {
  const rows = await db.prepare("SELECT * FROM strategies ORDER BY id").all();
  const strategies = (rows.results as Record<string, unknown>[]).map(mapStrategyRow);
  const validated = z.array(dashboardStrategySchema).safeParse(strategies);
  if (!validated.success) {
    console.error("strategies read-model validation failed", validated.error.issues.length);
    return [];
  }
  return validated.data as StrategySummary[];
}

/** Scoped read for /api/portfolio/shadow: account metadata + active positions. */
export async function readPortfolioAndPositions(
  db: D1Database,
): Promise<{ portfolio: DashboardData["portfolio"]; positions: DashboardData["positions"] }> {
  const placeholders = PORTFOLIO_META_KEYS.map(() => "?").join(",");
  const [metaRes, positionsRes] = await Promise.all([
    db.prepare(`SELECT key, value FROM app_meta WHERE key IN (${placeholders})`).bind(...PORTFOLIO_META_KEYS).all(),
    db.prepare(`SELECT p.* FROM shadow_positions AS p WHERE ${activeUniverseExistsSql("p.symbol")} ORDER BY p.id`).all(),
  ]);
  const metaMap = new Map<string, string>((metaRes.results as { key: string; value: string }[]).map((r) => [r.key, r.value]));

  const rawPositions = (positionsRes.results as Record<string, unknown>[]).map(mapPositionRow);
  const validatedPositions = z.array(dashboardPositionSchema).safeParse(rawPositions);
  if (!validatedPositions.success) {
    console.error("positions read-model validation failed", validatedPositions.error.issues.length);
  }
  const positions = validatedPositions.success ? (validatedPositions.data as DashboardData["positions"]) : [];

  const rawPortfolio = derivePortfolioFromActivePositions(metaMap, positions);
  const validatedPortfolio = dashboardPortfolioSchema.safeParse(rawPortfolio);
  if (!validatedPortfolio.success) {
    console.error("portfolio read-model validation failed", validatedPortfolio.error.issues.length);
  }
  const portfolio = validatedPortfolio.success
    ? (validatedPortfolio.data as DashboardData["portfolio"])
    : emptyDashboard.portfolio;

  return { portfolio, positions };
}

/** Scoped read for /api/stocks/:symbol: only the one matching candidate + its reasons. */
export async function readCandidateBySymbol(db: D1Database, symbol: string): Promise<Candidate | null> {
  const row = await db.prepare(
    `SELECT c.* FROM scan_candidates AS c
     WHERE c.scan_id = (SELECT MAX(id) FROM scans)
       AND c.symbol = ?
       AND ${activeUniverseExistsSql("c.symbol")}
     ORDER BY c.id LIMIT 1`,
  ).bind(symbol).first<Record<string, unknown>>();
  if (!row) return null;
  const reasonsRes = await db.prepare("SELECT * FROM decision_reasons WHERE candidate_id = ?").bind(row.id).all();
  const candidate = mapCandidateRow(row, reasonsRes.results as Record<string, unknown>[]);
  const validated = dashboardCandidateSchema.safeParse(candidate);
  if (!validated.success) {
    console.error("candidate read-model validation failed", validated.error.issues.length);
    return null;
  }
  return validated.data as Candidate;
}

/** Scoped read for /api/market-data: only the marketData app_meta key. */
export async function readMarketData(db: D1Database): Promise<MarketDataSnapshot> {
  const row = await db.prepare("SELECT value FROM app_meta WHERE key = 'marketData'").first<{ value: string }>();
  return deriveMarketData(row?.value);
}
