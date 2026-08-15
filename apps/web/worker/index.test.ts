import { describe, expect, it, vi } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import worker, { type Env } from "./index";
import { buildDashboard, buildMarketContextHealth, downCriticalSources, unavailableSources } from "./dashboard";
import { readMarketContext, readMarketContextHealthStrict, type MarketContextHealthRecord, type MarketContextReadModel } from "./market-context";
import type { DashboardData, EarningsEngineState, MarketDataSnapshot, PublicSourceHealth, SourceHealth, StrategySummary } from "@stock-autotrader/contracts";

// readMarketContext() and readMarketContextHealthStrict() are wrapped so
// individual tests can force the critical market reads to reject (the
// /healthz/sources read_model_unavailable path) without disturbing every
// other test: the default implementation is the real one.
vi.mock("./market-context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./market-context")>();
  return {
    ...actual,
    readMarketContext: vi.fn(actual.readMarketContext),
    readMarketContextHealthStrict: vi.fn(actual.readMarketContextHealthStrict),
  };
});

type StatusBody = DashboardData & {
  market: { indices: unknown[] };
  briefing: { available: boolean; freshness: string };
  sources: PublicSourceHealth;
  sentiment: unknown;
};
type StockBody = { symbol: string; strategy: string; direction: string };
type PortfolioBody = { portfolio: DashboardData["portfolio"]; positions: DashboardData["positions"] };

/**
 * A minimal, table-aware D1 fake. Each table is seeded independently; any
 * query this file doesn't care about (daily_briefings, x_posts,
 * earnings_events, market_indices, market_sentiment, ...) defaults to an
 * empty/absent result rather than throwing, so tests only need to set up
 * the tables their assertions actually touch.
 */
interface Tables {
  appMeta: Record<string, string>;
  scan: Record<string, unknown> | null;
  strategies: Record<string, unknown>[];
  scanCandidates: Record<string, unknown>[];
  decisionReasons: Record<string, unknown>[];
  earnings: Record<string, unknown>[];
  universe: Record<string, unknown>[];
  shadowPositions: Record<string, unknown>[];
  botEvents: Record<string, unknown>[];
  research: Record<string, unknown>[];
  marketIndices: Record<string, unknown>[];
  earningsEngine: Record<string, unknown> | null;
}

type ThrowOn = Partial<Record<"appMeta" | "dailyBriefings" | "scanCandidates" | "marketData" | "marketIndices", boolean>>;

function createDb(tables: Partial<Tables> = {}, throwOn: ThrowOn = {}) {
  const t: Tables = {
    appMeta: {},
    scan: null,
    strategies: [],
    scanCandidates: [],
    decisionReasons: [],
    earnings: [],
    universe: [],
    shadowPositions: [],
    botEvents: [],
    research: [],
    marketIndices: [],
    earningsEngine: null,
    ...tables,
  };
  return {
    prepare(sql: string) {
      let args: unknown[] = [];
      return {
        bind(...values: unknown[]) {
          args = values;
          return this;
        },
        async first<T>(): Promise<T | null> {
          if (sql === "SELECT * FROM scans ORDER BY id DESC LIMIT 1") return (t.scan as T | null) ?? null;
          if (sql.includes("FROM daily_briefings")) {
            if (throwOn.dailyBriefings) throw new Error("daily_briefings unavailable");
            return null;
          }
          // readCandidateBySymbol's scoped lookup (WHERE scan_id = ... AND symbol = ?).
          if (sql.includes("FROM scan_candidates") && sql.includes("WHERE c.scan_id")) {
            if (throwOn.scanCandidates) throw new Error("scan_candidates unavailable");
            const symbol = args[0];
            return (t.scanCandidates.find((row) => row.symbol === symbol && isActiveUniverseSymbol(t, String(row.symbol))) as T | undefined) ?? null;
          }
          if (sql === "SELECT value FROM app_meta WHERE key = 'marketData'") {
            if (throwOn.marketData) throw new Error("marketData unavailable");
            const value = t.appMeta.marketData;
            return (value === undefined ? null : ({ value } as T));
          }
          // readMarketContextHealth / deployment-bootstrap nonce lookups
          // (and the earnings engine metadata read below) go through the
          // parameterized app_meta form.
          if (sql === "SELECT value FROM app_meta WHERE key = ? LIMIT 1") {
            const value = t.appMeta[String(args[0])];
            return (value === undefined ? null : ({ value } as T));
          }
          if (sql.includes("earningsEngineUpdatedAt")) {
            return (t.earningsEngine as T | null) ?? null;
          }
          return null;
        },
        async all<T>(): Promise<{ results: T[] }> {
          if (sql === "SELECT key, value FROM app_meta") {
            if (throwOn.appMeta) throw new Error("app_meta unavailable");
            return { results: Object.entries(t.appMeta).map(([key, value]) => ({ key, value })) as T[] };
          }
          if (sql === "SELECT * FROM scans ORDER BY id DESC LIMIT 1") {
            return { results: (t.scan ? [t.scan] : []) as T[] };
          }
          if (sql.startsWith("SELECT key, value FROM app_meta WHERE key IN")) {
            const keys = new Set(args.map(String));
            return { results: Object.entries(t.appMeta).filter(([key]) => keys.has(key)).map(([key, value]) => ({ key, value })) as T[] };
          }
          if (sql.startsWith("SELECT * FROM decision_reasons")) {
            const ids = new Set(args.map((value) => Number(value)));
            return { results: t.decisionReasons.filter((row) => ids.has(Number(row.candidate_id))) as T[] };
          }
          if (sql.includes("FROM scan_candidates")) return { results: t.scanCandidates.filter((row) => isActiveUniverseSymbol(t, String(row.symbol))) as T[] };
          if (sql.startsWith("SELECT * FROM strategies")) return { results: t.strategies as T[] };
          if (sql.includes("FROM earnings AS e")) return { results: t.earnings.filter((row) => isActiveUniverseSymbol(t, String(row.symbol))) as T[] };
          if (sql.includes("FROM shadow_positions")) return { results: t.shadowPositions.filter((row) => isActiveUniverseSymbol(t, String(row.symbol))) as T[] };
          if (sql.includes("FROM bot_events")) return { results: t.botEvents.filter((row) => row.symbol == null || isActiveUniverseSymbol(t, String(row.symbol))) as T[] };
          if (sql.startsWith("SELECT * FROM research")) return { results: t.research as T[] };
          // readMarketContext() de-dupes to the latest row per symbol via a
          // NOT EXISTS subquery; fixtures only ever seed one row per symbol,
          // so the raw rows are returned as-is.
          if (sql.includes("FROM market_indices")) {
            if (throwOn.marketIndices) throw new Error("market_indices unavailable");
            return { results: t.marketIndices as T[] };
          }
          return { results: [] as T[] };
        },
      };
    },
    // Mirrors D1's batch(): each statement resolves as it would via .all(),
    // and a failure on any one rejects the whole batch (matches D1).
    async batch<T>(statements: { all<U>(): Promise<{ results: U[] }> }[]): Promise<{ results: T[] }[]> {
      return Promise.all(statements.map((statement) => statement.all())) as Promise<{ results: T[] }[]>;
    },
  };
}

function isActiveUniverseSymbol(t: Tables, symbol: string): boolean {
  const row = t.universe.find((candidate) => String(candidate.symbol) === symbol);
  return Boolean(row && Number(row.active) === 1 && row.source === "core");
}

const assets = { fetch: async () => new Response("assets") };

function envWith(tables: Partial<Tables>, throwOn: ThrowOn = {}): Env {
  return { DB: createDb(tables, throwOn) as unknown as D1Database, ASSETS: assets } as unknown as Env;
}

const validRiskPolicy = JSON.stringify({
  riskPerTradePct: 1,
  maxPositions: 5,
  maxOpenRiskPct: 5,
  maxSinglePositionPct: 10,
  maxSectorExposurePct: 20,
  maxGrossExposurePct: 50,
  leverage: "1x",
  averagingDown: false,
  martingale: false,
});

