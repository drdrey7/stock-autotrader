import { describe, expect, it } from "vitest";
import type { ScreenerApiResponse } from "@stock-autotrader/contracts";
import { normalizeScreenerResponse, normalizeScreenerRow } from "./screener-compat";

/**
 * pre-PR2 PRODUCTION /api/screener payload — rows OMIT the SMA fields
 * entirely (the Cloudflare PR preview proxies /api/* to the production
 * worker, which does not expose them yet).
 */
const OLD_PRODUCTION_PAYLOAD = {
  universe: { version: 1, total: 50 },
  marketState: "regular",
  quotes: {
    state: "Live",
    provider: "finnhub-websocket",
    lastSuccessAt: "2026-08-19T14:00:00.000Z",
    lastAttemptAt: "2026-08-19T14:00:00.000Z",
    error: null,
    counts: { total: 50, live: 50, cached: 0, stale: 0, unavailable: 0 },
  },
  rows: [
    {
      symbol: "NVDA",
      company: "NVIDIA",
      price: 131.4,
      changeAbs: 2.1,
      changePct: 1.62,
      dayHigh: 132,
      dayLow: 129,
      dayOpen: 130,
      previousClose: 129.3,
      provider: "finnhub-quote",
      asOf: "2026-08-19T14:05:00.000Z",
      updatedAt: "2026-08-19T14:05:00.000Z",
      state: "Live",
      // NOTE: no sma200w / distanceToSma200wPct / sma200wState /
      //       sma200wHistoryWeeks / sma200wAsOf — the crash repro.
    },
    {
      symbol: "AAPL",
      company: "Apple",
      price: 0,
      changeAbs: null,
      changePct: null,
      dayHigh: null,
      dayLow: null,
      dayOpen: null,
      previousClose: null,
      provider: "finnhub-quote",
      asOf: "2026-08-19T14:05:00.000Z",
      updatedAt: "2026-08-19T14:05:00.000Z",
      state: "Cached",
    },
  ],
  asOf: "2026-08-19T14:05:00.000Z",
} as unknown as ScreenerApiResponse;

