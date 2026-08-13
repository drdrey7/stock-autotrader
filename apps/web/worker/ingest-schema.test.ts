import { describe, expect, it } from "vitest";
import { demoData } from "@stock-autotrader/contracts/src/demo-data";
import { exampleDailyBriefing } from "../src/daily-briefing-example";
import { dashboardReadSchema, eventSchema, marketDataSchema } from "./ingest";
import { buildMarketSourceHealth, buildSourceHealth, buildSources, normalizeDirection, validateSourceHealth } from "./index";
import { publicSourceHealthSchema, sourceHealthSchema, type DashboardData, type SourceHealth } from "@stock-autotrader/contracts";
import type { Env } from "./index";

const base = {
  event_id: "scan-test-0001",
  timestamp: "2026-08-10T22:00:00Z",
};

describe("buildSourceHealth (honest freshness boundary)", () => {
  const nowMs = Date.parse("2026-08-13T12:00:00Z");
  const opts = (staleAfterSeconds = 3600) => ({ provider: "test-source", staleAfterSeconds, nowMs });

  it("classifies Live, Stale, Cached, Error and Unavailable without leaking data", () => {
    expect(buildSourceHealth("2026-08-13T11:00:00Z", "2026-08-13T11:00:00Z", opts()).state).toBe("Live");
    expect(buildSourceHealth("2026-08-10T11:00:00Z", "2026-08-10T11:00:00Z", opts()).state).toBe("Stale");
    expect(buildSourceHealth("2026-08-10T11:00:00Z", "2026-08-13T11:00:00Z", { ...opts(), error: "degraded" }).state).toBe("Cached");
    expect(buildSourceHealth(null, "2026-08-13T11:00:00Z", { ...opts(), error: "boom" }).state).toBe("Error");
    expect(buildSourceHealth(null, null, opts()).state).toBe("Unavailable");
  });

  it("fails closed on future or malformed timestamps", () => {
    const future = buildSourceHealth("2026-08-14T12:00:00Z", "2026-08-14T12:00:00Z", opts());
    expect(future.state).toBe("Unavailable");
    expect(future.asOf).toBeNull();
    expect(buildSourceHealth("not-a-date", "not-a-date", { ...opts(), error: "x" }).state).toBe("Error");
  });

  it("records the last success as attempt evidence when no attempt was recorded", () => {
    const health = buildSourceHealth("2026-08-13T11:00:00Z", null, opts());
    expect(health.state).toBe("Live");
    expect(health.lastAttempt).toBe(health.lastSuccess);
    expect(sourceHealthSchema.safeParse(health).success).toBe(true);
  });

  it("preserves a successful timestamp when a market snapshot is degraded", () => {
    const health = buildMarketSourceHealth({
      provider: "market-cache",
      status: "degraded",
      asOf: "2026-08-10",
      lastSuccessfulUpdate: "2026-08-10T16:00:00Z",
      universe: { total: 1, eligible: 1, excluded: 0 },
      benchmarks: [],
      warnings: ["stale"],
      updatedAt: "2026-08-13T11:00:00Z",
    }, nowMs);
    expect(health.state).toBe("Cached");
    expect(health.lastSuccess).toBe("2026-08-10T16:00:00.000Z");
    expect(sourceHealthSchema.safeParse(health).success).toBe(true);
  });
  it("always emits schema-valid health across states", () => {
    const cases = [
      buildSourceHealth("2026-08-13T11:00:00Z", "2026-08-13T11:00:00Z", opts()),
      buildSourceHealth("2026-08-13T11:00:00Z", null, opts()),
      buildSourceHealth("2026-08-10T11:00:00Z", "2026-08-10T11:00:00Z", opts()),
      buildSourceHealth("2026-08-10T11:00:00Z", "2026-08-13T11:00:00Z", { ...opts(), error: "degraded" }),
      buildSourceHealth(null, "2026-08-13T11:00:00Z", { ...opts(), error: "boom" }),
      buildSourceHealth(null, null, opts()),
      buildSourceHealth("2026-08-14T12:00:00Z", null, opts()),
    ];
    for (const health of cases) {
      const parsed = sourceHealthSchema.safeParse(health);
      expect(parsed.success, JSON.stringify(health)).toBe(true);
    }
  });
});

