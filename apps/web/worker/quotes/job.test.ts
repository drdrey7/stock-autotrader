import { describe, expect, it, vi } from "vitest";
import type { Env } from "../index";
import type { QuoteObservation } from "@stock-autotrader/contracts";
import type { QuoteResult } from "./provider";
import { CORE_UNIVERSE } from "@stock-autotrader/contracts";
import { runQuotesShardJob } from "./job";
import { QUOTES_HEALTH_META_KEY } from "./health";
import { shardIndexForMinute, shardUniverse } from "./shard";

const fakeObservation = (symbol: string, collectedAt: string): QuoteObservation => ({
  symbol,
  price: 100,
  changeAbs: 1,
  changePct: 1,
  dayHigh: 101,
  dayLow: 99,
  dayOpen: 99.5,
  previousClose: 99,
  asOf: collectedAt,
  provider: "fake-quote",
});

function createProvider(options: { fail?: Set<string>; throwAll?: boolean } = {}) {
  return {
    name: "fake-quote",
    collect: vi.fn(async (symbols: readonly string[], collectedAt: string): Promise<QuoteResult> => {
      if (options.throwAll) throw new Error("provider down");
      const failed = options.fail ?? new Set<string>();
      return {
        observations: symbols.filter((symbol) => !failed.has(symbol))
          .map((symbol) => fakeObservation(symbol, collectedAt)),
        warnings: [...symbols].filter((symbol) => failed.has(symbol)).map((symbol) => `${symbol}: HTTP 500`),
        rateLimited: false,
      };
    }),
  };
}