function healthyTables(): Partial<Tables> {
  return {
    // Published account metadata for the one active position. Mixed-universe
    // tests replace these with a broader runtime snapshot below.
    appMeta: {
      initialCapital: "10000",
      equity: "10000",
      returnPct: "0",
      cash: "8715",
      invested: "1285",
      openPositions: "1",
      openRiskPct: "0.8",
      grossExposurePct: "12.85",
      riskPolicy: validRiskPolicy,
    },
    scan: {
      id: 7,
      scanned_at: "2026-08-13T11:00:00Z",
      universe: 500,
      passed_filters: 40,
      candidates: 1,
      setups: 1,
      watch: 0,
    },
    strategies: [
      {
        id: "trend-breakout",
        name: "Trend Breakout",
        version: "1.2",
        status: "Shadow",
        description: "Momentum continuation",
        universe: "S&P 500",
        typical_holding_period: "5-10 days",
        signals_today: 3,
        open_shadow_positions: 1,
        metadata: "{}",
      },
    ],
    scanCandidates: [
      {
        id: 42,
        symbol: "NVDA",
        company: "NVIDIA Corp",
        sector: "Technology",
        market_cap: 3_000_000_000_000,
        price: 128.5,
        quant_score: 88,
        strategy_id: "trend-breakout",
        strategy: "Trend Breakout",
        strategy_version: "1.2",
        trend: "Strong",
        momentum: 1.4,
        relative_strength: 1.2,
        relative_volume: 2.1,
        breakout: "20-day high",
        earnings_date: "2026-08-20",
        earnings_proximity_days: 7,
        status: "Strong Setup",
        direction: "Bullish",
        risk_flags: JSON.stringify(["earnings-window"]),
        updated_at: "2026-08-13T11:00:00Z",
      },
    ],
    decisionReasons: [
      {
        candidate_id: 42,
        reason_code: "TREND_STRONG",
        reason_label: "Strong uptrend",
        outcome: "pass",
        observed: "ADX 32",
        threshold: "ADX 25",
      },
    ],
    earnings: [
      {
        symbol: "NVDA",
        company: "NVIDIA Corp",
        date: "2026-08-20",
        timing: "AMC",
        event_signal: "Confirmed",
        engine_relevant: 1,
        signal: "Strong Setup",
        strategy: "Trend Breakout",
        has_position: 0,
        tracked: 1,
        updated_at: "2026-08-13T09:00:00Z",
      },
    ],
    universe: [
      { symbol: "AMD", active: 1, source: "core" },
      { symbol: "NVDA", active: 1, source: "core" },
    ],
    shadowPositions: [
      {
        symbol: "NVDA",
        strategy: "Trend Breakout",
        entry_price: 120,
        current_price: 128.5,
        stop_price: 112,
        quantity: 10,
        risk_amount: 80,
        unrealized_pnl: 85,
        return_pct: 7.08,
        r_multiple: 1.06,
        opened_at: "2026-08-11T14:30:00Z",
      },
    ],
    botEvents: [
      {
        event_id: "evt-1",
        event_type: "SIGNAL_SURFACED",
        message: "NVDA signal surfaced",
        severity: "success",
        symbol: "NVDA",
        strategy_id: "trend-breakout",
        created_at: "2026-08-13T11:00:00Z",
      },
    ],
    research: [
      {
        id: "res-1",
        strategy_id: "trend-breakout",
        strategy: "Trend Breakout",
        stage: "Shadow",
        period: "2026 Q3",
        status: "Complete",
        metrics: JSON.stringify({ sharpe: 1.4 }),
      },
    ],
  };
}

/**
 * /healthz/sources fixtures. All fixed instants are on/around Thursday
 * 2026-08-13 (a plain trading day, no holiday/early close; NY session
 * 13:30-20:00 UTC), reused from buildMarketContextHealth's fixtures, so the
 * freshness semantics are deterministic regardless of when the suite runs.
 */
const marketIndexRows = (sourceTimestamp: string) =>
  (["SPX", "NDX", "DJI", "VIX"] as const).map((symbol) => ({
    symbol,
    name: symbol,
    value: 100,
    change_pct: 0.1,
    source_timestamp: sourceTimestamp,
    collected_at: new Date(Date.parse(sourceTimestamp) + 60_000).toISOString(),
    provider: "yahoo-finance-chart",
  }));

const healthyEarningsEngine = () => ({
  updated_at: "2026-08-13T17:50:00.000Z",
  checked_at: "2026-08-13T17:50:00.000Z",
  attempt_at: null,
  calendar_error: null,
  monitor_error: null,
  last_error: null,
  universe_count: 1,
});

/** The canonical Market Context health record the runtime writes after a failed run. */
const degradedMarketContextHealth = () => JSON.stringify({
  provider: "yahoo-finance-chart",
  status: "degraded",
  lastAttemptAt: "2026-08-13T17:59:00.000Z",
  lastSuccessfulUpdate: "2026-08-13T15:01:00.000Z",
  lastError: "SPX: provider HTTP 429",
  httpStatuses: [429],
  rowsWritten: 0,
  lastKnownGoodPreserved: true,
});

/** The canonical Market Context health record a healthy runtime writes on every run. */
const healthyMarketContextHealth = () => JSON.stringify({
  provider: "yahoo-finance-chart",
  status: "ok",
  lastAttemptAt: "2026-08-13T17:59:00.000Z",
  lastSuccessfulUpdate: "2026-08-13T17:59:00.000Z",
  lastError: null,
  httpStatuses: [],
  rowsWritten: 0,
  lastKnownGoodPreserved: false,
});

