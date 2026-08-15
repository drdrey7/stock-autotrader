import { describe, expect, it, vi } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import worker, { type Env } from "./index";
import { buildDashboard, buildMarketContextHealth, unavailableSources } from "./dashboard";
import type { MarketContextReadModel } from "./market-context";
import type { DashboardData, MarketDataSnapshot, PublicSourceHealth, StrategySummary } from "@stock-autotrader/contracts";

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
}

type ThrowOn = Partial<Record<"appMeta" | "dailyBriefings" | "scanCandidates" | "marketData", boolean>>;

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