function createJobDb(options: { throwOnBatch?: boolean } = {}) {
  const meta = new Map<string, string>();
  const latest = new Map<string, unknown>();
  return {
    meta,
    latest,
    prepare(sql: string) {
      let args: unknown[] = [];
      const statement = {
        bind(...values: unknown[]) {
          args = values;
          return statement;
        },
        async first<T>(): Promise<T | null> {
          if (sql.includes("SELECT value FROM app_meta")) {
            const key = String(args[0] ?? "");
            return { value: key === QUOTES_HEALTH_META_KEY ? (meta.get(key) ?? null) : null } as T;
          }
          return null;
        },
        async run(): Promise<{ meta: { changes: number } }> {
          if (sql.includes("INSERT INTO app_meta")) {
            const [key, value] = args as [string, string];
            meta.set(key, value);
            return { meta: { changes: 1 } };
          }
          if (sql.includes("INSERT INTO latest_quotes")) {
            latest.set(String(args[0]), true);
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        },
        async all<T>(): Promise<{ results: T[] }> {
          return { results: [] as T[] };
        },
      };
      return statement;
    },
    async batch(statements: Array<{ run(): Promise<{ meta: { changes: number } }> }>): Promise<Array<{ meta: { changes: number } }>> {
      if (options.throwOnBatch) throw new Error("D1 batch unavailable");
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    },
  };
}

const envFrom = (db: ReturnType<typeof createJobDb>, key?: string): Env => ({
  DB: db as unknown as Env["DB"],
  ...(key === undefined ? {} : { FINNHUB_API_KEY: key }),
  ENVIRONMENT: "production",
} as unknown as Env);

const REGULAR = new Date("2026-08-13T14:00:00Z"); // Thursday 10:00 ET
const SATURDAY = new Date("2026-08-15T14:00:00Z");

describe("runQuotesShardJob", () => {
  it("is a no-op when the market is closed (no requests, no writes)", async () => {
    const db = createJobDb();
    const provider = createProvider();
    const result = await runQuotesShardJob(envFrom(db), SATURDAY, provider);
    expect(result.status).toBe("skipped");
    expect(result.detail).toBe("market_closed");
    expect(provider.collect).not.toHaveBeenCalled();
    expect(db.meta.size).toBe(0);
  });

  it("processes exactly the deterministic shard for the invocation minute", async () => {
    const db = createJobDb();
    const provider = createProvider();
    const result = await runQuotesShardJob(envFrom(db, "test-key"), REGULAR, provider);
    expect(result.status).toBe("ok");

    const shardIndex = shardIndexForMinute(REGULAR.getTime());
    const expected = shardUniverse(CORE_UNIVERSE)[shardIndex];
    expect(provider.collect).toHaveBeenCalledTimes(1);
    expect(provider.collect.mock.calls[0]![0]).toEqual(expected);
    expect(expected).toHaveLength(10);
    expect(db.latest.size).toBe(10);

    const health = JSON.parse(db.meta.get(QUOTES_HEALTH_META_KEY)!) as { status: string; lastShard: number; lastSuccessAt: string; rowsWritten: number; rateLimited: boolean };
    expect(health.status).toBe("ok");
    expect(health.lastShard).toBe(shardIndex);
    expect(health.rowsWritten).toBe(10);
    expect(health.rateLimited).toBe(false);
    expect(health.lastSuccessAt).toBe(REGULAR.toISOString());
  });

  it("keeps the valid quotes and degrades on a partial shard failure", async () => {
    const db = createJobDb();
    const shard = shardUniverse(CORE_UNIVERSE)[shardIndexForMinute(REGULAR.getTime())]!;
    const provider = createProvider({ fail: new Set([shard[0]!]) });
    const result = await runQuotesShardJob(envFrom(db, "test-key"), REGULAR, provider);
    expect(result.status).toBe("degraded");
    expect(db.latest.size).toBe(9);
    const health = JSON.parse(db.meta.get(QUOTES_HEALTH_META_KEY)!) as { status: string; lastError: string | null; rowsWritten: number };
    expect(health.status).toBe("degraded");
    expect(health.rowsWritten).toBe(9);
    expect(health.lastError).toContain(shard[0]);
  });

  it("degrades cleanly when the provider throws and keeps last-known-good", async () => {
    const db = createJobDb();
    const provider = createProvider({ throwAll: true });
    const result = await runQuotesShardJob(envFrom(db, "test-key"), REGULAR, provider);
    expect(result.status).toBe("degraded");
    expect(result.detail).toContain("provider down");
    expect(db.latest.size).toBe(0);
    const health = JSON.parse(db.meta.get(QUOTES_HEALTH_META_KEY)!) as { status: string; lastError: string; lastSuccessAt: string | null };
    expect(health.status).toBe("degraded");
    expect(health.lastError).toContain("provider down");
    expect(health.lastSuccessAt).toBeNull();
  });

  it("degrades gracefully and persists degraded health when the key is missing and no provider is injected", async () => {
    const db = createJobDb();
    const result = await runQuotesShardJob(envFrom(db, undefined), REGULAR);
    expect(result.status).toBe("degraded");
    expect(db.latest.size).toBe(0);
    const health = JSON.parse(db.meta.get(QUOTES_HEALTH_META_KEY)!) as { status: string; lastError: string; lastShard: number };
    expect(health.status).toBe("degraded");
    expect(health.lastError).toContain("FINNHUB_API_KEY is not configured");
    expect(health.lastShard).toBe(shardIndexForMinute(REGULAR.getTime()));
  });

  it("treats a whitespace-only key like a missing key (no unhandled rejection)", async () => {
    const db = createJobDb();
    const result = await runQuotesShardJob(envFrom(db, "   "), REGULAR);
    expect(result.status).toBe("degraded");
    expect(db.latest.size).toBe(0);
    const health = JSON.parse(db.meta.get(QUOTES_HEALTH_META_KEY)!) as { status: string; lastError: string };
    expect(health.status).toBe("degraded");
    expect(health.lastError).toContain("FINNHUB_API_KEY is not configured");
  });

  it("runs an injected provider without requiring the Finnhub secret", async () => {
    const db = createJobDb();
    const provider = createProvider();
    const result = await runQuotesShardJob(envFrom(db, undefined), REGULAR, provider);
    expect(result.status).toBe("ok");
    expect(provider.collect).toHaveBeenCalledTimes(1);
    const health = JSON.parse(db.meta.get(QUOTES_HEALTH_META_KEY)!) as { status: string; provider: string };
    expect(health.status).toBe("ok");
    expect(health.provider).toBe("fake-quote");
  });

  it("degrades and keeps health persisted when the D1 upsert fails", async () => {
    const db = createJobDb({ throwOnBatch: true });
    const provider = createProvider();
    const result = await runQuotesShardJob(envFrom(db, "test-key"), REGULAR, provider);
    expect(result.status).toBe("degraded");
    expect(result.detail).toContain("D1 batch unavailable");
    const health = JSON.parse(db.meta.get(QUOTES_HEALTH_META_KEY)!) as { status: string; lastError: string };
    expect(health.status).toBe("degraded");
    expect(health.lastError).toContain("D1 batch unavailable");
  });
});
