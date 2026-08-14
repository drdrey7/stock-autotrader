import {
  briefingCalendarDateSchema,
  briefingEditionTypeSchema,
  dashboardReadSchema,
  marketDataSchema,
  publicSourceHealthSchema,
  sourceHealthSchema,
  type Candidate,
  type DashboardData,
  type MarketDataSnapshot,
  type PublicSourceHealth,
  type SourceHealth,
  type StrategySummary,
} from "@stock-autotrader/contracts";
import { handleIngest, isoTimestampSchema } from "./ingest";
import {
  readBriefingByDateAndType,
  readBriefingStatus,
  readLatestBriefing,
  type BriefingStatus,
} from "./daily-briefings";
import { readXPosts } from "./x-posts";
import {
  MARKET_CONTEXT_STALE_AFTER_SECONDS,
  SENTIMENT_STALE_AFTER_SECONDS,
  readMarketContext,
  runMarketContextJob,
  runSentimentJob,
  type MarketContextReadModel,
} from "./market-context";
import {
  EarningsQueryError,
  readEarningsApi,
  runEarningsJob,
} from "./earnings";
import { jobsForProductionCron } from "./cron-dispatcher";

/**
 * Stock Autotrader public read-only API (PR #2).
 * Serves sanitized public data from D1. No mutations, no admin, no broker routes.
 * Non-API requests fall through to Workers Assets (the SPA).
 */

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  INGEST_SECRET?: string;
  ENVIRONMENT?: string;
  FMP_API_KEY?: string;
  SEC_USER_AGENT?: string;
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=60",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, HEAD, OPTIONS",
      "access-control-allow-headers": "Content-Type, Accept",
    },
  });

