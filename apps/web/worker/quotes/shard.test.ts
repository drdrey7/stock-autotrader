import { describe, expect, it } from "vitest";
import { CORE_UNIVERSE } from "@stock-autotrader/contracts";
import { QUOTES_SHARD_COUNT, QUOTES_SYMBOLS_PER_SHARD } from "./budget";
import { shardIndexForMinute, shardUniverse } from "./shard";

describe("deterministic quote sharding", () => {
  it("partitions the canonical universe into 10 shards × 5 with no loss or duplication", () => {
    const shards = shardUniverse(CORE_UNIVERSE);
    expect(shards).toHaveLength(QUOTES_SHARD_COUNT);
    expect(CORE_UNIVERSE).toHaveLength(50);
    for (const shard of shards) {
      expect(shard).toHaveLength(QUOTES_SYMBOLS_PER_SHARD);
    }
    const all = shards.flat();
    expect(new Set(all).size).toBe(50);
    expect([...all].sort()).toEqual([...CORE_UNIVERSE].sort());
  });

  it("is deterministic across calls", () => {
    expect(shardUniverse(CORE_UNIVERSE)).toEqual(shardUniverse(CORE_UNIVERSE));
  });

  it("cycles shard indexes 0..9 by UTC epoch minute", () => {
    expect(shardIndexForMinute(0)).toBe(0);
    expect(shardIndexForMinute(60_000)).toBe(1);
    expect(shardIndexForMinute(60_000 * 9)).toBe(9);
    expect(shardIndexForMinute(60_000 * 10)).toBe(0);
    // A fixed Thursday 10:00 ET instant (2026-08-13T14:00:00Z).
    const instant = Date.parse("2026-08-13T14:00:00Z");
    expect(shardIndexForMinute(instant)).toBe(Math.floor(Math.floor(instant / 60_000) % 10));
    // One minute later advances to the next shard (wrapping at 10).
    expect(shardIndexForMinute(instant + 60_000)).toBe((shardIndexForMinute(instant) + 1) % 10);
  });

  it("shards are always subsets of the canonical universe", () => {
    for (const shard of shardUniverse(CORE_UNIVERSE)) {
      for (const symbol of shard) {
        expect(CORE_UNIVERSE).toContain(symbol);
      }
    }
  });

  it("covers US-listed ADRs and cross-listed symbols via canonical tickers (FASE 4/5)", () => {
    // TSM and NVO are NYSE ADRs; ASML is a NASDAQ US listing; NVDA NASDAQ.
    // All must be canonical Core members, present exactly once across the
    // shards, in the US-equity session — never treated as exchange-specific.
    const adrs = ["TSM", "NVO", "ASML", "NVDA"];
    for (const symbol of adrs) {
      expect(CORE_UNIVERSE).toContain(symbol);
    }
    const shards = shardUniverse(CORE_UNIVERSE);
    const flattened = shards.flat();
    for (const symbol of adrs) {
      expect(flattened.filter((candidate) => candidate === symbol)).toHaveLength(1);
      const shardIndex = shards.findIndex((shard) => shard.includes(symbol));
      expect(shardIndex).toBeGreaterThanOrEqual(0);
      expect(shards[shardIndex]).toHaveLength(5);
    }
  });
});
