import { describe, expect, it } from "vitest";
import {
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

  it("uses the versioned Core set without index-derived membership", () => {
    expect(EARNINGS_UNIVERSE_VERSION).toBe(1);
    expect(EARNINGS_UNIVERSE_SYMBOLS.size).toBe(50);
    const symbols = [...EARNINGS_UNIVERSE_SYMBOLS];
    expect(symbols).toEqual([...symbols].sort((left, right) => left.localeCompare(right)));
    expect(symbols.every((symbol) => /^[A-Z][A-Z0-9-]{0,11}$/.test(symbol))).toBe(true);
    expect(symbols).toEqual(expect.arrayContaining(["NVDA", "MSFT", "MU", "SNDK", "TSM", "ASML", "UNH", "NVO"]));
  });

  it("checks membership case-insensitively and normalizes dot tickers first", () => {
    expect(isInEarningsUniverse("NVDA")).toBe(true);
    expect(isInEarningsUniverse("nvda")).toBe(true);
    expect(isInEarningsUniverse("ZZZZ-not-a-real-ticker")).toBe(false);
    expect(isInEarningsUniverse("ABNB")).toBe(false);
  });

  it("exposes the Core version", () => {
    expect(EARNINGS_UNIVERSE_VERSION).toBe(1);
  });
});