const unavailableBriefingStatus = (): BriefingStatus => ({
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

const emptyMarketData: MarketDataSnapshot = {
  provider: "unavailable",
  status: "offline",
  asOf: null,
  lastSuccessfulUpdate: null,
  universe: { total: 0, eligible: 0, excluded: 0 },
  benchmarks: [],
  warnings: ["No validated market-data snapshot has been published."],
  updatedAt: null,
};

const emptyDashboard: DashboardData = {
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

export function buildMarketContextHealth(context: MarketContextReadModel, nowMs = Date.now()): SourceHealth {
  const latestSourceMs = parseSafeTimestamp(context.latestSourceTimestamp);
  if (latestSourceMs === null) {
    return buildSourceHealth(null, null, {
      provider: "unavailable",
      staleAfterSeconds: MARKET_CONTEXT_STALE_AFTER_SECONDS,
      error: "No market index data has been collected.",
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
  return buildSourceHealth(new Date(latestSourceMs).toISOString(), context.latestCollectedAt ?? context.latestSourceTimestamp, {
    provider: context.provider ?? "unavailable",
    staleAfterSeconds: MARKET_CONTEXT_STALE_AFTER_SECONDS,
    error: complete && indexDates.size === 1 && latestDate === currentDate
      ? null
      : "Market index set is incomplete or from a prior session.",
    nowMs,
  });
}

export async function buildSources(
  env: Env,
  options: {
    briefing: BriefingStatus;
    dashboard: DashboardData;
    marketContext?: MarketContextReadModel;
    nowMs?: number;
  },
): Promise<PublicSourceHealth> {
  const nowMs = options.nowMs ?? Date.now();
  const brief = options.briefing;
  const market = options.dashboard.marketData;

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
  let earningsError: string | null = null;
  try {
    // Publication metadata records a successful empty calendar too: a valid
    // EARNINGS_UPDATED with zero rows must not make the source Unavailable.
    const row = await env.DB.prepare(
      "SELECT COALESCE((SELECT value FROM app_meta WHERE key = 'earningsEngineUpdatedAt'), (SELECT MAX(updated_at) FROM earnings_events)) AS ts",
    ).first<{ ts: string | null }>();
    earningsLastSuccess = row?.ts ? new Date(row.ts).toISOString() : null;
  } catch {
    earningsError = "Earnings store is unavailable.";
  }

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
    market: options.marketContext ? buildMarketContextHealth(options.marketContext, nowMs) : buildMarketSourceHealth(market, nowMs),
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
    earnings: buildSourceHealth(earningsLastSuccess, earningsLastSuccess, {
      provider: "earnings calendar",
      staleAfterSeconds: HEALTHY_STALE_AFTER_SECONDS,
      error: earningsError,
      nowMs,
    }),
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
    earnings: unavailable(reason),
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

async function buildDashboard(env: Env): Promise<DashboardData> {
  const meta = await env.DB.prepare("SELECT key, value FROM app_meta").all();
  const metaMap = new Map<string, string>((meta.results as { key: string; value: string }[]).map((r) => [r.key, r.value]));

  const [scanRes, strategiesRes, candidatesRes, earningsRes, positionsRes, eventsRes, researchRes] = await Promise.all([
    env.DB.prepare("SELECT * FROM scans ORDER BY id DESC LIMIT 1").first(),
    env.DB.prepare("SELECT * FROM strategies ORDER BY id").all(),
    // Surface only the candidates from the latest scan (older scans are history).
    env.DB.prepare("SELECT * FROM scan_candidates WHERE scan_id = (SELECT MAX(id) FROM scans) ORDER BY id").all(),
    // `earnings` is the legacy quant/screening table, not the Automated
    // Earnings Engine's read model — see README.md "Automated Earnings
    // Engine (PR #12)". /api/earnings reads `earnings_events` instead,
    // via readEarningsApi() in worker/earnings/.
    env.DB.prepare("SELECT * FROM earnings ORDER BY date").all(),
    env.DB.prepare("SELECT * FROM shadow_positions ORDER BY id").all(),
    env.DB.prepare("SELECT * FROM bot_events ORDER BY id").all(),
    env.DB.prepare("SELECT * FROM research ORDER BY id").all(),
  ]);
  const scan = (scanRes ?? null) as ScanRow | null;

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

  const strategies: StrategySummary[] = (strategiesRes.results as Record<string, unknown>[]).map((s) => ({
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
  }));

  const candidates: Candidate[] = (candidatesRes.results as Record<string, unknown>[]).map((c) => ({
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
    reasons: (reasonsByCandidate.get(Number(c.id)) ?? []).map((r) => ({
      id: String(r.reason_code),
      outcome: String(r.outcome) as "pass" | "reject" | "info",
      code: String(r.reason_code),
      label: String(r.reason_label),
      observed: str(r.observed) ?? undefined,
      threshold: str(r.threshold) ?? undefined,
    })),
  }));

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

  const positions = (positionsRes.results as Record<string, unknown>[]).map((p) => ({
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
  }));

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

  const portfolio = {
    initialCapital: num(metaMap.get("initialCapital") ?? 10000),
    equity: num(metaMap.get("equity") ?? 0),
    returnPct: num(metaMap.get("returnPct") ?? 0),
    cash: num(metaMap.get("cash") ?? 0),
    invested: num(metaMap.get("invested") ?? 0),
    openPositions: int(metaMap.get("openPositions") ?? 0),
    openRiskPct: num(metaMap.get("openRiskPct") ?? 0),
    grossExposurePct: num(metaMap.get("grossExposurePct") ?? 0),
    riskPolicy: parseJson(metaMap.get("riskPolicy"), {}),
  };

  const rawMarketData = parseJson(metaMap.get("marketData"), null);
  const parsedMarketData = marketDataSchema.safeParse(rawMarketData);
  let marketData: MarketDataSnapshot = parsedMarketData.success ? parsedMarketData.data : emptyMarketData;
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
      candidates: scan ? int(scan.candidates) : 0,
      setups: scan ? int(scan.setups) : 0,
      watch: scan ? int(scan.watch) : 0,
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

export default {
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    if (env.ENVIRONMENT !== "production") {
      console.info("scheduled job ignored outside production", env.ENVIRONMENT ?? "unset");
      return;
    }
    const scheduledTime = new Date(controller.scheduledTime);
    const jobs = jobsForProductionCron(controller.cron, scheduledTime);
    if (jobs.length === 0) {
      console.warn("unknown cron trigger", controller.cron);
      return;
    }
    await Promise.all(jobs.map(async (job) => {
      if (job === "earnings-monitor") {
        await runEarningsJob(env, scheduledTime, "monitor");
        return;
      }
      if (job === "market-context") {
        await runMarketContextJob(env, scheduledTime);
        return;
      }
      if (job === "sentiment") {
        await runSentimentJob(env, scheduledTime);
        return;
      }
      await runEarningsJob(env, scheduledTime, "calendar");
    }));
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);

    // Protected publication endpoint (PR #3) — accepts POST before the GET-only gate.
    if (pathname === "/ingest/events") return handleIngest(request, env);

    if (request.method !== "GET" && request.method !== "HEAD" && request.method !== "OPTIONS") {
      return json({ error: "Method not allowed" }, 405);
    }

    if (pathname === "/healthz") {
      return json({ ok: true, time: new Date().toISOString() });
    }
    if (pathname === "/api/status") {
      try {
        const [dashboard, briefing, marketContext] = await Promise.all([
          buildDashboard(env),
          readBriefingStatus(env.DB),
          readMarketContext(env.DB),
        ]);
        const sources = await buildSources(env, { briefing, dashboard, marketContext });
        return json({
          ...dashboard,
          market: {
            indices: marketContext.indices,
            provider: marketContext.provider,
            latestSourceTimestamp: marketContext.latestSourceTimestamp,
            latestCollectedAt: marketContext.latestCollectedAt,
          },
          briefing,
          sources,
          sentiment: marketContext.sentiment,
        });
      } catch (err) {
        console.error("status error", err);
        try {
          // Keep the public contract shape under degradation: sources stay
          // present, every source fail-closed to Unavailable.
          return json({ ...await buildDashboard(env), briefing: unavailableBriefingStatus(), sources: unavailableSources(), sentiment: null });
        } catch {
          return json({ error: "Internal error" }, 500);
        }
      }
    }
    if (pathname === "/api/dashboard") {
      try {
        return json(await buildDashboard(env));
      } catch (err) {
        console.error("dashboard error", err);
        return json(emptyDashboard);
      }
    }
    if (pathname === "/api/briefs/latest") {
      const requestedEditionType = new URL(request.url).searchParams.get("editionType");
      const editionType = requestedEditionType === null
        ? undefined
        : briefingEditionTypeSchema.safeParse(requestedEditionType);
      if (requestedEditionType !== null && !editionType?.success) {
        return json({ error: "invalid_edition_type" }, 400);
      }
      try {
        const briefing = await readLatestBriefing(
          env.DB,
          editionType?.success ? editionType.data : undefined,
        );
        return briefing
          ? json(briefing)
          : json({ error: "brief_not_found", message: "No Daily Briefing is available." }, 404);
      } catch {
        return json({ error: "brief_store_unavailable" }, 503);
      }
    }
    const briefingMatch = pathname.match(/^\/api\/briefs\/([^/]+)\/([^/]+)$/);
    if (briefingMatch) {
      const editionDate = briefingMatch[1]!;
      const editionTypeResult = briefingEditionTypeSchema.safeParse(briefingMatch[2]);
      const dateResult = briefingCalendarDateSchema.safeParse(editionDate);
      if (!dateResult.success || !editionTypeResult.success) {
        return json({ error: "invalid_briefing_identifier" }, 400);
      }
      try {
        const briefing = await readBriefingByDateAndType(env.DB, editionDate, editionTypeResult.data);
        return briefing
          ? json(briefing)
          : json({ error: "brief_not_found", message: "No Daily Briefing is available." }, 404);
      } catch {
        return json({ error: "brief_store_unavailable" }, 503);
      }
    }
    if (pathname === "/api/x/posts") {
      try {
        const params = new URL(request.url).searchParams;
        const author = params.get("author") ?? undefined;
        const symbol = params.get("symbol") ?? undefined;
        const rawLimit = Number.parseInt(params.get("limit") ?? "50", 10);
        const posts = await readXPosts(env.DB, {
          author,
          symbol: symbol?.toUpperCase(),
          limit: Number.isFinite(rawLimit) ? rawLimit : 50,
        });
        return json({ posts, count: posts.length });
      } catch (err) {
        console.error("x posts error", err);
        return json({ error: "x_store_unavailable" }, 503);
      }
    }
    if (pathname === "/api/market-data") {
      try {
        return json((await buildDashboard(env)).marketData);
      } catch (err) {
        console.error("market data error", err);
        return json(emptyMarketData);
      }
    }
    if (pathname === "/api/market-context") {
      return json(await readMarketContext(env.DB));
    }
    const stockMatch = pathname.match(/^\/api\/stocks\/([A-Za-z0-9.-]+)$/);
    if (stockMatch) {
      const symbol = stockMatch[1]?.toUpperCase();
      if (!symbol) return json({ error: "Not found" }, 404);
      try {
        const payload = await buildDashboard(env);
        const stock = payload.candidates.find((c) => c.symbol === symbol);
        if (!stock) return json({ error: "Not found" }, 404);
        return json({
          symbol: stock.symbol,
          company: stock.company,
          sector: stock.sector,
          marketCap: stock.marketCap,
          price: stock.price,
          quantScore: stock.quantScore,
          strategyId: stock.strategyId,
          strategyVersion: stock.strategyVersion,
          strategy: stock.strategy,
          status: stock.status,
          direction: stock.direction,
          earningsDate: stock.earningsDate,
          earningsProximityDays: stock.earningsProximityDays,
          reasons: stock.reasons,
        });
      } catch {
        return json({ error: "Internal error" }, 500);
      }
    }
    if (pathname === "/api/earnings") {
      try {
        return json(await readEarningsApi(env, new URL(request.url).searchParams));
      } catch (error) {
        console.error("earnings api error", error);
        return error instanceof EarningsQueryError
          ? json({ error: "invalid_earnings_query" }, 400)
          : json({ error: "earnings_store_unavailable" }, 503);
      }
    }
    if (pathname === "/api/portfolio/shadow") {
      try {
        const payload = await buildDashboard(env);
        return json({ portfolio: payload.portfolio, positions: payload.positions });
      } catch {
        return json({ error: "Internal error" }, 500);
      }
    }
    if (pathname === "/api/strategies") {
      try {
        const payload = await buildDashboard(env);
        return json(payload.strategies);
      } catch {
        return json({ error: "Internal error" }, 500);
      }
    }

    if (pathname.startsWith("/api/")) return json({ error: "Not found" }, 404);
    return env.ASSETS.fetch(request);
  },
};
