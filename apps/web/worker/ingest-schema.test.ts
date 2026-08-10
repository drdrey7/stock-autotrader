import { describe, expect, it } from "vitest";
import { eventSchema } from "./ingest";

const base = {
  event_id: "scan-test-0001",
  timestamp: "2026-08-10T22:00:00Z",
};

describe("ingest event schema (publication contract)", () => {
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
            direction: "Long",
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

  it("accepts SYSTEM_STATUS and SHADOW_POSITION events", () => {
    expect(eventSchema.parse({ ...base, type: "SYSTEM_STATUS", payload: { engine: "online", apiHealth: "healthy" } }).type).toBe("SYSTEM_STATUS");
    expect(eventSchema.parse({
      ...base,
      type: "SHADOW_POSITION_OPENED",
      payload: { symbol: "NVDA", strategy: "Trend Breakout", entryPrice: 177.2, currentPrice: 182.64, stopPrice: 169.4, quantity: 3, riskAmount: 23.4, unrealizedPnl: 16.32, returnPct: 3.07, rMultiple: 0.7, openedAt: "2026-08-06T14:35:00Z", updatedAt: "2026-08-10T22:00:00Z" },
    }).type).toBe("SHADOW_POSITION_OPENED");
  });

  it("rejects unknown types and malformed payloads", () => {
    expect(() => eventSchema.parse({ ...base, type: "HACK_EVENT", payload: {} })).toThrow();
    expect(() => eventSchema.parse({ ...base, type: "SCAN_COMPLETED", payload: { nope: 1 } })).toThrow();
    expect(() => eventSchema.parse({ ...base, type: "SYSTEM_STATUS", payload: { engine: "onfire", apiHealth: "healthy" } })).toThrow();
    expect(() => eventSchema.parse({ ...base, type: "SCAN_COMPLETED", payload: { scannedAt: "x", universe: -5, passedFilters: 0, candidates: 0, setups: 0, watch: 0 } })).toThrow();
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
