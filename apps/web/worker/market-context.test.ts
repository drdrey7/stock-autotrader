import { describe, expect, it, vi } from "vitest";
import type { Env } from "./index";
import {
  CnnSentimentProvider,
  FmpMarketDataProvider,
  INDEX_DEFINITIONS,
  isUsMarketHoliday,
  marketCollectionWindow,
  readMarketContext,
  runMarketContextJob,
  runSentimentJob,
  type MarketIndexObservation,
  type SentimentObservation,
} from "./market-context";

type StoredIndex = MarketIndexObservation;

class MemoryD1 {
  readonly indices = new Map<string, StoredIndex>();
  readonly sentiments: SentimentObservation[] = [];
  readonly sql: string[] = [];

  prepare(sql: string) {
    this.sql.push(sql);
    let args: unknown[] = [];
    const statement = {
      bind: (...values: unknown[]) => {
        args = values;
        return statement;
      },
      run: async () => {
        if (sql.includes("market_indices")) {
          const [symbol, name, value, changePct, sourceTimestamp, collectedAt, provider] = args as [
            StoredIndex["symbol"], string, number, number, string, string, string,
          ];
          const key = `${symbol}|${sourceTimestamp}|${provider}`;
          if (!this.indices.has(key)) this.indices.set(key, { symbol, name, value, changePct, sourceTimestamp, collectedAt, provider });
        } else if (sql.includes("market_sentiment")) {
          const [score, rating, sourceTimestamp, collectedAt, provider] = args as [number, SentimentObservation["rating"], string, string, string];
          if (!this.sentiments.some((row) => row.sourceTimestamp === sourceTimestamp && row.provider === provider)) {
            this.sentiments.push({ score, rating, sourceTimestamp, collectedAt, provider });
          }
        }
        return { success: true, meta: { changes: 1 } };
      },
      all: async <T>() => ({
        results: [...this.indices.values()]
          .sort((a, b) => a.sourceTimestamp.localeCompare(b.sourceTimestamp))
          .filter((row, index, rows) => rows.map((candidate) => candidate.symbol).lastIndexOf(row.symbol) === index)
          .map((row) => ({
            symbol: row.symbol,
            name: row.name,
            value: row.value,
            change_pct: row.changePct,
            source_timestamp: row.sourceTimestamp,
            collected_at: row.collectedAt,
            provider: row.provider,
          })) as T[],
      }),
      first: async <T>() => {
        const row = [...this.sentiments].sort((a, b) => b.sourceTimestamp.localeCompare(a.sourceTimestamp))[0];
        return (row ? {
          score: row.score,
          rating: row.rating,
          source_timestamp: row.sourceTimestamp,
          collected_at: row.collectedAt,
          provider: row.provider,
        } : null) as T | null;
      },
    };
    return statement;
  }

  async batch(statements: Array<{ run: () => Promise<unknown> }>) {
    for (const statement of statements) await statement.run();
    return [];
  }
}

const envFor = (db: MemoryD1): Env => ({ DB: db as unknown as D1Database, ASSETS: {} as Fetcher });
const response = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), {
  status,
  headers: { "content-type": "application/json" },
});

const providerRows: Record<string, { price: number; changePercentage: number; timestamp: number }> = {
  "^GSPC": { price: 6427.18, changePercentage: 0.62, timestamp: 1786635000 },
  "^NDX": { price: 23724.31, changePercentage: 0.78, timestamp: 1786635000 },
  "^DJI": { price: 45118.26, changePercentage: 0.48, timestamp: 1786635000 },
  "^VIX": { price: 15.41, changePercentage: -1.26, timestamp: 1786635000 },
};

