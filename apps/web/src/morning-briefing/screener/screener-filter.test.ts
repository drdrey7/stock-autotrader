import { describe, expect, it } from "vitest";
import type { ScreenerRow } from "@stock-autotrader/contracts";
import { applyScreenerQuery, DEFAULT_SCREENER_QUERY, type ScreenerQuery } from "./screener-filter";

const row = (overrides: Partial<ScreenerRow>): ScreenerRow => ({
  symbol: "AAA",
  company: "A Co",
  price: 100,
  changeAbs: 1,
  changePct: 1,
  dayHigh: null,
  dayLow: null,
  dayOpen: null,
  previousClose: null,
  provider: "finnhub-quote",
  asOf: "2026-08-13T14:00:00.000Z",
  updatedAt: "2026-08-13T14:00:00.000Z",
  state: "Live",
  sma200w: null,
  distanceToSma200wPct: null,
  sma200wState: "Unavailable",
  sma200wHistoryWeeks: null,
  sma200wAsOf: null,
  supportLevels: [],
  intrinsicValue: null,
  logoUrl: null,
  ...overrides,
});

const query = (partial: Partial<ScreenerQuery>): ScreenerQuery => ({ ...DEFAULT_SCREENER_QUERY, ...partial });

describe("Screener filter/sort logic", () => {
  it("filters gainers and losers by daily % change", () => {
    const rows = [
      row({ symbol: "UP", changePct: 2.5 }),
      row({ symbol: "FLAT", changePct: 0 }),
      row({ symbol: "DOWN", changePct: -3.1 }),
      row({ symbol: "NONE", changePct: null }),
    ];
    expect(applyScreenerQuery(rows, query({ filter: "gainers" })).map((r) => r.symbol)).toEqual(["UP"]);
    expect(applyScreenerQuery(rows, query({ filter: "losers" })).map((r) => r.symbol)).toEqual(["DOWN"]);
    expect(applyScreenerQuery(rows, query({ filter: "all" }))).toHaveLength(4);
  });

  it("searches ticker and company case-insensitively", () => {
    const rows = [
      row({ symbol: "AAPL", company: "Apple Inc." }),
      row({ symbol: "MSFT", company: "Microsoft Corp" }),
    ];
    expect(applyScreenerQuery(rows, query({ search: "aapl" })).map((r) => r.symbol)).toEqual(["AAPL"]);
    expect(applyScreenerQuery(rows, query({ search: "MICROSOFT" })).map((r) => r.symbol)).toEqual(["MSFT"]);
    expect(applyScreenerQuery(rows, query({ search: "zzz" }))).toHaveLength(0);
  });

  it("sorts numeric columns with nulls always last", () => {
    const rows = [
      row({ symbol: "NULL", price: null, changePct: null }),
      row({ symbol: "LOW", price: 10, changePct: 2 }),
      row({ symbol: "HIGH", price: 20, changePct: 5 }),
    ];
    expect(applyScreenerQuery(rows, query({ sortKey: "price", direction: "desc" })).map((r) => r.symbol))
      .toEqual(["HIGH", "LOW", "NULL"]);
    expect(applyScreenerQuery(rows, query({ sortKey: "price", direction: "asc" })).map((r) => r.symbol))
      .toEqual(["LOW", "HIGH", "NULL"]);
    expect(applyScreenerQuery(rows, query({ sortKey: "changePct", direction: "desc" })).map((r) => r.symbol))
      .toEqual(["HIGH", "LOW", "NULL"]);
  });

  it("sorts symbol ascending and descending", () => {
    const rows = [row({ symbol: "B" }), row({ symbol: "A" }), row({ symbol: "C" })];
    expect(applyScreenerQuery(rows, query({ sortKey: "symbol", direction: "asc" })).map((r) => r.symbol))
      .toEqual(["A", "B", "C"]);
    expect(applyScreenerQuery(rows, query({ sortKey: "symbol", direction: "desc" })).map((r) => r.symbol))
      .toEqual(["C", "B", "A"]);
  });

  it("sorts Company by company name with symbol fallback and tie-break", () => {
    const rows = [
      row({ symbol: "GOOG", company: "Alphabet Inc." }),
      row({ symbol: "AMZN", company: "Amazon.com, Inc." }),
      row({ symbol: "AAPL", company: "Apple Inc." }),
      row({ symbol: "ZZZ", company: null }),
      row({ symbol: "AAA", company: "Same Co" }),
      row({ symbol: "BBB", company: "Same Co" }),
    ];
    expect(applyScreenerQuery(rows, query({ sortKey: "company", direction: "asc" })).map((item) => item.symbol))
      .toEqual(["GOOG", "AMZN", "AAPL", "AAA", "BBB", "ZZZ"]);
    expect(applyScreenerQuery(rows, query({ sortKey: "company", direction: "desc" })).map((item) => item.symbol))
      .toEqual(["ZZZ", "BBB", "AAA", "AAPL", "AMZN", "GOOG"]);
  });

  it("combines search + filter", () => {
    const rows = [
      row({ symbol: "UP1", changePct: 4 }),
      row({ symbol: "UP2", changePct: 2 }),
      row({ symbol: "DN1", changePct: -1 }),
    ];
    expect(applyScreenerQuery(rows, query({ filter: "gainers", search: "up2" })).map((r) => r.symbol))
      .toEqual(["UP2"]);
  });
});