describe("buildDashboard()", () => {
  it("maps every table into the validated dashboard shape", async () => {
    const env = envWith(healthyTables());
    const body = await buildDashboard(env);

    expect(body.demo).toBe(false);
    expect(body.status).toMatchObject({ engine: "online", apiHealth: "healthy", latestScan: "2026-08-13T11:00:00Z" });
    expect(body.scan).toMatchObject({ universe: 500, passedFilters: 40, candidates: 1, setups: 1, watch: 0 });

    expect(body.strategies).toHaveLength(1);
    expect(body.strategies[0]).toMatchObject({ id: "trend-breakout", state: "Shadow", enabled: true, signalsToday: 3 });

    expect(body.candidates).toHaveLength(1);
    expect(body.candidates[0]).toMatchObject({
      symbol: "NVDA",
      direction: "Bullish",
      riskFlags: ["earnings-window"],
    });
    expect(body.candidates[0]!.reasons).toEqual([
      { id: "TREND_STRONG", outcome: "pass", code: "TREND_STRONG", label: "Strong uptrend", observed: "ADX 32", threshold: "ADX 25" },
    ]);

    expect(body.earnings).toEqual([
      {
        symbol: "NVDA",
        company: "NVIDIA Corp",
        date: "2026-08-20",
        timing: "AMC",
        eventSignal: "Confirmed",
        engineRelevant: true,
        signal: "Strong Setup",
        strategy: "Trend Breakout",
        hasPosition: false,
        tracked: true,
        updatedAt: "2026-08-13T09:00:00Z",
      },
    ]);

    expect(body.positions).toHaveLength(1);
    expect(body.positions[0]).toMatchObject({ symbol: "NVDA", quantity: 10, rMultiple: 1.06 });
    expect(body.portfolio).toMatchObject({
      equity: 10000,
      cash: 8715,
      invested: 1285,
      openPositions: 1,
    });
    expect(body.portfolio.openRiskPct).toBeCloseTo(0.8);
    expect(body.portfolio.grossExposurePct).toBeCloseTo(12.85);

    expect(body.events).toHaveLength(1);
    expect(body.events[0]).toMatchObject({ id: "evt-1", severity: "success", symbol: "NVDA" });

    expect(body.research).toHaveLength(1);
    expect(body.research[0]).toMatchObject({ id: "res-1", metrics: { sharpe: 1.4 } });

    // No marketData/lastDataUpdate published -> conservative offline defaults, not fabricated health.
    expect(body.marketData.status).toBe("offline");
    expect(body.status.lastDataUpdate).toBeNull();
  });

  it("fetches its base tables in a single D1 batch round trip, not eight separate ones", async () => {
    const env = envWith(healthyTables());
    const batchSpy = vi.spyOn(env.DB, "batch");
    const prepareSpy = vi.spyOn(env.DB, "prepare");
    await buildDashboard(env);

    expect(batchSpy).toHaveBeenCalledTimes(1);
    expect(batchSpy.mock.calls[0]![0]).toHaveLength(8);
    // 8 statements built for the batch, plus one more for this fixture's
    // single candidate's decision_reasons lookup (necessarily separate: it
    // depends on the batch's own scan_candidates result).
    expect(prepareSpy).toHaveBeenCalledTimes(9);
  });

  it("groups decision reasons per candidate and never leaks another candidate's reasons", async () => {
    const tables = healthyTables();
    tables.scanCandidates = [
      ...(tables.scanCandidates ?? []),
      { ...tables.scanCandidates![0], id: 43, symbol: "AMD", updated_at: "2026-08-13T11:00:00Z" },
    ];
    tables.decisionReasons = [
      ...(tables.decisionReasons ?? []),
      { candidate_id: 43, reason_code: "RVOL_LOW", reason_label: "Below average volume", outcome: "reject" },
    ];
    const env = envWith(tables);
    const body = await buildDashboard(env);

    const nvda = body.candidates.find((c) => c.symbol === "NVDA")!;
    const amd = body.candidates.find((c) => c.symbol === "AMD")!;
    expect(nvda.reasons.map((r) => r.code)).toEqual(["TREND_STRONG"]);
    expect(amd.reasons.map((r) => r.code)).toEqual(["RVOL_LOW"]);
  });

  it("marks the engine delayed and API degraded when lastDataUpdate is stale", async () => {
    const tables = healthyTables();
    tables.appMeta = { ...tables.appMeta, lastDataUpdate: "2020-01-01T00:00:00Z" };
    const env = envWith(tables);
    const body = await buildDashboard(env);
    expect(body.status.engine).toBe("delayed");
    expect(body.status.apiHealth).toBe("degraded");
  });

  it("fetches its base tables in a single D1 batch round trip, not eight separate ones", async () => {
    const env = envWith(healthyTables());
    const batchSpy = vi.spyOn(env.DB, "batch");
    const prepareSpy = vi.spyOn(env.DB, "prepare");
    await buildDashboard(env);

    expect(batchSpy).toHaveBeenCalledTimes(1);
    expect(batchSpy.mock.calls[0]![0]).toHaveLength(8);
    // 8 statements built for the batch, plus one more for this fixture's
    // single candidate's decision_reasons lookup (necessarily separate: it
    // depends on the batch's own scan_candidates result).
    expect(prepareSpy).toHaveBeenCalledTimes(9);
  });

  it("marks the engine delayed when the latest scan timestamp is malformed", async () => {
    const tables = healthyTables();
    tables.scan = { ...tables.scan!, scanned_at: "not-a-timestamp" };
    const env = envWith(tables);
    const body = await buildDashboard(env);
    expect(body.status.engine).toBe("delayed");
    expect(body.status.apiHealth).toBe("degraded");
  });

  it("degrades a healthy market snapshot that has gone stale instead of presenting it live", async () => {
    const tables = healthyTables();
    tables.appMeta = {
      ...tables.appMeta,
      marketData: JSON.stringify({
        provider: "csv",
        status: "healthy",
        asOf: "2020-01-01",
        lastSuccessfulUpdate: "2020-01-01T00:00:00Z",
        universe: { total: 1, eligible: 1, excluded: 0 },
        benchmarks: [
          { symbol: "SPY", date: "2020-01-01", open: 1, high: 1, low: 1, close: 1, adjustedClose: 1, volume: 1 },
          { symbol: "QQQ", date: "2020-01-01", open: 1, high: 1, low: 1, close: 1, adjustedClose: 1, volume: 1 },
        ],
        warnings: [],
        updatedAt: "2020-01-01T00:00:00Z",
      }),
    };
    const env = envWith(tables);
    const body = await buildDashboard(env);
    expect(body.marketData.status).toBe("degraded");
    expect(body.marketData.warnings.some((w) => w.includes("stale"))).toBe(true);
  });

  it("falls back to the empty dashboard, not a schema-invalid payload, when a row violates the contract", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const tables = healthyTables();
    // "Sideways" is not a valid trend enum value: the whole read model must
    // fail closed to the empty dashboard rather than serve a broken shape.
    tables.scanCandidates = [{ ...tables.scanCandidates![0], trend: "Sideways" }];
    const env = envWith(tables);
    const body = await buildDashboard(env);
    expect(body.candidates).toEqual([]);
    expect(body.status.engine).toBe("offline");
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("propagates a store error rather than swallowing it — /api/status's retry logic depends on this", async () => {
    const env = envWith({}, { appMeta: true });
    await expect(buildDashboard(env)).rejects.toThrow("app_meta unavailable");
  });
});

describe("narrow endpoints derived from the dashboard read model", () => {
  it("GET /api/stocks/:symbol returns the matching candidate, case-insensitively", async () => {
    const env = envWith(healthyTables());
    const response = await worker.fetch(new Request("https://example.test/api/stocks/nvda"), env);
    expect(response.status).toBe(200);
    const body = (await response.json()) as StockBody;
    expect(body).toMatchObject({ symbol: "NVDA", strategy: "Trend Breakout", direction: "Bullish" });
  });

  it("GET /api/stocks/:symbol 404s for a symbol not in the latest scan", async () => {
    const env = envWith(healthyTables());
    const response = await worker.fetch(new Request("https://example.test/api/stocks/ZZZZ"), env);
    expect(response.status).toBe(404);
  });

  it("does not surface an inactive universe member on status or stock lookup reads", async () => {
    const tables = healthyTables();
    tables.universe = [
      ...(tables.universe ?? []),
      { symbol: "ABNB", active: 0, source: "core" },
    ];
    tables.scanCandidates = [
      ...(tables.scanCandidates ?? []),
      { ...tables.scanCandidates![0], id: 43, symbol: "ABNB" },
    ];
    tables.earnings = [
      ...(tables.earnings ?? []),
      { ...tables.earnings![0], symbol: "ABNB" },
    ];
    tables.shadowPositions = [
      ...(tables.shadowPositions ?? []),
      { ...tables.shadowPositions![0], id: 43, symbol: "ABNB", current_price: 999, quantity: 100, risk_amount: 5000 },
    ];
    // The unfiltered runtime snapshot includes the hidden ABNB position:
    // total equity = $11,000, real cash = $4,000, total invested = $7,000.
    // Public active-universe totals must retain $4,000 cash and exclude only
    // ABNB's invested value/risk/count.
    tables.appMeta = {
      ...tables.appMeta,
      equity: "11000",
      cash: "4000",
      invested: "7000",
      openPositions: "2",
      openRiskPct: "54.55",
      grossExposurePct: "63.64",
      returnPct: "10",
    };
    tables.botEvents = [
      ...(tables.botEvents ?? []),
      { ...tables.botEvents![0], event_id: "evt-abnb", symbol: "ABNB" },
    ];
    const env = envWith(tables);
    const statusResponse = await worker.fetch(new Request("https://example.test/api/status"), env);
    expect(statusResponse.status).toBe(200);
    const dashboard = (await statusResponse.json()) as StatusBody;
    expect(dashboard.candidates.some((candidate) => candidate.symbol === "ABNB")).toBe(false);
    expect(dashboard.earnings.some((event) => event.symbol === "ABNB")).toBe(false);
    expect(dashboard.positions.some((position) => position.symbol === "ABNB")).toBe(false);
    expect(dashboard.events.some((event) => event.symbol === "ABNB")).toBe(false);
    expect(dashboard.portfolio).toMatchObject({
      cash: 4000,
      equity: 5285,
      invested: 1285,
      openPositions: 1,
    });
    expect(dashboard.portfolio.returnPct).toBeCloseTo(-47.15);
    expect(dashboard.portfolio.openRiskPct).toBeCloseTo((80 / 5285) * 100);
    expect(dashboard.portfolio.grossExposurePct).toBeCloseTo((1285 / 5285) * 100);
    const portfolio = (await (await worker.fetch(new Request("https://example.test/api/portfolio/shadow"), env)).json()) as PortfolioBody;
    expect(portfolio.positions.some((position) => (position as { symbol?: string }).symbol === "ABNB")).toBe(false);
    expect(portfolio.portfolio).toEqual(dashboard.portfolio);
    expect(portfolio.portfolio).toMatchObject({
      cash: 4000,
      equity: 5285,
      invested: 1285,
      openPositions: 1,
    });
    expect(portfolio.portfolio.returnPct).toBeCloseTo(-47.15);
    expect(portfolio.portfolio.openRiskPct).toBeCloseTo((80 / 5285) * 100);
    expect(portfolio.portfolio.grossExposurePct).toBeCloseTo((1285 / 5285) * 100);
    expect((tables.shadowPositions ?? []).some((position) => position.symbol === "ABNB")).toBe(true);
    expect((await worker.fetch(new Request("https://example.test/api/stocks/abnb"), env)).status).toBe(404);
  });

  it("excludes an inactive stored position from public portfolio totals", async () => {
    const tables = healthyTables();
    tables.universe = [{ symbol: "ABNB", active: 0, source: "core" }];
    tables.shadowPositions = [{
      ...tables.shadowPositions![0],
      symbol: "ABNB",
      current_price: 999,
      quantity: 100,
      risk_amount: 5000,
    }];
    const env = envWith(tables);
    const response = await worker.fetch(new Request("https://example.test/api/portfolio/shadow"), env);
    expect(response.status).toBe(200);
    const body = (await response.json()) as PortfolioBody;

    expect((tables.shadowPositions ?? []).some((position) => position.symbol === "ABNB")).toBe(true);
    expect(body.positions).toEqual([]);
    expect(body.portfolio).toMatchObject({ cash: 8715, equity: 8715, invested: 0, openPositions: 0, openRiskPct: 0, grossExposurePct: 0 });
  });

  it("recomputes scan counts from active-universe candidates", async () => {
    const tables = healthyTables();
    tables.universe = [
      ...(tables.universe ?? []),
      { symbol: "ABNB", active: 0, source: "core" },
    ];
    tables.scanCandidates = [
      ...(tables.scanCandidates ?? []),
      { ...tables.scanCandidates![0], id: 43, symbol: "AMD", status: "Watch" },
      { ...tables.scanCandidates![0], id: 44, symbol: "ABNB", status: "Strong Setup" },
    ];
    tables.scan = {
      ...tables.scan!,
      candidates: 3,
      setups: 2,
      watch: 1,
    };
    const env = envWith(tables);
    const response = await worker.fetch(new Request("https://example.test/api/status"), env);
    expect(response.status).toBe(200);
    const body = (await response.json()) as StatusBody;

    expect(body.candidates.map((candidate) => candidate.symbol)).toEqual(["NVDA", "AMD"]);
    expect(body.scan).toMatchObject({ universe: 500, passedFilters: 40, candidates: 2, setups: 1, watch: 1 });
  });

  it("GET /api/stocks/:symbol fails closed on a store error", async () => {
    const env = envWith({}, { scanCandidates: true });
    const response = await worker.fetch(new Request("https://example.test/api/stocks/NVDA"), env);
    expect(response.status).toBe(500);
  });

  it("GET /api/portfolio/shadow returns portfolio + positions only, from the scoped app_meta keys", async () => {
    const env = envWith(healthyTables());
    const response = await worker.fetch(new Request("https://example.test/api/portfolio/shadow"), env);
    expect(response.status).toBe(200);
    const body = (await response.json()) as PortfolioBody;
    expect(Object.keys(body).sort()).toEqual(["portfolio", "positions"]);
    expect(body.portfolio.riskPolicy).toMatchObject({ maxPositions: 5, leverage: "1x" });
    expect(body.positions).toHaveLength(1);
  });

  it("GET /api/strategies returns the strategy list only", async () => {
    const env = envWith(healthyTables());
    const response = await worker.fetch(new Request("https://example.test/api/strategies"), env);
    expect(response.status).toBe(200);
    const body = (await response.json()) as StrategySummary[];
    expect(body).toHaveLength(1);
    expect(body[0]!.id).toBe("trend-breakout");
  });

  it("GET /api/market-data returns the empty snapshot, not an error, on a store failure", async () => {
    const env = envWith({}, { marketData: true });
    const response = await worker.fetch(new Request("https://example.test/api/market-data"), env);
    expect(response.status).toBe(200);
    const body = (await response.json()) as MarketDataSnapshot;
    expect(body.status).toBe("offline");
  });

  it("GET /api/market-data returns the offline default when no snapshot has ever been published", async () => {
    const env = envWith({});
    const response = await worker.fetch(new Request("https://example.test/api/market-data"), env);
    expect(response.status).toBe(200);
    const body = (await response.json()) as MarketDataSnapshot;
    expect(body.status).toBe("offline");
  });
});

describe("/api/status", () => {
  it("composes dashboard, briefing and market context into one contract-shaped response", async () => {
    const env = envWith(healthyTables());
    const response = await worker.fetch(new Request("https://example.test/api/status"), env);
    expect(response.status).toBe(200);
    const body = (await response.json()) as StatusBody;
    expect(body.candidates).toHaveLength(1);
    expect(body.briefing).toMatchObject({ available: false, freshness: "unavailable" });
    expect(Object.keys(body.sources).sort()).toEqual(
      ["briefing", "earnings", "market", "opportunities", "quickStats", "sentiment", "x"].sort(),
    );
    expect(body.market).toHaveProperty("indices");
  });

  it("keeps the public contract shape and fails every source closed when part of the read model errors", async () => {
    const env = envWith(healthyTables(), { dailyBriefings: true });
    const response = await worker.fetch(new Request("https://example.test/api/status"), env);
    expect(response.status).toBe(200);
    const body = (await response.json()) as StatusBody;
    // buildDashboard itself still succeeded on retry, so candidates survive;
    // only the fields the failing source touches are forced Unavailable.
    expect(body.candidates).toHaveLength(1);
    expect(body.briefing).toMatchObject({ available: false, freshness: "unavailable" });
    expect(Object.values(body.sources).every((source) => source.state === "Error")).toBe(true);
    expect(body.sentiment).toBeNull();
  });

  it("returns 500 only when the dashboard read model is unavailable on both attempts", async () => {
    const env = envWith({}, { appMeta: true, dailyBriefings: true });
    const response = await worker.fetch(new Request("https://example.test/api/status"), env);
    expect(response.status).toBe(500);
  });
});

describe("routing", () => {
  it("GET /healthz reports ok without touching the store", async () => {
    const env = envWith({}, { appMeta: true });
    const response = await worker.fetch(new Request("https://example.test/healthz"), env);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { ok: boolean }).ok).toBe(true);
  });

  it("rejects a non-GET/HEAD/OPTIONS method on an API route with 405", async () => {
    const env = envWith(healthyTables());
    const response = await worker.fetch(new Request("https://example.test/api/status", { method: "POST" }), env);
    expect(response.status).toBe(405);
  });

  it("404s an unknown /api/* path instead of falling through to assets", async () => {
    const env = envWith(healthyTables());
    const response = await worker.fetch(new Request("https://example.test/api/does-not-exist"), env);
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: string }).error).toBe("Not found");
  });

  it("falls through to Workers Assets for a non-API path", async () => {
    const seen: string[] = [];
    const env = {
      DB: createDb() as unknown as D1Database,
      ASSETS: { fetch: async (request: Request) => { seen.push(new URL(request.url).pathname); return new Response("assets"); } },
    } as unknown as Env;
    const response = await worker.fetch(new Request("https://example.test/dashboard"), env);
    expect(await response.text()).toBe("assets");
    expect(seen).toEqual(["/dashboard"]);
  });

  it("routes POST /ingest/events before the GET-only method gate", async () => {
    // No INGEST_SECRET configured: reaching handleIngest (503), not the
    // generic 405, proves /ingest/events is dispatched ahead of the gate.
    const env = envWith({});
    const response = await worker.fetch(
      new Request("https://example.test/ingest/events", { method: "POST", body: "{}" }),
      env,
    );
    expect(response.status).toBe(503);
  });

  it("rejects the deployment bootstrap mutation without its one-time nonce", async () => {
    const env = envWith({});
    env.ENVIRONMENT = "production";
    const response = await worker.fetch(
      new Request("https://example.test/__internal/deployment/bootstrap", { method: "POST" }),
      env,
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
  });
});

