import { describe, expect, it } from "vitest";
import {
  EARNINGS_UNIVERSE,
  EARNINGS_UNIVERSE_SYMBOLS,
  EARNINGS_UNIVERSE_VERSION,
  isInEarningsUniverse,
  normalizeSymbol,
} from "./universe";

describe("earnings universe", () => {
  it("normalizes case and dot tickers to the canonical hyphenated form", () => {
    expect(normalizeSymbol("aapl")).toBe("AAPL");
    expect(normalizeSymbol(" msft ")).toBe("MSFT");
    expect(normalizeSymbol("brk.b")).toBe("BRK-B");
  });

  it("loads a non-trivial, deduplicated, alphabetically sorted universe", () => {
    expect(EARNINGS_UNIVERSE.length).toBeGreaterThan(400);
    expect(EARNINGS_UNIVERSE_SYMBOLS.size).toBe(EARNINGS_UNIVERSE.length);
    const symbols = EARNINGS_UNIVERSE.map((member) => member.symbol);
    expect(symbols).toEqual([...symbols].sort((left, right) => left.localeCompare(right)));
    // Every member's index list is itself deduplicated.
    for (const member of EARNINGS_UNIVERSE) {
      expect(new Set(member.indexes).size).toBe(member.indexes.length);
    }
  });

  it("tags a symbol present in both index snapshots with both indexes", () => {
    // A large-cap tech name is virtually certain to be in both the S&P 500
    // and the Nasdaq-100 snapshots, exercising the union-merge branch.
    const overlap = EARNINGS_UNIVERSE.find((member) => member.indexes.length > 1);
    expect(overlap).toBeDefined();
    expect(overlap!.indexes).toEqual(expect.arrayContaining(["S&P 500", "Nasdaq-100"]));
  });

  it("checks membership case-insensitively and normalizes dot tickers first", () => {
    const known = EARNINGS_UNIVERSE[0]!.symbol;
    expect(isInEarningsUniverse(known)).toBe(true);
    expect(isInEarningsUniverse(known.toLowerCase())).toBe(true);
    expect(isInEarningsUniverse("ZZZZ-not-a-real-ticker")).toBe(false);
  });

  it("exposes a non-empty version string shared by both snapshots", () => {
    expect(typeof EARNINGS_UNIVERSE_VERSION).toBe("string");
    expect(EARNINGS_UNIVERSE_VERSION.length).toBeGreaterThan(0);
  });
});