describe("validateSourceHealth (per-source fail closed)", () => {
  const nowMs = Date.parse("2026-08-13T12:00:00Z");
  const live = () => buildSourceHealth("2026-08-13T11:00:00Z", "2026-08-13T11:00:00Z", {
    provider: "valid-source",
    staleAfterSeconds: 3600,
    nowMs,
  });

  it("degrades only the source that violates the shared contract", () => {
    const broken: SourceHealth = { ...live(), lastAttempt: null };
    const payload = {
      briefing: live(),
      market: broken,
      opportunities: live(),
      x: live(),
      earnings: live(),
      sentiment: live(),
      quickStats: live(),
    };
    const result = validateSourceHealth(payload);
    expect(result.briefing.state).toBe("Live");
    expect(result.market.state).toBe("Unavailable");
    expect(result.market.lastSuccess).toBeNull();
    expect(result.opportunities.state).toBe("Live");
    expect(publicSourceHealthSchema.safeParse(result).success).toBe(true);
  });

  it("returns valid payloads untouched", () => {
    const payload = {
      briefing: live(),
      market: live(),
      opportunities: live(),
      x: live(),
      earnings: live(),
      sentiment: live(),
      quickStats: live(),
    };
    expect(validateSourceHealth(payload)).toEqual(publicSourceHealthSchema.parse(payload));
  });
});