describe("GET /healthz/sources", () => {
  // Mid-regular-session Thursday 2026-08-13 14:00 ET (18:00 UTC): the
  // freshness windows in the fixtures below are deterministic here.
  const NOW = "2026-08-13T18:00:00.000Z";
  // Saturday 2026-08-15 08:00 ET (12:00 UTC): market closed since Friday's
  // 16:00 ET close; the daily earnings sync has run (06:00 UTC).
  const WEEKEND = "2026-08-15T12:00:00.000Z";

  const healthyCriticalTables = () => ({
    ...healthyTables(),
    // 15 minutes before NOW: a healthy runtime collects every 15 minutes.
    marketIndices: marketIndexRows("2026-08-13T17:45:00.000Z"),
    earningsEngine: healthyEarningsEngine(),
    appMeta: { ...healthyTables().appMeta, marketContextHealth: healthyMarketContextHealth() },
  });

  const withSystemTime = async (iso: string, run: () => Promise<void>): Promise<void> => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(iso));
      await run();
    } finally {
      vi.useRealTimers();
    }
  };

  it("reports 503, names the down sources and never caches when market and earnings have never published", async () => {
    // healthyTables() seeds the dashboard tables but never market_indices,
    // market_sentiment or the earnings-engine app_meta keys, so both critical
    // sources are naturally down — the same shape as the production incident
    // this endpoint exists to catch.
    const env = envWith(healthyTables());
    const response = await worker.fetch(new Request("https://example.test/healthz/sources"), env);
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as { ok: boolean; critical: string[]; down: string[]; sources: Record<string, { state: string }> };
    expect(body.ok).toBe(false);
    expect(body.critical).toEqual(["market", "earnings"]);
    expect(body.down.sort()).toEqual(["earnings", "market"]);
    expect(body.sources.market?.state).toBe("Error");
  });

  it("reports 200 when market and earnings are healthy", async () => {
    await withSystemTime(NOW, async () => {
      const env = envWith(healthyCriticalTables());
      const response = await worker.fetch(new Request("https://example.test/healthz/sources"), env);
      const body = (await response.json()) as { ok: boolean; down: string[]; sources: Record<string, { state: string }> };
      expect(body.sources.market?.state).toBe("Live");
      expect(body.sources.earnings?.state).toBe("Live");
      expect(body.down).toEqual([]);
      expect(body.ok).toBe(true);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
    });
  });

  it("is NOT down overnight/weekend — a complete prior-session market set is a closed market, not an outage", async () => {
    await withSystemTime(WEEKEND, async () => {
      const env = envWith({
        ...healthyTables(),
        // Friday's complete closing set; no collection has run since.
        marketIndices: marketIndexRows("2026-08-14T20:00:00.000Z"),
        earningsEngine: { ...healthyEarningsEngine(), updated_at: "2026-08-15T06:00:00.000Z", checked_at: "2026-08-15T06:00:00.000Z" },
      });
      const response = await worker.fetch(new Request("https://example.test/healthz/sources"), env);
      const body = (await response.json()) as { ok: boolean; down: string[]; sources: Record<string, { state: string; error: string | null }> };
      // The canonical model's own verdict: Cached with only the prior-session
      // marker — data is intact and no collection failure is recorded.
      expect(body.sources.market?.state).toBe("Cached");
      expect(body.sources.market?.error).toContain("prior session");
      expect(body.down).toEqual([]);
      expect(body.ok).toBe(true);
      expect(response.status).toBe(200);
    });
  });

  it("is down while the market collection is actively failing, even with an intact last-known-good set — an intraday failure does not heal at the close", async () => {
    await withSystemTime(NOW, async () => {
      const env = envWith({
        ...healthyCriticalTables(),
        // The runtime recorded a failed run (degraded + lastError) while the
        // last complete set is still served; the failure must keep paging
        // until a successful run replaces the data.
        appMeta: { ...healthyTables().appMeta, marketContextHealth: degradedMarketContextHealth() },
      });
      const response = await worker.fetch(new Request("https://example.test/healthz/sources"), env);
      const body = (await response.json()) as { ok: boolean; down: string[]; sources: Record<string, { state: string; error: string | null }> };
      expect(body.sources.market?.state).toBe("Cached");
      expect(body.sources.market?.error).toContain("HTTP 429");
      expect(body.down).toEqual(["market"]);
      expect(body.ok).toBe(false);
      expect(response.status).toBe(503);
    });
  });

  it("is down when market collection has stopped entirely — stale data during an open session", async () => {
    await withSystemTime(NOW, async () => {
      // No marketContextHealth record at all and data from yesterday's close:
      // the 15-minute cron has not collected since (a dead scheduler/trigger
      // leaves lastError null forever, which no lastError-based rule can
      // catch). The accumulated regular-session time since the data is far
      // past the 45-minute allowance, so it must page.
      const env = envWith({
        ...healthyTables(),
        marketIndices: marketIndexRows("2026-08-12T20:00:00.000Z"), // yesterday's close
        earningsEngine: healthyEarningsEngine(),
      });
      const response = await worker.fetch(new Request("https://example.test/healthz/sources"), env);
      const body = (await response.json()) as { ok: boolean; down: string[]; sources: Record<string, { state: string }> };
      expect(body.sources.market?.state).toBe("Cached");
      expect(body.down).toEqual(["market"]);
      expect(body.ok).toBe(false);
      expect(response.status).toBe(503);
    });
  });

  it("is down when a required market index is missing from the read model", async () => {
    await withSystemTime(NOW, async () => {
      const env = envWith({
        ...healthyCriticalTables(),
        marketIndices: marketIndexRows("2026-08-13T15:00:00.000Z").slice(0, 3), // VIX absent
      });
      const response = await worker.fetch(new Request("https://example.test/healthz/sources"), env);
      const body = (await response.json()) as { ok: boolean; down: string[] };
      expect(body.down).toEqual(["market"]);
      expect(body.ok).toBe(false);
      expect(response.status).toBe(503);
    });
  });

  it("is down when market timestamps are future-dated — corrupt data is not evidence of freshness", async () => {
    await withSystemTime(NOW, async () => {
      const env = envWith({
        ...healthyCriticalTables(),
        marketIndices: marketIndexRows("2026-08-13T20:00:00.000Z"), // 2h in the future
      });
      const response = await worker.fetch(new Request("https://example.test/healthz/sources"), env);
      const body = (await response.json()) as { ok: boolean; down: string[]; sources: Record<string, { state: string }> };
      // A future-dated success is not valid success evidence (buildSourceHealth
      // requires lastSuccess <= now), and carries no error of its own, so the
      // canonical state is Unavailable — down either way.
      expect(body.sources.market?.state).toBe("Unavailable");
      expect(body.down).toEqual(["market"]);
      expect(response.status).toBe(503);
    });
  });

  it("is down when the earnings engine is stale (missed daily sync)", async () => {
    await withSystemTime(NOW, async () => {
      const env = envWith({
        ...healthyCriticalTables(),
        earningsEngine: { ...healthyEarningsEngine(), updated_at: "2026-08-10T06:00:00.000Z", checked_at: "2026-08-10T06:00:00.000Z" },
      });
      const response = await worker.fetch(new Request("https://example.test/healthz/sources"), env);
      const body = (await response.json()) as { ok: boolean; down: string[]; sources: Record<string, { engineState?: string }> };
      expect(body.sources.earnings?.engineState).toBe("STALE");
      expect(body.down).toEqual(["earnings"]);
      expect(response.status).toBe(503);
    });
  });

  it("is down when the earnings universe is empty — a cached timestamp never makes an invalid universe look healthy", async () => {
    await withSystemTime(NOW, async () => {
      const env = envWith({
        ...healthyCriticalTables(),
        // Fresh timestamp, but the live universe count is zero (wipe).
        earningsEngine: { ...healthyEarningsEngine(), universe_count: 0 },
      });
      const response = await worker.fetch(new Request("https://example.test/healthz/sources"), env);
      const body = (await response.json()) as { ok: boolean; down: string[]; sources: Record<string, { engineState?: string }> };
      expect(body.sources.earnings?.engineState).toBe("UNINITIALIZED");
      expect(body.down).toEqual(["earnings"]);
      expect(response.status).toBe(503);
    });
  });

  it("ignores non-critical sources — a degraded scan engine alone must not page", async () => {
    await withSystemTime(NOW, async () => {
      const env = envWith({
        ...healthyCriticalTables(),
        // The scan engine is a known, long-term stub: its last scan is stale,
        // which must never appear in `down` or change the status code.
        scan: { ...healthyTables().scan!, scanned_at: "2026-08-10T11:00:00Z" },
      });
      const response = await worker.fetch(new Request("https://example.test/healthz/sources"), env);
      const body = (await response.json()) as { ok: boolean; down: string[]; sources: Record<string, { state: string }> };
      expect(body.sources.opportunities?.state).toBe("Stale");
      expect(body.down).not.toContain("opportunities");
      expect(body.ok).toBe(true);
      expect(response.status).toBe(200);
    });
  });

  it("stays 200 when a non-critical dashboard read fails", async () => {
    await withSystemTime(NOW, async () => {
      const env = envWith(healthyCriticalTables(), { appMeta: true });
      const response = await worker.fetch(new Request("https://example.test/healthz/sources"), env);
      const body = (await response.json()) as { ok: boolean; error?: string; down: string[] };
      expect(body.error).toBeUndefined();
      expect(body.down).toEqual([]);
      expect(body.ok).toBe(true);
      expect(response.status).toBe(200);
    });
  });

  it("stays 200 when a non-critical briefing read fails", async () => {
    await withSystemTime(NOW, async () => {
      const env = envWith(healthyCriticalTables(), { dailyBriefings: true });
      const response = await worker.fetch(new Request("https://example.test/healthz/sources"), env);
      const body = (await response.json()) as { ok: boolean; error?: string; down: string[] };
      expect(body.error).toBeUndefined();
      expect(body.down).toEqual([]);
      expect(body.ok).toBe(true);
      expect(response.status).toBe(200);
    });
  });

  it("fails closed with 503 when the critical market read path fails", async () => {
    await withSystemTime(NOW, async () => {
      const env = envWith(healthyCriticalTables(), { marketIndices: true });
      const response = await worker.fetch(new Request("https://example.test/healthz/sources"), env);
      expect(response.status).toBe(503);
      const body = (await response.json()) as { ok: boolean; down: string[] };
      // The empty read model degrades market to Unavailable/Error per source —
      // the endpoint never reports healthy on a failed critical read.
      expect(body.ok).toBe(false);
      expect(body.down).toContain("market");
    });
  });

  it("returns 503 read_model_unavailable when the critical read path throws", async () => {
    vi.mocked(readMarketContext).mockRejectedValueOnce(new Error("D1 hard failure"));
    const env = envWith(healthyTables());
    const response = await worker.fetch(new Request("https://example.test/healthz/sources"), env);
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe("read_model_unavailable");
  });

  it("fails closed with 503 read_model_unavailable when the market health record is unreadable", async () => {
    await withSystemTime(NOW, async () => {
      // A persisted provider error must never be invisible: a malformed
      // marketContextHealth record (or a failed read of it) is treated as
      // read_model_unavailable, not as "no record".
      const env = envWith({
        ...healthyCriticalTables(),
        appMeta: { ...healthyTables().appMeta, marketContextHealth: "not-json{{{" },
      });
      const response = await worker.fetch(new Request("https://example.test/healthz/sources"), env);
      expect(response.status).toBe(503);
      const body = (await response.json()) as { ok: boolean; error?: string };
      expect(body.ok).toBe(false);
      expect(body.error).toBe("read_model_unavailable");
    });
  });

  it("fails closed with 503 read_model_unavailable when the market health record is semantically invalid", async () => {
    await withSystemTime(NOW, async () => {
      // A degraded record without an error is structurally invalid: the
      // runtime always records an error with a degraded status, and
      // normalizing it away could read Live during an active failure.
      const env = envWith({
        ...healthyCriticalTables(),
        appMeta: {
          ...healthyTables().appMeta,
          marketContextHealth: JSON.stringify({ provider: "yahoo-finance-chart", status: "degraded" }),
        },
      });
      const response = await worker.fetch(new Request("https://example.test/healthz/sources"), env);
      expect(response.status).toBe(503);
      const body = (await response.json()) as { ok: boolean; error?: string };
      expect(body.ok).toBe(false);
      expect(body.error).toBe("read_model_unavailable");
    });
  });

  it("fails closed with 503 read_model_unavailable when the market health record is an incomplete shape", async () => {
    await withSystemTime(NOW, async () => {
      // The runtime always persists the complete record shape; an `ok`
      // record missing its timestamp/error fields is malformed and its
      // absent error must never read as healthy.
      const env = envWith({
        ...healthyCriticalTables(),
        appMeta: {
          ...healthyTables().appMeta,
          marketContextHealth: JSON.stringify({ provider: "yahoo-finance-chart", status: "ok" }),
        },
      });
      const response = await worker.fetch(new Request("https://example.test/healthz/sources"), env);
      expect(response.status).toBe(503);
      const body = (await response.json()) as { ok: boolean; error?: string };
      expect(body.ok).toBe(false);
      expect(body.error).toBe("read_model_unavailable");
    });
  });

  it("fails closed with 503 read_model_unavailable when the market health record carries invalid timestamps", async () => {
    await withSystemTime(NOW, async () => {
      // A structurally complete record with garbage timestamps is malformed
      // critical metadata: it must fail closed rather than silently fall
      // back to other timestamps and read healthy.
      const env = envWith({
        ...healthyCriticalTables(),
        appMeta: {
          ...healthyTables().appMeta,
          marketContextHealth: JSON.stringify({
            provider: "yahoo-finance-chart",
            status: "ok",
            lastAttemptAt: "not-a-date",
            lastSuccessfulUpdate: "2026-08-13T17:59:00.000Z",
            lastError: null,
            httpStatuses: [],
            rowsWritten: 0,
            lastKnownGoodPreserved: false,
          }),
        },
      });
      const response = await worker.fetch(new Request("https://example.test/healthz/sources"), env);
      expect(response.status).toBe(503);
      const body = (await response.json()) as { ok: boolean; error?: string };
      expect(body.ok).toBe(false);
      expect(body.error).toBe("read_model_unavailable");
    });
  });

  it("keeps a free-text provider error readable — a degraded record with non-date text pages per source, not read_model_unavailable", async () => {
    await withSystemTime(NOW, async () => {
      // lastError is free text ("temporary outage" is not a parseable date);
      // it must never be date-validated into a malformed-record rejection.
      const env = envWith({
        ...healthyCriticalTables(),
        appMeta: {
          ...healthyTables().appMeta,
          marketContextHealth: JSON.stringify({
            provider: "yahoo-finance-chart",
            status: "degraded",
            lastAttemptAt: "2026-08-13T17:59:00.000Z",
            lastSuccessfulUpdate: "2026-08-13T15:01:00.000Z",
            lastError: "temporary outage",
            httpStatuses: [],
            rowsWritten: 0,
            lastKnownGoodPreserved: true,
          }),
        },
      });
      const response = await worker.fetch(new Request("https://example.test/healthz/sources"), env);
      expect(response.status).toBe(503);
      const body = (await response.json()) as { ok: boolean; error?: string; down: string[] };
      expect(body.error).toBeUndefined();
      expect(body.down).toEqual(["market"]);
    });
  });

  it("fails closed with 503 read_model_unavailable when the market health record is an empty stored value", async () => {
    await withSystemTime(NOW, async () => {
      // An empty string is a present-but-unreadable record, not an absent
      // one: it must fail closed rather than read as "no record".
      const env = envWith({
        ...healthyCriticalTables(),
        appMeta: { ...healthyTables().appMeta, marketContextHealth: "" },
      });
      const response = await worker.fetch(new Request("https://example.test/healthz/sources"), env);
      expect(response.status).toBe(503);
      const body = (await response.json()) as { ok: boolean; error?: string };
      expect(body.ok).toBe(false);
      expect(body.error).toBe("read_model_unavailable");
    });
  });

  it("fails closed with 503 read_model_unavailable when the market health record read throws", async () => {
    vi.mocked(readMarketContextHealthStrict).mockRejectedValueOnce(new Error("app_meta unavailable"));
    const env = envWith(healthyCriticalTables());
    const response = await worker.fetch(new Request("https://example.test/healthz/sources"), env);
    expect(response.status).toBe(503);
    const body = (await response.json()) as { ok: boolean; error?: string };
    expect(body.error).toBe("read_model_unavailable");
  });
});

