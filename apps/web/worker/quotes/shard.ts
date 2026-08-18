import { QUOTES_SHARD_COUNT, QUOTES_SYMBOLS_PER_SHARD } from "./budget";

/**
 * Deterministic sharding of the Core Universe for the per-minute quote job.
 *
 * The canonical universe is already lexicographically sorted; chunking into
 * QUOTES_SHARD_COUNT contiguous slices of QUOTES_SYMBOLS_PER_SHARD yields
 * 5 shards × 10 symbols with no duplication and no loss. Adding or removing
 * a universe symbol reshuffles shards deterministically — the algorithm never
 * depends on insertion order.
 */
export function shardUniverse(
  symbols: readonly string[],
  shardCount = QUOTES_SHARD_COUNT,
  perShard = QUOTES_SYMBOLS_PER_SHARD,
): string[][] {
  if (shardCount <= 0 || perShard <= 0) throw new Error("invalid shard configuration");
  const sorted = [...symbols].sort();
  const shards: string[][] = Array.from({ length: shardCount }, () => []);
  for (let index = 0; index < sorted.length; index += 1) {
    shards[Math.floor(index / perShard)]?.push(sorted[index]!);
  }
  return shards;
}

/**
 * Pick the shard to process for a given instant. Based on UTC epoch minutes
 * so the rotation continues deterministically across DST transitions and
 * market-closed gaps; consecutive in-session minutes cycle 0..4, refreshing
 * every symbol about once every five minutes.
 */
export function shardIndexForMinute(epochMs: number, shardCount = QUOTES_SHARD_COUNT): number {
  if (!Number.isFinite(epochMs) || shardCount <= 0) throw new Error("invalid shard index input");
  return Math.floor(Math.floor(epochMs / 60_000) % shardCount) % shardCount;
}