describe("ingest event schema (publication contract)", () => {
  it("validates the shared source-health contract without allowing live data to omit freshness", () => {
    const live = {
      provider: "tradingview",
      state: "Live" as const,
      asOf: "2026-08-13T15:30:00Z",
      ageSeconds: 120,
      staleAfterSeconds: 3600,
      lastSuccess: "2026-08-13T15:29:00Z",
      lastAttempt: "2026-08-13T15:29:00Z",
      error: null,
    };
    expect(sourceHealthSchema.safeParse(live).success).toBe(true);
    expect(sourceHealthSchema.safeParse({ ...live, asOf: null }).success).toBe(false);
    expect(sourceHealthSchema.safeParse({ ...live, ageSeconds: null }).success).toBe(false);
    expect(publicSourceHealthSchema.safeParse({
      briefing: live,
      market: live,
      opportunities: live,
      x: { ...live, provider: "x-search" },
      earnings: { ...live, provider: "earnings-calendar" },
      sentiment: { ...live, state: "Unavailable", asOf: null, ageSeconds: null, lastSuccess: null, error: "No source configured" },
      quickStats: { ...live, state: "Unavailable", asOf: null, ageSeconds: null, lastSuccess: null, error: "No source configured" },
    }).success).toBe(true);
  });

  it("accepts a valid SCAN_COMPLETED event", () => {
    const parsed = eventSchema.parse({
      ...base,
      type: "SCAN_COMPLETED",
      payload: {
        scannedAt: "2026-08-10T22:00:00Z",
        universe: 1600,
        passedFilters: 900,
        candidates: 1,
        setups: 1,
        watch: 0,
        results: [
          {
            symbol: "AAPL",
            company: "Apple Inc.",
            sector: "Technology",
            marketCap: 3_200_000_000_000,
            price: 245.1,
            quantScore: 88,
            strategyId: "trend_breakout_v1",
            strategyVersion: "1.0.0",
            strategy: "Trend Breakout",
            trend: "Strong",
            momentum: 12.3,
            relativeStrength: 1.4,
            relativeVolume: 1.8,
            breakout: "50D breakout",
            status: "Strong Setup",
            direction: "Bullish",
            riskFlags: [],
            updatedAt: "2026-08-10T22:00:00Z",
            reasons: [{ code: "trend_alignment", label: "Price above all EMAs", outcome: "pass" }],
          },
        ],
      },
    });
    expect(parsed.type).toBe("SCAN_COMPLETED");
    if (parsed.type === "SCAN_COMPLETED") {
      expect(parsed.payload.results[0]!.symbol).toBe("AAPL");
    }
  });

  it("normalizes legacy Long direction to the shared Bullish contract", () => {
    const parsed = eventSchema.parse({
      ...base,
      type: "SIGNAL_SURFACED",
      payload: {
        symbol: "AAPL",
        company: "Apple Inc.",
        quantScore: 80,
        strategyId: "trend_breakout_v1",
        strategyVersion: "1.0.0",
        strategy: "Trend Breakout",
        trend: "Strong",
        status: "Strong Setup",
        direction: "Long",
        riskFlags: [],
        updatedAt: "2026-08-10T22:00:00Z",
      },
    });
    if (parsed.type === "SIGNAL_SURFACED") expect(parsed.payload.direction).toBe("Bullish");
  });

  it("accepts SYSTEM_STATUS and SHADOW_POSITION events", () => {
    expect(eventSchema.parse({ ...base, type: "SYSTEM_STATUS", payload: { engine: "online", apiHealth: "healthy" } }).type).toBe("SYSTEM_STATUS");
    expect(eventSchema.parse({
      ...base,
      type: "SHADOW_POSITION_OPENED",
      payload: { symbol: "NVDA", strategy: "Trend Breakout", entryPrice: 177.2, currentPrice: 182.64, stopPrice: 169.4, quantity: 3, riskAmount: 23.4, unrealizedPnl: 16.32, returnPct: 3.07, rMultiple: 0.7, openedAt: "2026-08-06T14:35:00Z", updatedAt: "2026-08-10T22:00:00Z" },
    }).type).toBe("SHADOW_POSITION_OPENED");
  });

  it("accepts MARKET_DATA_UPDATED with bounded benchmark bars", () => {
    const payload = {
      provider: "csv",
      status: "healthy" as const,
      asOf: "2026-08-10",
      lastSuccessfulUpdate: "2026-08-10T22:00:00Z",
      universe: { total: 100, eligible: 80, excluded: 20 },
      benchmarks: [
        { symbol: "SPY", date: "2026-08-10", open: 1, high: 2, low: 0.9, close: 1.5, adjustedClose: 1.5, volume: 1000 },
        { symbol: "QQQ", date: "2026-08-10", open: 2, high: 3, low: 1.9, close: 2.5, adjustedClose: 2.5, volume: 900 },
      ],
      warnings: [],
      updatedAt: "2026-08-10T22:00:00Z",
    };
    const parsed = eventSchema.parse({ ...base, type: "MARKET_DATA_UPDATED", payload });
    expect(parsed.type).toBe("MARKET_DATA_UPDATED");
    expect(() => eventSchema.parse({
      ...base,
      type: "MARKET_DATA_UPDATED",
      payload: { ...payload, benchmarks: [{ ...payload.benchmarks[0], date: "not-a-date", high: 0.5 }] },
    })).toThrow();
    expect(() => eventSchema.parse({ ...base, timestamp: "not-a-timestamp", type: "MARKET_DATA_UPDATED", payload })).toThrow();
    expect(() => eventSchema.parse({ ...base, type: "MARKET_DATA_UPDATED", payload: { ...payload, asOf: "2026-99-99" } })).toThrow();
    expect(() => eventSchema.parse({ ...base, type: "MARKET_DATA_UPDATED", payload: { ...payload, lastSuccessfulUpdate: "not-a-timestamp" } })).toThrow();
    expect(() => eventSchema.parse({ ...base, type: "MARKET_DATA_UPDATED", payload: { ...payload, benchmarks: [{ ...payload.benchmarks[0], volume: 0 }, payload.benchmarks[1]] } })).toThrow();
    expect(marketDataSchema.safeParse({ ...payload, universe: { total: 2, eligible: 1, excluded: 0 } }).success).toBe(false);
  });

  it("accepts a real DailyBriefing publication event and rejects Example Data", () => {
    const payload = JSON.parse(JSON.stringify({ ...exampleDailyBriefing, example: false }));
    const parsed = eventSchema.parse({
      ...base,
      event_id: "briefing-test-0001",
      type: "DAILY_BRIEFING_PUBLISHED",
      payload,
    });
    expect(parsed.type).toBe("DAILY_BRIEFING_PUBLISHED");

    expect(() => eventSchema.parse({
      ...base,
      event_id: "briefing-test-0002",
      type: "DAILY_BRIEFING_PUBLISHED",
      payload: exampleDailyBriefing,
    })).toThrow();
    expect(() => eventSchema.parse({
      ...base,
      event_id: "briefing-test-0003",
      type: "DAILY_BRIEFING_PUBLISHED",
      payload: { ...payload, unknownField: true },
    })).toThrow();
  });


  it("rejects unknown types and malformed payloads", () => {
    expect(() => eventSchema.parse({ ...base, type: "HACK_EVENT", payload: {} })).toThrow();
    expect(() => eventSchema.parse({ ...base, type: "SCAN_COMPLETED", payload: { nope: 1 } })).toThrow();
    expect(() => eventSchema.parse({ ...base, type: "SYSTEM_STATUS", payload: { engine: "onfire", apiHealth: "healthy" } })).toThrow();
    expect(() => eventSchema.parse({ ...base, type: "SYSTEM_STATUS", payload: { engine: "online", nextScan: "not-a-timestamp", apiHealth: "healthy" } })).toThrow();
    expect(() => eventSchema.parse({ ...base, type: "SCAN_COMPLETED", payload: { scannedAt: "x", universe: -5, passedFilters: 0, candidates: 0, setups: 0, watch: 0 } })).toThrow();
  });

  it("validates the complete read model and preserves the canonical direction", () => {
    expect(dashboardReadSchema.safeParse(demoData).success).toBe(true);
    expect(normalizeDirection("Long")).toBe("Bullish");
    expect(normalizeDirection("Bullish")).toBe("Bullish");

    const invalidFreshness = {
      ...demoData,
      status: { ...demoData.status, lastDataUpdate: "not-a-timestamp" },
    };
    expect(dashboardReadSchema.safeParse(invalidFreshness).success).toBe(false);

    const invalidRiskPolicy = {
      ...demoData,
      portfolio: {
        ...demoData.portfolio,
        riskPolicy: { ...demoData.portfolio.riskPolicy, maxPositions: 0 },
      },
    };
    expect(dashboardReadSchema.safeParse(invalidRiskPolicy).success).toBe(false);
  });

  it("rejects oversized batches and bad symbols", () => {
    expect(() => eventSchema.parse({
      ...base,
      type: "EARNINGS_UPDATED",
      payload: { items: Array.from({ length: 501 }, (_, i) => ({ symbol: `S${i}`, company: "X", date: "2026-01-01", timing: "BMO", eventSignal: "Confirmed", engineRelevant: false, signal: null, strategy: null, hasPosition: false, tracked: false, updatedAt: "2026-01-01T00:00:00Z" })) },
    })).toThrow();
    expect(() => eventSchema.parse({ ...base, type: "SIGNAL_SURFACED", payload: { symbol: "DROP TABLE;", company: "X", quantScore: 50, strategyId: "s", strategyVersion: "1", strategy: "S", trend: "Strong", status: "Watch", direction: "Long", riskFlags: [], updatedAt: "x" } })).toThrow();
  });
});