describe("Screener IV filters", () => {
  it("filters Below IV / Above IV by distancePct", () => {
    const rows = [
      row({ symbol: "BEL", intrinsicValue: { low: null, base: 200, high: null, method: "manual", asOf: "2026-08-03", distancePct: -10 } }),
      row({ symbol: "ABV", intrinsicValue: { low: null, base: 200, high: null, method: "manual", asOf: "2026-08-03", distancePct: 15 } }),
      row({ symbol: "ZERO", intrinsicValue: { low: null, base: 200, high: null, method: "manual", asOf: "2026-08-03", distancePct: 0 } }),
      row({ symbol: "NULL", intrinsicValue: { low: null, base: 200, high: null, method: "manual", asOf: "2026-08-03", distancePct: null } }),
      row({ symbol: "NOIV", intrinsicValue: null }),
    ];
    expect(applyScreenerQuery(rows, query({ filter: "belowIv" })).map((r) => r.symbol)).toEqual(["BEL"]);
    expect(applyScreenerQuery(rows, query({ filter: "aboveIv" })).map((r) => r.symbol)).toEqual(["ABV"]);
  });
});

describe("Screener SMA200W filters", () => {
  it("filters Above / Near / Below by sma200wState", () => {
    const rows = [
      row({ symbol: "ABOVE", sma200wState: "Above", distanceToSma200wPct: 8.2 }),
      row({ symbol: "NEAR", sma200wState: "Near", distanceToSma200wPct: 1.4 }),
      row({ symbol: "BELOW", sma200wState: "Below", distanceToSma200wPct: -4.0 }),
      row({ symbol: "NOHIST", sma200wState: "NotEnoughHistory", distanceToSma200wPct: null }),
      row({ symbol: "NODATA", sma200wState: "Unavailable", distanceToSma200wPct: null }),
    ];
    expect(applyScreenerQuery(rows, query({ filter: "above200w" })).map((r) => r.symbol)).toEqual(["ABOVE"]);
    expect(applyScreenerQuery(rows, query({ filter: "near200w" })).map((r) => r.symbol)).toEqual(["NEAR"]);
    expect(applyScreenerQuery(rows, query({ filter: "below200w" })).map((r) => r.symbol)).toEqual(["BELOW"]);
  });
});

describe("Screener Support filters", () => {
  it("Below Support: any triggered support", () => {
    const rows = [
      // Case A: no supports -> excluded
      row({ symbol: "NONE", supportLevels: [], price: 500 }),
      // Case B: 1 support triggered -> included
      row({ symbol: "S1T", price: 500, supportLevels: [
        { level: 1, price: 600, method: "manual", asOf: "2026-08-03", triggered: true },
      ]}),
      // Case C: mixed true/false -> included
      row({ symbol: "MIX", price: 500, supportLevels: [
        { level: 1, price: 600, method: "manual", asOf: "2026-08-03", triggered: true },
        { level: 2, price: 550, method: "manual", asOf: "2026-08-03", triggered: false },
      ]}),
      // Case E: triggered null (no price) -> excluded
      row({ symbol: "NULLTRIG", price: null, supportLevels: [
        { level: 1, price: 600, method: "manual", asOf: "2026-08-03", triggered: null },
      ]}),
    ];
    expect(applyScreenerQuery(rows, query({ filter: "belowSupport" })).map((r) => r.symbol)).toEqual(["S1T", "MIX"]);
  });

  it("Above Support: all supports false (none triggered)", () => {
    const rows = [
      // No supports -> excluded
      row({ symbol: "NONE", supportLevels: [], price: 500 }),
      // All false -> included
      row({ symbol: "ALLF", price: 500, supportLevels: [
        { level: 1, price: 400, method: "manual", asOf: "2026-08-03", triggered: false },
        { level: 2, price: 350, method: "manual", asOf: "2026-08-03", triggered: false },
      ]}),
      // One true -> excluded
      row({ symbol: "ONET", price: 500, supportLevels: [
        { level: 1, price: 600, method: "manual", asOf: "2026-08-03", triggered: true },
        { level: 2, price: 350, method: "manual", asOf: "2026-08-03", triggered: false },
      ]}),
      // Mixed null/false (price unavailable) -> excluded
      row({ symbol: "NULLF", price: null, supportLevels: [
        { level: 1, price: 400, method: "manual", asOf: "2026-08-03", triggered: null },
        { level: 2, price: 350, method: "manual", asOf: "2026-08-03", triggered: false },
      ]}),
    ];
    expect(applyScreenerQuery(rows, query({ filter: "aboveSupport" })).map((r) => r.symbol)).toEqual(["ALLF"]);
  });
});

