import { describe, expect, it } from "vitest";
import { CORE_UNIVERSE } from "@stock-autotrader/contracts";
import { QUOTES_SHARD_COUNT, QUOTES_SYMBOLS_PER_SHARD } from "./budget";
import { shardIndexForMinute, shardUniverse } from "./shard";

describe("deterministic quote sharding", () => {
  it("partitions the canonical universe into 5 shards × 10 with no loss or duplication", () => {
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

  it("cycles shard indexes 0..4 by UTC epoch minute", () => {
    expect(shardIndexForMinute(0)).toBe(0);
    expect(shardIndexForMinute(60_000)).toBe(1);
    expect(shardIndexForMinute(60_000 * 4)).toBe(4);
    expect(shardIndexForMinute(60_000 * 5)).toBe(0);
    // A fixed Thursday 10:00 ET instant (2026-08-13T14:00:00Z).
    const instant = Date.parse("2026-08-13T14:00:00Z");
    expect(shardIndexForMinute(instant)).toBe(Math.floor(Math.floor(instant / 60_000) % 5));
    // One minute later advances to the next shard.
    expect(shardIndexForMinute(instant + 60_000)).toBe((shardIndexForMinute(instant) + 1) % 5);
  });

  it("shards are always subsets of the canonical universe", () => {
    for (const shard of shardUniverse(CORE_UNIVERSE)) {
      for (const symbol of shard) {
        expect(CORE_UNIVERSE).toContain(symbol);
      }
    }
  });
});
