import { describe, expect, it } from "vitest";
import { intrinsicValueRowSchema, screenerIntrinsicValueSchema, screenerRowSchema } from "@stock-autotrader/contracts";

describe("intrinsicValueRowSchema (D1 row)", () => {
  it("accepts valid row with null low/high", () => {
    expect(intrinsicValueRowSchema.safeParse({
      symbol: "AAPL",
      method: "manual",
      low_value: null,
      base_value: 251.12,
      high_value: null,
      as_of_date: "2026-08-03",
    }).success).toBe(true);
  });

  it("accepts valid row with all values", () => {
    expect(intrinsicValueRowSchema.safeParse({
      symbol: "AAPL",
      method: "manual",
      low_value: 200,
      base_value: 251.12,
      high_value: 300,
      as_of_date: "2026-08-03",
    }).success).toBe(true);
  });

  it("rejects low > base", () => {
    expect(intrinsicValueRowSchema.safeParse({
      symbol: "AAPL",
      method: "manual",
      low_value: 300,
      base_value: 251.12,
      high_value: null,
      as_of_date: "2026-08-03",
    }).success).toBe(false);
  });

  it("rejects base > high", () => {
    expect(intrinsicValueRowSchema.safeParse({
      symbol: "AAPL",
      method: "manual",
      low_value: null,
      base_value: 251.12,
      high_value: 200,
      as_of_date: "2026-08-03",
    }).success).toBe(false);
  });

  it("rejects negative base", () => {
    expect(intrinsicValueRowSchema.safeParse({
      symbol: "AAPL",
      method: "manual",
      low_value: null,
      base_value: -10,
      high_value: null,
      as_of_date: "2026-08-03",
    }).success).toBe(false);
  });
});

describe("screenerIntrinsicValueSchema (Screener row)", () => {
  it("accepts valid IV with distancePct", () => {
    expect(screenerIntrinsicValueSchema.safeParse({
      low: null,
      base: 251.12,
      high: null,
      method: "manual",
      asOf: "2026-08-03",
      distancePct: -20,
    }).success).toBe(true);
  });

  it("accepts null distancePct", () => {
    expect(screenerIntrinsicValueSchema.safeParse({
      low: null,
      base: 251.12,
      high: null,
      method: "manual",
      asOf: "2026-08-03",
      distancePct: null,
    }).success).toBe(true);
  });

  it("rejects low > base", () => {
    expect(screenerIntrinsicValueSchema.safeParse({
      low: 300,
      base: 251.12,
      high: null,
      method: "manual",
      asOf: "2026-08-03",
      distancePct: null,
    }).success).toBe(false);
  });
});

describe("screenerRowSchema — intrinsicValue field", () => {
  function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      symbol: "AAPL",
      company: "Apple Inc.",
      price: 232.5,
      changeAbs: 1.2,
      changePct: 0.52,
      dayHigh: 234.0,
      dayLow: 230.0,
      dayOpen: 231.0,
      previousClose: 231.3,
      provider: "finnhub-websocket",
      asOf: "2026-08-19T15:00:00.000Z",
      updatedAt: "2026-08-19T15:00:00.000Z",
      state: "Live",
      sma200w: 200.0,
      distanceToSma200wPct: 3.0,
      sma200wState: "Near",
      sma200wHistoryWeeks: 1200,
      sma200wAsOf: "2026-08-19T06:00:00.000Z",
      supportLevels: [],
      intrinsicValue: null,
      logoUrl: null,
      ...overrides,
    };
  }

  it("accepts null intrinsicValue", () => {
    expect(screenerRowSchema.safeParse(row()).success).toBe(true);
  });

  it("accepts valid intrinsicValue", () => {
    expect(screenerRowSchema.safeParse(row({
      intrinsicValue: {
        low: null,
        base: 251.12,
        high: null,
        method: "manual",
        asOf: "2026-08-03",
        distancePct: -20,
      },
    })).success).toBe(true);
  });

  it("rejects malformed intrinsicValue (base <= 0)", () => {
    expect(screenerRowSchema.safeParse(row({
      intrinsicValue: {
        low: null,
        base: 0,
        high: null,
        method: "manual",
        asOf: "2026-08-03",
        distancePct: null,
      },
    })).success).toBe(false);
  });
});
