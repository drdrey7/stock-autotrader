import { describe, expect, it } from "vitest";
import {
  CORE_UNIVERSE,
  CORE_UNIVERSE_SYMBOLS,
  CORE_UNIVERSE_VERSION,
  isCoreUniverseSymbol,
  validateCoreUniverseConfig,
} from "@stock-autotrader/contracts";

describe("Core Universe v1 configuration", () => {
  it("contains exactly 50 unique normalized symbols at the expected version", () => {
    expect(CORE_UNIVERSE_VERSION).toBe(1);
    expect(CORE_UNIVERSE).toHaveLength(50);
    expect([...CORE_UNIVERSE_SYMBOLS]).toHaveLength(50);
    expect(CORE_UNIVERSE).toEqual([...CORE_UNIVERSE].sort((left, right) => left < right ? -1 : left > right ? 1 : 0));
    expect(CORE_UNIVERSE.every((symbol) => /^[A-Z][A-Z0-9-]{0,11}$/.test(symbol))).toBe(true);
  });

  it.each(["NVDA", "MSFT", "MU", "SNDK", "TSM", "ASML", "UNH", "NVO"])(
    "includes required Core symbol %s",
    (symbol) => expect(isCoreUniverseSymbol(symbol)).toBe(true),
  );

  it("does not treat an old index-only member as Core", () => {
    expect(isCoreUniverseSymbol("ABNB")).toBe(false);
    expect(isCoreUniverseSymbol("abnb")).toBe(false);
  });

  it("rejects malformed configuration instead of normalizing it", () => {
    expect(() => validateCoreUniverseConfig({ version: 1, symbols: ["NVDA", "nvda"] })).toThrow(/exactly 50/);
    expect(() => validateCoreUniverseConfig({ version: 2, symbols: ["NVDA", "nvda"] })).toThrow(/normalized ticker/);
    expect(() => validateCoreUniverseConfig({ version: 2, symbols: ["NVDA", "NVDA"] })).toThrow(/unique/);
    expect(() => validateCoreUniverseConfig({ version: 0, symbols: [] })).toThrow(/positive integer/);
    expect(() => validateCoreUniverseConfig({ version: 2, symbols: ["NVDA"], extra: true })).toThrow(/only version and symbols/);
  });
});
