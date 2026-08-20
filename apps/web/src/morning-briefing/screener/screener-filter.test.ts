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

describe("Screener SMA200W filters (PR2)", () => {
  it("filters Above / Near / Below by sma200wState", () => {
    const rows = [
      row({ symbol: "ABOVE", sma200wState: "Above", distanceToSma200wPct: 8.2 }),
      row({ symbol: "NEAR", sma200wState: "Near", distanceToSma200wPct: 1.4 }),
      row({ symbol: "BELOW", sma200wState: "Below", distanceToSma200wPct: -4.0 }),
      row({ symbol: "NOHIST", sma200wState: "NotEnoughHistory", distanceToSma200wPct: null }),
      row({ symbol: "NODATA", sma200wState: "Unavailable", distanceToSma200wPct: null }),
    ];
    expect(applyScreenerQuery(rows, query({ filter: "above" })).map((r) => r.symbol)).toEqual(["ABOVE"]);
    expect(applyScreenerQuery(rows, query({ filter: "near" })).map((r) => r.symbol)).toEqual(["NEAR"]);
    expect(applyScreenerQuery(rows, query({ filter: "below" })).map((r) => r.symbol)).toEqual(["BELOW"]);
  });

  it("combines SMA filter with search and existing gainers/losers", () => {
    const rows = [
      row({ symbol: "UP1", changePct: 3, sma200wState: "Above", distanceToSma200wPct: 5 }),
      row({ symbol: "UP2", changePct: 3, sma200wState: "Below", distanceToSma200wPct: -5 }),
      row({ symbol: "DN1", changePct: -2, sma200wState: "Above", distanceToSma200wPct: 6 }),
    ];
    expect(applyScreenerQuery(rows, query({ filter: "gainers" })).map((r) => r.symbol)).toEqual(["UP1", "UP2"]);
    expect(applyScreenerQuery(rows, query({ filter: "above", search: "up" })).map((r) => r.symbol)).toEqual(["UP1"]);
  });
});

describe("Screener SMA200W sorting (PR2)", () => {
  const smaRows = [
    row({ symbol: "PLUS3", distanceToSma200wPct: 3.0, sma200wState: "Near" }),
    row({ symbol: "PLUS12", distanceToSma200wPct: 12.4, sma200wState: "Above" }),
    row({ symbol: "MINUS4", distanceToSma200wPct: -3.9, sma200wState: "Below" }),
    row({ symbol: "PLUS1_7", distanceToSma200wPct: 1.7, sma200wState: "Near" }),
    row({ symbol: "NOVAL", distanceToSma200wPct: null, sma200wState: "Unavailable" }),
  ];

  it("closest to 200W sorts by ABS(distance) ascending, nulls last", () => {
    expect(applyScreenerQuery(smaRows, query({ sortKey: "smaDistance", direction: "asc" })).map((r) => r.symbol))
      .toEqual(["PLUS1_7", "PLUS3", "MINUS4", "PLUS12", "NOVAL"]);
  });

  it("smaDistance desc sorts by ABS(distance) descending, nulls last", () => {
    expect(applyScreenerQuery(smaRows, query({ sortKey: "smaDistance", direction: "desc" })).map((r) => r.symbol))
      .toEqual(["PLUS12", "MINUS4", "PLUS3", "PLUS1_7", "NOVAL"]);
  });

  it("furthest above sorts raw distance descending (fixed direction)", () => {
    expect(applyScreenerQuery(smaRows, query({ sortKey: "smaAbove", direction: "desc" })).map((r) => r.symbol))
      .toEqual(["PLUS12", "PLUS3", "PLUS1_7", "MINUS4", "NOVAL"]);
  });

  it("furthest below sorts raw distance ascending (fixed direction)", () => {
    expect(applyScreenerQuery(smaRows, query({ sortKey: "smaBelow", direction: "asc" })).map((r) => r.symbol))
      .toEqual(["MINUS4", "PLUS1_7", "PLUS3", "PLUS12", "NOVAL"]);
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