describe("buildMarketContextHealth", () => {
  const nowMs = Date.parse("2026-08-13T18:00:00Z");
  const context = (overrides: Partial<MarketContextReadModel> = {}): MarketContextReadModel => ({
    indices: [],
    sentiment: null,
    provider: null,
    latestSourceTimestamp: null,
    latestCollectedAt: null,
    ...overrides,
  });

  it("fails closed with a specific error when no index has ever been collected", () => {
    const health = buildMarketContextHealth(context(), nowMs);
    expect(health.state).toBe("Error");
    expect(health.error).toBe("No market index data has been collected.");
  });

  it("has no error when all four indices are present from today's New York session", () => {
    const indices = ["SPX", "NDX", "DJI", "VIX"].map((symbol) => ({
      symbol: symbol as "SPX" | "NDX" | "DJI" | "VIX",
      name: symbol,
      value: 100,
      change: 0.1,
      updatedAt: "2026-08-13T15:00:00Z",
    }));
    const health = buildMarketContextHealth(
      context({ indices, provider: "yahoo-finance-chart", latestSourceTimestamp: "2026-08-13T15:00:00Z", latestCollectedAt: "2026-08-13T15:01:00Z" }),
      nowMs,
    );
    expect(health.error).toBeNull();
  });

  it("flags an incomplete index set even though a source timestamp exists", () => {
    const health = buildMarketContextHealth(
      context({
        indices: [{ symbol: "SPX", name: "S&P 500", value: 100, change: 0.1, updatedAt: "2026-08-13T15:00:00Z" }],
        provider: "yahoo-finance-chart",
        latestSourceTimestamp: "2026-08-13T15:00:00Z",
        latestCollectedAt: "2026-08-13T15:01:00Z",
      }),
      nowMs,
    );
    expect(health.error).toContain("incomplete or from a prior session");
  });

  it("flags a complete index set left over from a prior session's date", () => {
    const staleIndices = ["SPX", "NDX", "DJI", "VIX"].map((symbol) => ({
      symbol: symbol as "SPX" | "NDX" | "DJI" | "VIX",
      name: symbol,
      value: 100,
      change: 0.1,
      updatedAt: "2026-08-10T15:00:00Z",
    }));
    const health = buildMarketContextHealth(
      context({ indices: staleIndices, provider: "yahoo-finance-chart", latestSourceTimestamp: "2026-08-10T15:00:00Z", latestCollectedAt: "2026-08-10T15:01:00Z" }),
      nowMs,
    );
    expect(health.error).toContain("incomplete or from a prior session");
  });

  it("surfaces a provider failure while retaining the persisted snapshot", () => {
    const indices = ["SPX", "NDX", "DJI", "VIX"].map((symbol) => ({
      symbol: symbol as "SPX" | "NDX" | "DJI" | "VIX",
      name: symbol,
      value: 100,
      change: 0.1,
      updatedAt: "2026-08-13T15:00:00Z",
    }));
    const health = buildMarketContextHealth(
      context({ indices, provider: "yahoo-finance-chart", latestSourceTimestamp: "2026-08-13T15:00:00Z", latestCollectedAt: "2026-08-13T15:01:00Z" }),
      nowMs,
      {
        provider: "yahoo-finance-chart",
        status: "degraded",
        lastAttemptAt: "2026-08-13T17:59:00Z",
        lastSuccessfulUpdate: "2026-08-13T15:01:00Z",
        lastError: "SPX: provider HTTP 429",
        httpStatuses: [429],
        rowsWritten: 0,
        lastKnownGoodPreserved: true,
      },
    );
    expect(health.state).toBe("Cached");
    expect(health.error).toBe("SPX: provider HTTP 429");
    expect(health.lastAttempt).toBe("2026-08-13T17:59:00.000Z");
  });
});