describe("normalizeScreenerResponse — old production payload compatibility", () => {
  it("maps EVERY omitted SMA field to its unavailable default (no undefined)", () => {
    const normalized = normalizeScreenerResponse(OLD_PRODUCTION_PAYLOAD);
    expect(normalized).not.toBeNull();
    const row = normalized!.rows[0]!;
    expect(row.sma200w).toBeNull();
    expect(row.distanceToSma200wPct).toBeNull();
    expect(row.sma200wState).toBe("Unavailable");
    expect(row.sma200wHistoryWeeks).toBeNull();
    expect(row.sma200wAsOf).toBeNull();
    // Every SMA field is now a defined, render-safe value.
    expect(Object.prototype.hasOwnProperty.call(row, "sma200w")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(row, "distanceToSma200wPct")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(row, "sma200wState")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(row, "sma200wHistoryWeeks")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(row, "sma200wAsOf")).toBe(true);
  });

  it("preserves the pre-existing (non-SMA) shape untouched", () => {
    const normalized = normalizeScreenerResponse(OLD_PRODUCTION_PAYLOAD);
    expect(normalized!.marketState).toBe("regular");
    expect(normalized!.universe.total).toBe(50);
    expect(normalized!.quotes.state).toBe("Live");
    expect(normalized!.rows).toHaveLength(2);
    expect(normalized!.rows[0]!.symbol).toBe("NVDA");
    expect(normalized!.rows[0]!.price).toBe(131.4);
    expect(normalized!.rows[0]!.state).toBe("Live");
  });

  it("passes explicit SMA values through unchanged (new payload)", () => {
    const modern = normalizeScreenerResponse({
      ...OLD_PRODUCTION_PAYLOAD,
      rows: [{ ...OLD_PRODUCTION_PAYLOAD.rows[0]!, sma200w: 100.25, distanceToSma200wPct: 3.05, sma200wState: "Above", sma200wHistoryWeeks: 1200, sma200wAsOf: "2026-08-19T06:00:00.000Z" }],
    });
    const row = modern!.rows[0]!;
    expect(row.sma200w).toBe(100.25);
    expect(row.distanceToSma200wPct).toBe(3.05);
    expect(row.sma200wState).toBe("Above");
    expect(row.sma200wHistoryWeeks).toBe(1200);
    expect(row.sma200wAsOf).toBe("2026-08-19T06:00:00.000Z");
  });

  it("keeps explicit nulls null and coerces invalid state strings to Unavailable", () => {
    const row = normalizeScreenerRow({
      sma200w: null,
      distanceToSma200wPct: null,
      sma200wState: "NotARealState",
      sma200wHistoryWeeks: null,
      sma200wAsOf: null,
    } as Record<string, unknown> as never);
    expect(row.sma200wState).toBe("Unavailable");
  });

  it("keeps a legitimate zero/negative distance (not mistaken for missing)", () => {
    const row = normalizeScreenerRow({
      distanceToSma200wPct: 0,
      sma200wState: "Near",
    } as never);
    expect(row.distanceToSma200wPct).toBe(0);
    expect(row.sma200wState).toBe("Near");
  });

  it("returns null for a non-Screener-shaped payload (error state, not a crash)", () => {
    expect(normalizeScreenerResponse(null)).toBeNull();
    expect(normalizeScreenerResponse("nope")).toBeNull();
    expect(normalizeScreenerResponse({ rows: "nope" })).toBeNull();
    expect(normalizeScreenerResponse({ marketState: "regular" })).toBeNull();
  });

  it("OLD payload without supportLevels -> [] (no crash, renders '—')", () => {
    const normalized = normalizeScreenerResponse(OLD_PRODUCTION_PAYLOAD);
    expect(normalized).not.toBeNull();
    for (const row of normalized!.rows) {
      expect(row.supportLevels).toEqual([]);
    }
  });

  it("malformed supportLevels are filtered out safely", () => {
    const row = normalizeScreenerRow({
      supportLevels: [
        { level: 1, price: 635, method: "manual", asOf: "2026-08-03", triggered: true },
        { level: 5, price: 100, method: "manual", asOf: "2026-08-03", triggered: true }, // invalid level
        { level: 2, price: -10, method: "manual", asOf: "2026-08-03", triggered: false }, // invalid price
        "garbage",
        null,
      ],
    } as Record<string, unknown> as never);
    expect(row.supportLevels).toHaveLength(1);
    expect(row.supportLevels[0]!.level).toBe(1);
  });

  it("supportLevels are sorted S1->S4 and de-duplicated", () => {
    const row = normalizeScreenerRow({
      supportLevels: [
        { level: 3, price: 532, method: "manual", asOf: "2026-08-03", triggered: true },
        { level: 1, price: 635, method: "manual", asOf: "2026-08-03", triggered: true },
        { level: 2, price: 580, method: "manual", asOf: "2026-08-03", triggered: true },
        { level: 1, price: 999, method: "manual", asOf: "2026-08-03", triggered: false }, // duplicate level
      ],
    } as Record<string, unknown> as never);
    expect(row.supportLevels.map((s) => s.level)).toEqual([1, 2, 3]);
    expect(row.supportLevels[0]!.price).toBe(635); // first valid wins
  });

  it("passes valid supportLevels through unchanged", () => {
    const modern = normalizeScreenerResponse({
      ...OLD_PRODUCTION_PAYLOAD,
      rows: [{
        ...OLD_PRODUCTION_PAYLOAD.rows[0]!,
        supportLevels: [
          { level: 1, price: 635, method: "manual", asOf: "2026-08-03", triggered: true },
          { level: 2, price: 580, method: "manual", asOf: "2026-08-03", triggered: false },
        ],
      }],
    });
    const row = modern!.rows[0]!;
    expect(row.supportLevels).toHaveLength(2);
    expect(row.supportLevels[0]!.triggered).toBe(true);
    expect(row.supportLevels[1]!.triggered).toBe(false);
  });

  it("OLD payload without intrinsicValue -> null (no crash)", () => {
    const normalized = normalizeScreenerResponse(OLD_PRODUCTION_PAYLOAD);
    expect(normalized).not.toBeNull();
    for (const row of normalized!.rows) {
      expect(row.intrinsicValue).toBeNull();
    }
  });

  it("malformed intrinsicValue is treated defensively", () => {
    const row = normalizeScreenerRow({
      intrinsicValue: { low: null, base: -10, high: null, method: "manual", asOf: "2026-08-03", distancePct: null },
    } as never);
    expect(row.intrinsicValue).toBeNull();
  });

  it("valid intrinsicValue passes through unchanged", () => {
    const row = normalizeScreenerRow({
      intrinsicValue: { low: null, base: 251.12, high: null, method: "manual", asOf: "2026-08-03", distancePct: -20 },
    } as never);
    expect(row.intrinsicValue).not.toBeNull();
    expect(row.intrinsicValue!.base).toBe(251.12);
    expect(row.intrinsicValue!.distancePct).toBe(-20);
  });

  it("logoUrl passes through when present", () => {
    const row = normalizeScreenerRow({
      logoUrl: "https://example.com/logo.png",
    } as never);
    expect(row.logoUrl).toBe("https://example.com/logo.png");
  });

  it("logoUrl is null when missing (old payload)", () => {
    const row = normalizeScreenerRow({} as never);
    expect(row.logoUrl).toBeNull();
  });

  it("logoUrl is null when empty string", () => {
    const row = normalizeScreenerRow({ logoUrl: "" } as never);
    expect(row.logoUrl).toBeNull();
  });
});