describe("market context providers and persistence", () => {
  it("normalizes all four FMP index quotes and preserves source timestamps", async () => {
    const provider = new FmpMarketDataProvider("test-key", async (input) => {
      const symbol = new URL(input.toString()).searchParams.get("symbol")!;
      return response([providerRows[symbol]]);
    });

    const result = await provider.collect("2026-08-13T14:45:00.000Z");
    expect(result.warnings).toEqual([]);
    expect(result.observations).toHaveLength(4);
    expect(result.observations.map((row) => row.symbol)).toEqual(["SPX", "NDX", "DJI", "VIX"]);
    expect(result.observations[0]).toMatchObject({
      name: "S&P 500",
      value: 6427.18,
      changePct: 0.62,
      sourceTimestamp: new Date(1786635000 * 1000).toISOString(),
      provider: "financial-modeling-prep",
    });
  });

  it("rejects invalid quotes without preventing valid symbols from being saved", async () => {
    const provider = new FmpMarketDataProvider("test-key", async (input) => {
      const symbol = new URL(input.toString()).searchParams.get("symbol")!;
      return response(symbol === "^VIX" ? [{ price: 0, changePercentage: 1, timestamp: 1786635000 }] : [providerRows[symbol]]);
    });
    const result = await provider.collect("2026-08-13T14:45:00.000Z");
    expect(result.observations).toHaveLength(3);
    expect(result.warnings).toEqual([expect.stringContaining("VIX")]);
  });

  it("keeps the last valid market reading when a later provider run fails", async () => {
    const db = new MemoryD1();
    const goodProvider = {
      collect: async (collectedAt: string) => ({
        observations: INDEX_DEFINITIONS.map((definition) => ({
          symbol: definition.symbol,
          name: definition.name,
          value: providerRows[definition.providerSymbol]!.price,
          changePct: providerRows[definition.providerSymbol]!.changePercentage,
          sourceTimestamp: "2026-08-13T15:30:00.000Z",
          collectedAt,
          provider: "test-provider",
        })),
        warnings: [],
      }),
    };
    const first = await runMarketContextJob(envFor(db), new Date("2026-08-13T19:30:00Z"), goodProvider);
    expect(first.status).toBe("ok");
    expect((await readMarketContext(db as unknown as D1Database)).indices).toHaveLength(4);

    const failingProvider = { collect: async () => { throw new Error("temporary outage"); } };
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const second = await runMarketContextJob(envFor(db), new Date("2026-08-13T19:45:00Z"), failingProvider);
    errorSpy.mockRestore();
    expect(second.status).toBe("degraded");
    expect((await readMarketContext(db as unknown as D1Database)).indices[0]?.updatedAt).toBe("2026-08-13T15:30:00.000Z");
  });

  it("uses insert-or-ignore semantics for repeated market runs", async () => {
    const db = new MemoryD1();
    const provider = {
      collect: async (collectedAt: string) => ({
        observations: INDEX_DEFINITIONS.map((definition) => ({
          symbol: definition.symbol,
          name: definition.name,
          value: 100,
          changePct: 1,
          sourceTimestamp: "2026-08-13T15:30:00.000Z",
          collectedAt,
          provider: "test-provider",
        })),
        warnings: [],
      }),
    };
    await runMarketContextJob(envFor(db), new Date("2026-08-13T19:30:00Z"), provider);
    await runMarketContextJob(envFor(db), new Date("2026-08-13T19:45:00Z"), provider);
    expect(db.indices.size).toBe(4);
    expect(db.sql.filter((sql) => sql.includes("INSERT OR IGNORE INTO market_indices"))).toHaveLength(8);
  });
});

describe("sentiment provider and schedules", () => {
  it("validates CNN score, rating and source timestamp", async () => {
    const provider = new CnnSentimentProvider(async () => response({
      fear_and_greed: { score: 62.4, rating: "Greed", timestamp: 1786625176 },
    }));
    await expect(provider.collect("2026-08-13T14:00:00.000Z")).resolves.toMatchObject({
      score: 62,
      rating: "greed",
      sourceTimestamp: new Date(1786625176 * 1000).toISOString(),
      provider: "cnn-fear-greed",
    });
    const invalid = new CnnSentimentProvider(async () => response({ fear_and_greed: { score: 101, rating: "panic" } }));
    await expect(invalid.collect("2026-08-13T14:00:00.000Z")).rejects.toThrow("invalid score");
  });

  it("requires a source timestamp and preserves the last valid sentiment on failure", async () => {
    const db = new MemoryD1();
    const valid: SentimentObservation = { score: 62, rating: "greed", sourceTimestamp: "2026-08-13T12:00:00.000Z", collectedAt: "2026-08-13T14:00:00.000Z", provider: "test-sentiment" };
    const first = await runSentimentJob(envFor(db), new Date("2026-08-13T14:00:00Z"), { collect: async () => valid });
    expect(first.status).toBe("ok");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const second = await runSentimentJob(envFor(db), new Date("2026-08-13T19:00:00Z"), { collect: async () => { throw new Error("temporary outage"); } });
    errorSpy.mockRestore();
    expect(second.status).toBe("degraded");
    expect((await readMarketContext(db as unknown as D1Database)).sentiment).toMatchObject({ score: 62, rating: "greed" });
  });

  it("handles New York session windows, weekends, DST and post-close", () => {
    expect(marketCollectionWindow(new Date("2026-01-12T14:30:00Z"))).toBe("regular");
    expect(marketCollectionWindow(new Date("2026-07-13T13:30:00Z"))).toBe("regular");
    expect(marketCollectionWindow(new Date("2026-07-13T20:15:00Z"))).toBe("post_close");
    expect(marketCollectionWindow(new Date("2026-07-13T13:15:00Z"))).toBeNull();
    expect(marketCollectionWindow(new Date("2026-07-11T14:30:00Z"))).toBeNull();
    expect(isUsMarketHoliday(new Date("2026-07-03T14:30:00Z"))).toBe(true); // observed Independence Day
    expect(marketCollectionWindow(new Date("2026-11-26T15:00:00Z"))).toBeNull(); // Thanksgiving
  });
});