describe("downCriticalSources", () => {
  const NOW = Date.parse("2026-08-13T18:00:00Z");
  const WEEKEND = Date.parse("2026-08-15T12:00:00Z");

  const context = (overrides: Partial<MarketContextReadModel> = {}): MarketContextReadModel => ({
    indices: [],
    sentiment: null,
    provider: null,
    latestSourceTimestamp: null,
    latestCollectedAt: null,
    ...overrides,
  });
  const indicesAt = (updatedAt: string) =>
    (["SPX", "NDX", "DJI", "VIX"] as const).map((symbol) => ({
      symbol,
      name: symbol,
      value: 100,
      change: 0.1,
      updatedAt,
    }));
  const contextWith = (indices: MarketContextReadModel["indices"], updatedAt: string | null): MarketContextReadModel =>
    context({
      indices,
      provider: "yahoo-finance-chart",
      latestSourceTimestamp: updatedAt,
      latestCollectedAt: updatedAt,
    });
  const degradedHealth: MarketContextHealthRecord = {
    provider: "yahoo-finance-chart",
    status: "degraded",
    lastAttemptAt: "2026-08-13T17:59:00Z",
    lastSuccessfulUpdate: "2026-08-13T15:01:00Z",
    lastError: "SPX: provider HTTP 429",
    httpStatuses: [429],
    rowsWritten: 0,
    lastKnownGoodPreserved: true,
  };
  const healthyHealth: MarketContextHealthRecord = {
    provider: "yahoo-finance-chart",
    status: "ok",
    lastAttemptAt: "2026-08-13T17:59:00Z",
    lastSuccessfulUpdate: "2026-08-13T17:59:00Z",
    lastError: null,
    httpStatuses: [],
    rowsWritten: 0,
    lastKnownGoodPreserved: false,
  };

  const sourcesWith = (market: SourceHealth, engineState: EarningsEngineState): PublicSourceHealth => {
    const sources = unavailableSources();
    return {
      ...sources,
      market,
      earnings: { ...sources.earnings, engineState },
    };
  };

  it("flags market when no index has ever been collected", () => {
    const market = buildMarketContextHealth(context(), NOW);
    expect(market.state).toBe("Error");
    expect(downCriticalSources(sourcesWith(market, "HEALTHY"), context(), NOW)).toEqual(["market"]);
  });

  it("does NOT flag a complete prior-session set — the overnight/weekend case", () => {
    const priorSession = contextWith(indicesAt("2026-08-14T20:00:00.000Z"), "2026-08-14T20:00:00.000Z"); // Friday close
    const market = buildMarketContextHealth(priorSession, WEEKEND); // Saturday: window closed, backstop skipped
    expect(market.state).toBe("Cached");
    expect(downCriticalSources(sourcesWith(market, "HEALTHY"), priorSession, WEEKEND)).toEqual([]);
  });

  it("flags market on an active collection failure even when the last-known-good set is intact", () => {
    const market = buildMarketContextHealth(
      contextWith(indicesAt("2026-08-13T15:00:00.000Z"), "2026-08-13T15:00:00.000Z"),
      NOW,
      degradedHealth,
    );
    expect(market.state).toBe("Cached");
    expect(market.error).toContain("HTTP 429");
    expect(downCriticalSources(
      sourcesWith(market, "HEALTHY"),
      contextWith(indicesAt("2026-08-13T15:00:00.000Z"), "2026-08-13T15:00:00.000Z"),
      NOW,
    )).toEqual(["market"]);
  });

  it("flags market when collection has stopped entirely — stale data during an open session", () => {
    // No health record: the runtime has not collected since yesterday's
    // close (dead scheduler). lastError is null, so only the accumulated
    // regular-session time can catch this.
    const priorSession = contextWith(indicesAt("2026-08-12T20:00:00.000Z"), "2026-08-12T20:00:00.000Z");
    const market = buildMarketContextHealth(priorSession, NOW);
    expect(market.state).toBe("Cached");
    expect(downCriticalSources(sourcesWith(market, "HEALTHY"), priorSession, NOW)).toEqual(["market"]);
  });

  it("does NOT flag stale data outside collection windows — the same data on a weekend", () => {
    const priorSession = contextWith(indicesAt("2026-08-14T20:00:00.000Z"), "2026-08-14T20:00:00.000Z");
    const market = buildMarketContextHealth(priorSession, WEEKEND);
    expect(downCriticalSources(sourcesWith(market, "HEALTHY"), priorSession, WEEKEND)).toEqual([]);
  });

  it("does NOT heal at the close — data frozen mid-session stays flagged straight through it and into the weekend", () => {
    // Data frozen at Thursday noon (16:00Z): 240 regular-session minutes
    // elapse by the close, so it is overdue by 16:45 ET...
    const frozenAtNoon = contextWith(indicesAt("2026-08-13T16:00:00.000Z"), "2026-08-13T16:00:00.000Z");
    const stillMidSession = Date.parse("2026-08-13T17:00:00.000Z"); // 1:00pm ET
    expect(downCriticalSources(sourcesWith(buildMarketContextHealth(frozenAtNoon, stillMidSession), "HEALTHY"), frozenAtNoon, stillMidSession)).toEqual(["market"]);
    // ...and must NOT silently clear itself when the window closes.
    const afterClose = Date.parse("2026-08-13T21:00:00.000Z"); // 5:00pm ET
    expect(downCriticalSources(sourcesWith(buildMarketContextHealth(frozenAtNoon, afterClose), "HEALTHY"), frozenAtNoon, afterClose)).toEqual(["market"]);
    // Nor over the weekend into Monday's pre-open.
    const mondayPreOpen = Date.parse("2026-08-17T13:00:00.000Z"); // Monday 9:00am ET
    expect(downCriticalSources(sourcesWith(buildMarketContextHealth(frozenAtNoon, mondayPreOpen), "HEALTHY"), frozenAtNoon, mondayPreOpen)).toEqual(["market"]);
  });

  it("flags a single frozen index while the other three keep publishing", () => {
    // The aggregate newest row would read fresh; each required index's own
    // updatedAt must be checked.
    const mixed = contextWith([
      ...indicesAt("2026-08-13T17:45:00.000Z").slice(0, 3),
      { symbol: "VIX" as const, name: "VIX", value: 100, change: 0.1, updatedAt: "2026-08-13T10:00:00.000Z" }, // frozen at 6:00am ET
    ], "2026-08-13T17:45:00.000Z");
    expect(downCriticalSources(sourcesWith(buildMarketContextHealth(mixed, NOW), "HEALTHY"), mixed, NOW)).toEqual(["market"]);
  });

  it("flags data older than the absolute 96h backstop even across a closed stretch", () => {
    const thursdayClose = contextWith(indicesAt("2026-08-13T20:00:00.000Z"), "2026-08-13T20:00:00.000Z");
    const mondayEvening = Date.parse("2026-08-17T21:00:00.000Z"); // 5pm ET Monday — 97h later
    expect(downCriticalSources(sourcesWith(buildMarketContextHealth(thursdayClose, mondayEvening), "HEALTHY"), thursdayClose, mondayEvening)).toEqual(["market"]);
  });

  it("does NOT flag the opening minutes of a new session still carrying Friday's close", () => {
    const fridayClose = contextWith(indicesAt("2026-08-14T20:00:00.000Z"), "2026-08-14T20:00:00.000Z");
    const mondayJustAfterOpen = Date.parse("2026-08-17T13:35:00.000Z"); // 9:35am ET — 5 regular minutes elapsed
    expect(downCriticalSources(sourcesWith(buildMarketContextHealth(fridayClose, mondayJustAfterOpen), "HEALTHY"), fridayClose, mondayJustAfterOpen)).toEqual([]);
  });

  it("flags a late-session freeze that missed the closing print — and keeps it flagged through the weekend", () => {
    // Last successful quote at 15:45 ET (19:45Z), scheduler dies: only 15
    // regular minutes elapse before the close, but the missing closing and
    // post-close collections keep accumulating through the post-close
    // window, crossing the 45-minute allowance by ~16:45 ET.
    const lateFreeze = contextWith(indicesAt("2026-08-13T19:45:00.000Z"), "2026-08-13T19:45:00.000Z");
    const afterPostClose = Date.parse("2026-08-13T21:00:00.000Z"); // 5:00pm ET
    expect(downCriticalSources(sourcesWith(buildMarketContextHealth(lateFreeze, afterPostClose), "HEALTHY"), lateFreeze, afterPostClose)).toEqual(["market"]);
    const saturday = Date.parse("2026-08-15T12:00:00.000Z");
    expect(downCriticalSources(sourcesWith(buildMarketContextHealth(lateFreeze, saturday), "HEALTHY"), lateFreeze, saturday)).toEqual(["market"]);
  });

  it("treats the Friday before a Sunday holiday as a regular session — no shifted early close on July 2, 2027", () => {
    // July 4, 2027 is a Sunday: observed Monday July 5, no early-close shift
    // on the preceding Friday (NYSE 2021/2027 calendars). Data frozen at
    // 12:30 ET accumulates 90 regular minutes by 14:00 ET -> overdue; the
    // gate must not treat 13:00 as a close on that day.
    const regularFriday = contextWith(indicesAt("2027-07-02T16:30:00.000Z"), "2027-07-02T16:30:00.000Z"); // 12:30pm ET
    const checkedAt = Date.parse("2027-07-02T18:00:00.000Z"); // 2:00pm ET
    expect(downCriticalSources(sourcesWith(buildMarketContextHealth(regularFriday, checkedAt), "HEALTHY"), regularFriday, checkedAt)).toEqual(["market"]);
  });

  it("flags market when a required index is missing", () => {
    const incomplete = contextWith(indicesAt("2026-08-13T17:45:00.000Z").slice(0, 3), "2026-08-13T17:45:00.000Z");
    const market = buildMarketContextHealth(incomplete, NOW);
    expect(market.error).toContain("incomplete or from a prior session");
    expect(downCriticalSources(sourcesWith(market, "HEALTHY"), incomplete, NOW)).toEqual(["market"]);
  });

  it("flags market on future-dated timestamps — corrupt data never reads as healthy", () => {
    const future = contextWith(indicesAt("2026-08-13T20:00:00.000Z"), "2026-08-13T20:00:00.000Z"); // 2h ahead of NOW
    const market = buildMarketContextHealth(future, NOW);
    // A future success is not valid success evidence and carries no error, so
    // the canonical state is Unavailable — down either way.
    expect(market.state).toBe("Unavailable");
    expect(downCriticalSources(sourcesWith(market, "HEALTHY"), future, NOW)).toEqual(["market"]);
  });

  it("does NOT flag a Live market", () => {
    const healthy = contextWith(indicesAt("2026-08-13T17:45:00.000Z"), "2026-08-13T17:45:00.000Z");
    const market = buildMarketContextHealth(healthy, NOW, healthyHealth);
    expect(market.state).toBe("Live");
    expect(downCriticalSources(sourcesWith(market, "HEALTHY"), healthy, NOW)).toEqual([]);
  });

  it("flags earnings unless the canonical engine state is HEALTHY", () => {
    const healthy = contextWith(indicesAt("2026-08-13T17:45:00.000Z"), "2026-08-13T17:45:00.000Z");
    const market = buildMarketContextHealth(healthy, NOW, healthyHealth);
    for (const engineState of ["UNINITIALIZED", "DEGRADED", "STALE"] as const) {
      expect(downCriticalSources(sourcesWith(market, engineState), healthy, NOW)).toEqual(["earnings"]);
    }
    expect(downCriticalSources(sourcesWith(market, "HEALTHY"), healthy, NOW)).toEqual([]);
  });

  it("reports both critical sources when both are down", () => {
    const market = buildMarketContextHealth(context(), NOW);
    expect(downCriticalSources(sourcesWith(market, "UNINITIALIZED"), context(), NOW)).toEqual(["market", "earnings"]);
  });
});

describe("unavailableSources", () => {
  it("fails every source closed with the given reason", () => {
    const sources = unavailableSources();
    for (const source of Object.values(sources)) {
      expect(source.state).toBe("Error");
      expect(source.error).toBe("Source health is unavailable.");
    }
    expect(Object.keys(sources).sort()).toEqual(
      ["briefing", "earnings", "market", "opportunities", "quickStats", "sentiment", "x"].sort(),
    );
  });
});