describe("Screener sorting", () => {
  it("sorts by IV base value with nulls last", () => {
    const rows = [
      row({ symbol: "A", intrinsicValue: { low: null, base: 300, high: null, method: "manual", asOf: "2026-08-03", distancePct: null } }),
      row({ symbol: "B", intrinsicValue: { low: null, base: 100, high: null, method: "manual", asOf: "2026-08-03", distancePct: null } }),
      row({ symbol: "C", intrinsicValue: null }),
    ];
    expect(applyScreenerQuery(rows, query({ sortKey: "iv", direction: "asc" })).map((r) => r.symbol)).toEqual(["B", "A", "C"]);
    expect(applyScreenerQuery(rows, query({ sortKey: "iv", direction: "desc" })).map((r) => r.symbol)).toEqual(["A", "B", "C"]);
  });

  it("IV Dist: asc = more negative first, desc = more positive first, nulls last", () => {
    const rows = [
      row({ symbol: "NEG", intrinsicValue: { low: null, base: 200, high: null, method: "manual", asOf: "2026-08-03", distancePct: -20 } }),
      row({ symbol: "POS", intrinsicValue: { low: null, base: 200, high: null, method: "manual", asOf: "2026-08-03", distancePct: 30 } }),
      row({ symbol: "ZERO", intrinsicValue: { low: null, base: 200, high: null, method: "manual", asOf: "2026-08-03", distancePct: 0 } }),
      row({ symbol: "NULL", intrinsicValue: { low: null, base: 200, high: null, method: "manual", asOf: "2026-08-03", distancePct: null } }),
    ];
    expect(applyScreenerQuery(rows, query({ sortKey: "ivDistance", direction: "asc" })).map((r) => r.symbol)).toEqual(["NEG", "ZERO", "POS", "NULL"]);
    expect(applyScreenerQuery(rows, query({ sortKey: "ivDistance", direction: "desc" })).map((r) => r.symbol)).toEqual(["POS", "ZERO", "NEG", "NULL"]);
  });

  it("SMA Dist: raw distance (NOT ABS), nulls last", () => {
    const rows = [
      row({ symbol: "A", distanceToSma200wPct: -20 }),
      row({ symbol: "B", distanceToSma200wPct: -2 }),
      row({ symbol: "C", distanceToSma200wPct: 5 }),
      row({ symbol: "D", distanceToSma200wPct: 30 }),
      row({ symbol: "E", distanceToSma200wPct: null }),
    ];
    expect(applyScreenerQuery(rows, query({ sortKey: "smaDistance", direction: "asc" })).map((r) => r.symbol))
      .toEqual(["A", "B", "C", "D", "E"]);
    expect(applyScreenerQuery(rows, query({ sortKey: "smaDistance", direction: "desc" })).map((r) => r.symbol))
      .toEqual(["D", "C", "B", "A", "E"]);
  });

  it("sorts by sma200w value with nulls last", () => {
    const rows = [
      row({ symbol: "A", sma200w: 100 }),
      row({ symbol: "B", sma200w: 220 }),
      row({ symbol: "C", sma200w: null }),
    ];
    expect(applyScreenerQuery(rows, query({ sortKey: "sma200w", direction: "desc" })).map((r) => r.symbol))
      .toEqual(["B", "A", "C"]);
  });
});