describe("buildSources (source health assembly)", () => {
  const nowMs = Date.parse("2026-08-13T12:00:00Z");
  const briefing = {
    available: true,
    freshness: "fresh" as const,
    editionDate: "2026-08-13",
    editionType: "pre_market" as const,
    preparedAt: "2026-08-13T10:00:00Z",
    publishedAt: "2026-08-13T10:00:00Z",
    ageSeconds: 120,
  };
  const envFor = (firsts: Record<string, unknown>, seenSql: string[] = []) => ({
    DB: {
      prepare(sql: string) {
        seenSql.push(sql);
        return {
          bind() { return this; },
          async first<T>(): Promise<T | null> {
            if (sql.includes("FROM x_posts")) return (firsts.x ?? null) as T | null;
            // The earnings freshness query is a single COALESCE over app_meta
            // and the latest row; the fake returns its resolved result.
            if (sql.includes("FROM app_meta")) return (firsts.earningsTs ?? null) as T | null;
            throw new Error(`Unhandled SELECT: ${sql}`);
          },
        };
      },
    },
  });

  it("treats a completed empty scan as a successful opportunities source", async () => {
    const dashboard = {
      ...demoData,
      status: {
        ...demoData.status,
        latestScan: "2026-08-13T11:00:00Z",
        lastDataUpdate: "2026-08-13T11:00:00Z",
      },
      candidates: [],
    };
    const sources = await buildSources(envFor({}) as unknown as Env, { briefing, dashboard: dashboard as unknown as DashboardData, nowMs });
    expect(sources.opportunities.state).toBe("Live");
    expect(sources.opportunities.error).toBeNull();
    expect(sources.opportunities.lastSuccess).toBe("2026-08-13T11:00:00.000Z");
  });

  it("marks opportunities Error only when no scan has ever completed", async () => {
    const dashboard = {
      ...demoData,
      status: { ...demoData.status, latestScan: null, lastDataUpdate: null },
      candidates: [],
    };
    const sources = await buildSources(envFor({}) as unknown as Env, { briefing, dashboard: dashboard as unknown as DashboardData, nowMs });
    expect(sources.opportunities.state).toBe("Error");
    expect(sources.opportunities.error).toContain("No scan has completed");
  });

  it("derives X freshness from the latest collection time", async () => {
    const seenSql: string[] = [];
    const sources = await buildSources(
      envFor({ x: { collected_at: "2026-08-13T11:30:00Z" } }, seenSql) as unknown as Env,
      { briefing, dashboard: demoData, nowMs },
    );
    expect(seenSql.some((sql) => sql.includes("MAX(collected_at)") && sql.includes("FROM x_posts"))).toBe(true);
    expect(sources.x.state).toBe("Live");
    expect(sources.x.lastSuccess).toBe("2026-08-13T11:30:00.000Z");
  });

  it("classifies an old collection as Stale, not Live", async () => {
    const sources = await buildSources(
      envFor({ x: { collected_at: "2026-08-01T00:00:00Z" } }) as unknown as Env,
      { briefing, dashboard: demoData, nowMs },
    );
    expect(sources.x.state).toBe("Stale");
  });

  it("derives earnings freshness from publication metadata", async () => {
    const sources = await buildSources(
      envFor({ earningsTs: { ts: "2026-08-13T11:45:00Z" } }) as unknown as Env,
      { briefing, dashboard: demoData, nowMs },
    );
    expect(sources.earnings.state).toBe("Live");
    expect(sources.earnings.lastSuccess).toBe("2026-08-13T11:45:00.000Z");
  });

  it("falls back to the latest earnings row when publication metadata is absent", async () => {
    const sources = await buildSources(
      envFor({ earningsTs: { ts: "2026-08-13T11:20:00Z" } }) as unknown as Env,
      { briefing, dashboard: demoData, nowMs },
    );
    expect(sources.earnings.state).toBe("Live");
    expect(sources.earnings.lastSuccess).toBe("2026-08-13T11:20:00.000Z");
  });
});
