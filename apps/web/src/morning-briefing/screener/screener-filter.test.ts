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
