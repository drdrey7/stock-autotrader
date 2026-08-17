import { describe, expect, it, vi } from "vitest";
import type { Env } from "./index";
import worker from "./index";
import { PRODUCTION_CRON_TRIGGERS } from "./cron-dispatcher";
import {
  CnnSentimentProvider,
  YahooFinanceMarketDataProvider,
  INDEX_DEFINITIONS,
  isUsMarketHoliday,
  marketCollectionWindow,
  readMarketContext,
  readSentimentHealth,
  runMarketContextJob,
  runSentimentJob,
  sentimentStaleAfterSeconds,
  SENTIMENT_OFF_SESSION_STALE_AFTER_SECONDS,
  SENTIMENT_SESSION_STALE_AFTER_SECONDS,
  writeMarketIndices,
  type MarketIndexObservation,
  type SentimentObservation,
} from "./market-context";

type StoredIndex = MarketIndexObservation;

class MemoryD1 {
  readonly indices = new Map<string, StoredIndex>();
  readonly sentiments: SentimentObservation[] = [];
  readonly meta = new Map<string, string>();
  readonly sql: string[] = [];
  failIndices = false;
  failSentiment = false;

  prepare(sql: string) {
    this.sql.push(sql);
    let args: unknown[] = [];
    const statement = {
      bind: (...values: unknown[]) => {
        args = values;
        return statement;
      },
      run: async () => {
        let changes = 0;
        if (sql.includes("INSERT INTO app_meta")) {
          this.meta.set(String(args[0]), String(args[1]));
          changes = 1;
        } else if (sql.includes("DELETE FROM app_meta")) {
          changes = this.meta.delete(String(args[0])) ? 1 : 0;
        } else if (sql.includes("market_indices")) {
          const [symbol, name, value, changePct, sourceTimestamp, collectedAt, provider] = args as [
            StoredIndex["symbol"], string, number, number, string, string, string,
          ];
          const key = `${symbol}|${sourceTimestamp}|${provider}`;
          if (!this.indices.has(key)) {
            this.indices.set(key, { symbol, name, value, changePct, sourceTimestamp, collectedAt, provider });
            changes = 1;
          }
        } else if (sql.includes("market_sentiment")) {
          const [score, rating, sourceTimestamp, collectedAt, provider] = args as [number, SentimentObservation["rating"], string, string, string];
          if (!this.sentiments.some((row) => row.sourceTimestamp === sourceTimestamp && row.provider === provider)) {
            this.sentiments.push({ score, rating, sourceTimestamp, collectedAt, provider });
            changes = 1;
          }
        }
        return { success: true, meta: { changes } };
      },
      all: async <T>() => {
        if (this.failIndices) throw new Error("indices read failed");
        return {
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
        };
      },
      first: async <T>() => {
        if (sql.includes("FROM app_meta")) {
          return (this.meta.has(String(args[0])) ? { value: this.meta.get(String(args[0])) } : null) as T | null;
        }
        if (this.failSentiment) throw new Error("sentiment read failed");
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
    const results: unknown[] = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }
}

const envFor = (db: MemoryD1): Env => ({ DB: db as unknown as D1Database, ASSETS: {} as Fetcher });
const response = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), {
  status,
  headers: { "content-type": "application/json" },
});

const providerRows: Record<string, { regularMarketPrice: number; chartPreviousClose: number; regularMarketTime: number }> = {
  "^GSPC": { regularMarketPrice: 6427.18, chartPreviousClose: 6387.59, regularMarketTime: 1786635000 },
  "^NDX": { regularMarketPrice: 23724.31, chartPreviousClose: 23540.77, regularMarketTime: 1786635000 },
  "^DJI": { regularMarketPrice: 45118.26, chartPreviousClose: 44903.77, regularMarketTime: 1786635000 },
  "^VIX": { regularMarketPrice: 15.41, chartPreviousClose: 15.61, regularMarketTime: 1786635000 },
};

const yahooResponse = (row: Record<string, unknown>) => response({
  chart: { result: [{ meta: row }], error: null },
});

const testObservations = (
  sourceTimestamp = "2026-08-13T15:30:00.000Z",
  provider = "test-provider",
): MarketIndexObservation[] => INDEX_DEFINITIONS.map((definition) => ({
  symbol: definition.symbol,
  name: definition.name,
  value: 100,
  changePct: 1,
  sourceTimestamp,
  collectedAt: "2026-08-13T19:30:00.000Z",
  provider,
}));

describe("market context providers and persistence", () => {
  it("normalizes all four free Yahoo chart quotes and preserves source timestamps", async () => {
    const provider = new YahooFinanceMarketDataProvider(async (input, init) => {
      expect(new Headers(init?.headers).get("User-Agent")).toContain("StockAutotrader/1.0");
      const symbol = decodeURIComponent(new URL(input.toString()).pathname.split("/").pop()!);
      return yahooResponse(providerRows[symbol]!);
    });

    const result = await provider.collect("2026-08-13T14:45:00.000Z");
    expect(result.warnings).toEqual([]);
    expect(result.observations).toHaveLength(4);
    expect(result.observations.map((row) => row.symbol)).toEqual(["SPX", "NDX", "DJI", "VIX"]);
    expect(result.observations[0]).toMatchObject({
      name: "S&P 500",
      value: 6427.18,
      changePct: expect.closeTo(0.6195, 3),
      sourceTimestamp: new Date(1786635000 * 1000).toISOString(),
      provider: "yahoo-finance-chart",
    });
  });

  it("rejects invalid quotes without preventing valid symbols from being saved", async () => {
    const provider = new YahooFinanceMarketDataProvider(async (input) => {
      const symbol = decodeURIComponent(new URL(input.toString()).pathname.split("/").pop()!);
      return yahooResponse(symbol === "^VIX"
        ? { regularMarketPrice: 0, chartPreviousClose: 15, regularMarketTime: 1786635000 }
        : providerRows[symbol]!);
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
          value: providerRows[definition.providerSymbol]!.regularMarketPrice,
          changePct: ((providerRows[definition.providerSymbol]!.regularMarketPrice - providerRows[definition.providerSymbol]!.chartPreviousClose)
            / providerRows[definition.providerSymbol]!.chartPreviousClose) * 100,
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

  it("preserves the last-known-good set on provider 429 and clears degraded health on the next success", async () => {
    const db = new MemoryD1();
    const goodProvider = {
      name: "yahoo-finance-chart",
      collect: async (collectedAt: string) => ({
        observations: INDEX_DEFINITIONS.map((definition) => ({
          symbol: definition.symbol,
          name: definition.name,
          value: 100,
          changePct: 1,
          sourceTimestamp: "2026-08-13T15:30:00.000Z",
          collectedAt,
          provider: "yahoo-finance-chart",
        })),
        warnings: [],
      }),
    };
    await runMarketContextJob(envFor(db), new Date("2026-08-13T19:30:00Z"), goodProvider);

    const rateLimited = {
      name: "yahoo-finance-chart",
      collect: async () => ({
        observations: [],
        warnings: INDEX_DEFINITIONS.map((definition) => `${definition.symbol}: provider HTTP 429`),
      }),
    };
    const warningSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const degraded = await runMarketContextJob(envFor(db), new Date("2026-08-13T19:45:00Z"), rateLimited);
    warningSpy.mockRestore();
    expect(degraded).toMatchObject({ status: "degraded" });
    expect((await readMarketContext(db as unknown as D1Database)).indices).toHaveLength(4);
    expect(JSON.parse(db.meta.get("marketContextHealth")!)).toMatchObject({
      status: "degraded",
      lastError: expect.stringContaining("SPX: provider HTTP 429"),
      httpStatuses: [429],
      rowsWritten: 0,
      lastKnownGoodPreserved: true,
    });

    const recovered = await runMarketContextJob(envFor(db), new Date("2026-08-13T20:30:00Z"), goodProvider);
    expect(recovered.status).toBe("ok");
    expect(JSON.parse(db.meta.get("marketContextHealth")!)).toMatchObject({
      status: "ok",
      lastError: null,
      rowsWritten: 0,
      lastKnownGoodPreserved: false,
    });
  });

  it("returns four for four genuinely inserted index rows", async () => {
    const db = new MemoryD1();
    expect(await writeMarketIndices(db as unknown as D1Database, testObservations())).toBe(4);
  });

  it("returns zero when all four index rows are ignored as duplicates", async () => {
    const db = new MemoryD1();
    const observations = testObservations();
    expect(await writeMarketIndices(db as unknown as D1Database, observations)).toBe(4);
    expect(await writeMarketIndices(db as unknown as D1Database, observations)).toBe(0);
  });

  it("returns the exact inserted count for mixed new and duplicate rows", async () => {
    const db = new MemoryD1();
    const observations = testObservations();
    expect(await writeMarketIndices(db as unknown as D1Database, observations.slice(0, 2))).toBe(2);
    const mixed = [
      ...observations.slice(0, 2),
      ...testObservations("2026-08-13T15:45:00.000Z").slice(2),
    ];
    expect(await writeMarketIndices(db as unknown as D1Database, mixed)).toBe(2);
  });

  it("reports actual D1 changes in Market Context health and structured logs", async () => {
    const db = new MemoryD1();
    const provider = {
      name: "test-provider",
      collect: async () => ({ observations: testObservations(), warnings: [] }),
    };
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      await runMarketContextJob(envFor(db), new Date("2026-08-13T19:30:00Z"), provider);
      const firstResult = infoSpy.mock.calls
        .map(([message]) => JSON.parse(String(message)) as { phase?: string; rowsWritten?: number })
        .find((message) => message.phase === "result");
      expect(firstResult?.rowsWritten).toBe(4);

      infoSpy.mockClear();
      await runMarketContextJob(envFor(db), new Date("2026-08-13T19:45:00Z"), provider);
      const duplicateResult = infoSpy.mock.calls
        .map(([message]) => JSON.parse(String(message)) as { phase?: string; rowsWritten?: number })
        .find((message) => message.phase === "result");
      expect(duplicateResult?.rowsWritten).toBe(0);
      expect(JSON.parse(db.meta.get("marketContextHealth")!)).toMatchObject({ rowsWritten: 0 });
    } finally {
      infoSpy.mockRestore();
    }
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

  it("never lets an older source observation replace a newer one", async () => {
    const db = new MemoryD1();
    const collect = (sourceTimestamp: string) => async (collectedAt: string) => ({
      observations: INDEX_DEFINITIONS.map((definition) => ({
        symbol: definition.symbol,
        name: definition.name,
        value: sourceTimestamp.endsWith("30:00.000Z") ? 200 : 100,
        changePct: 1,
        sourceTimestamp,
        collectedAt,
        provider: "test-provider",
      })),
      warnings: [],
    });
    await runMarketContextJob(envFor(db), new Date("2026-08-13T19:30:00Z"), { collect: collect("2026-08-13T15:30:00.000Z") });
    await runMarketContextJob(envFor(db), new Date("2026-08-13T19:45:00Z"), { collect: collect("2026-08-13T15:15:00.000Z") });
    expect((await readMarketContext(db as unknown as D1Database)).indices[0]).toMatchObject({ value: 200, updatedAt: "2026-08-13T15:30:00.000Z" });
  });

  it("keeps each read model area available when the other query fails", async () => {
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
    await runSentimentJob(envFor(db), new Date("2026-08-13T19:30:00Z"), {
      name: "test-sentiment",
      collect: async () => ({
        score: 62,
        rating: "greed",
        sourceTimestamp: "2026-08-13T12:00:00.000Z",
        collectedAt: new Date().toISOString(),
        provider: "test-sentiment",
      }),
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    db.failSentiment = true;
    const sentimentFailure = await readMarketContext(db as unknown as D1Database);
    expect(sentimentFailure.indices).toHaveLength(4);
    expect(sentimentFailure.sentiment).toBeNull();
    db.failSentiment = false;
    db.failIndices = true;
    const indexFailure = await readMarketContext(db as unknown as D1Database);
    errorSpy.mockRestore();
    expect(indexFailure.indices).toEqual([]);
    expect(indexFailure.sentiment).toMatchObject({ score: 62, rating: "greed" });
  });

  it("does not publish a prior-day quote as the current session", async () => {
    const db = new MemoryD1();
    const provider = {
      collect: async (collectedAt: string) => ({
        observations: INDEX_DEFINITIONS.map((definition) => ({
          symbol: definition.symbol,
          name: definition.name,
          value: 100,
          changePct: 1,
          sourceTimestamp: "2026-08-12T20:00:00.000Z",
          collectedAt,
          provider: "eod-provider",
        })),
        warnings: [],
      }),
    };
    const warningSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const result = await runMarketContextJob(envFor(db), new Date("2026-08-13T19:30:00Z"), provider);
    warningSpy.mockRestore();
    expect(result.status).toBe("degraded");
    expect((await readMarketContext(db as unknown as D1Database)).indices).toEqual([]);
  });
});

describe("preview cron safety", () => {
  it("does not run scheduled jobs outside production", async () => {
    const db = new Proxy({} as D1Database, {
      get: () => { throw new Error("preview attempted a D1 write"); },
    });
    for (const cron of PRODUCTION_CRON_TRIGGERS) {
      await expect(worker.scheduled(
        { cron, scheduledTime: Date.parse("2026-08-13T14:00:00Z") } as ScheduledController,
        { DB: db, ASSETS: {} as Fetcher, ENVIRONMENT: "preview" },
      )).resolves.toBeUndefined();
    }
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
    const missingTimestamp = new CnnSentimentProvider(async () => response({ fear_and_greed: { score: 62, rating: "Greed" } }));
    await expect(missingTimestamp.collect("2026-08-13T14:00:00.000Z")).rejects.toThrow("missing source timestamp");
  });

  it("requires a source timestamp and preserves the last valid sentiment on failure", async () => {
    const db = new MemoryD1();
    const valid: SentimentObservation = { score: 62, rating: "greed", sourceTimestamp: "2026-08-13T12:00:00.000Z", collectedAt: "2026-08-13T14:00:00.000Z", provider: "test-sentiment" };
    const first = await runSentimentJob(envFor(db), new Date("2026-08-13T14:00:00Z"), {
      name: "test-sentiment",
      collect: async () => valid,
    });
    expect(first.status).toBe("ok");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const second = await runSentimentJob(envFor(db), new Date("2026-08-13T19:00:00Z"), {
      name: "test-sentiment",
      collect: async () => { throw new Error("temporary outage"); },
    });
    errorSpy.mockRestore();
    expect(second.status).toBe("degraded");
    expect((await readMarketContext(db as unknown as D1Database)).sentiment).toMatchObject({ score: 62, rating: "greed" });
  });

  it("handles New York session windows, weekends, DST and post-close", () => {
    expect(marketCollectionWindow(new Date("2026-01-12T14:30:00Z"))).toBe("regular");
    expect(marketCollectionWindow(new Date("2026-07-13T13:30:00Z"))).toBe("regular");
    expect(marketCollectionWindow(new Date("2026-07-13T20:15:00Z"))).toBe("post_close");
    expect(marketCollectionWindow(new Date("2026-07-13T20:30:00Z"))).toBe("post_close");
    expect(marketCollectionWindow(new Date("2026-07-13T13:15:00Z"))).toBeNull();
    expect(marketCollectionWindow(new Date("2026-07-11T14:30:00Z"))).toBeNull();
    expect(isUsMarketHoliday(new Date("2026-07-03T14:30:00Z"))).toBe(true); // observed Independence Day
    expect(isUsMarketHoliday(new Date("2021-12-31T15:00:00Z"))).toBe(true); // 2022 New Year's Day observed
    expect(marketCollectionWindow(new Date("2026-11-26T15:00:00Z"))).toBeNull(); // Thanksgiving
    expect(marketCollectionWindow(new Date("2026-11-27T18:00:00Z"))).toBeNull(); // 13:00 ET early close
    expect(marketCollectionWindow(new Date("2026-11-27T18:15:00Z"))).toBe("post_close");
    expect(marketCollectionWindow(new Date("2026-11-27T18:45:00Z"))).toBe("post_close");
    // A holiday falling on a Sunday is observed on Monday with NO early-close
    // shift on the preceding Friday: July 4, 2027 (Sunday) -> July 5 closed,
    // July 2, 2027 is a full regular session (NYSE 2021/2027 calendars).
    expect(marketCollectionWindow(new Date("2027-07-02T18:00:00Z"))).toBe("regular"); // 2:00pm ET, regular
    expect(marketCollectionWindow(new Date("2027-07-05T14:30:00Z"))).toBeNull(); // observed holiday
    expect(marketCollectionWindow(new Date("2022-12-23T18:00:00Z"))).toBe("regular"); // Dec 25, 2022 Sunday -> no Dec-23 early close
  });

  it("does not write a duplicate row when the CNN source timestamp is unchanged", async () => {
    const db = new MemoryD1();
    const observation: SentimentObservation = {
      score: 65,
      rating: "greed",
      sourceTimestamp: "2026-08-14T18:58:07.000Z",
      collectedAt: "2026-08-14T19:00:37.690Z",
      provider: "test-sentiment",
    };
    const first = await runSentimentJob(envFor(db), new Date("2026-08-14T20:30:00Z"), {
      name: "test-sentiment",
      collect: async () => observation,
    });
    expect(first.status).toBe("ok");
    expect(db.sentiments).toHaveLength(1);

    // Same source timestamp again: no-op, still exactly one row.
    const second = await runSentimentJob(envFor(db), new Date("2026-08-14T21:00:00Z"), {
      name: "test-sentiment",
      collect: async () => observation,
    });
    expect(second.status).toBe("ok");
    expect(second.detail).toContain("noop");
    expect(db.sentiments).toHaveLength(1);

    // New source timestamp: persisted as a second row.
    const newer = { ...observation, score: 64, sourceTimestamp: "2026-08-14T19:28:00.000Z", collectedAt: "2026-08-14T19:30:00.000Z" };
    const third = await runSentimentJob(envFor(db), new Date("2026-08-14T21:30:00Z"), {
      name: "test-sentiment",
      collect: async () => newer,
    });
    expect(third.status).toBe("ok");
    expect(third.detail).toBe("2026-08-14T19:28:00.000Z");
    expect(db.sentiments).toHaveLength(2);
  });

  it("records sentiment health diagnostics (attempt/success/error) without touching rows on failure", async () => {
    const db = new MemoryD1();
    const valid: SentimentObservation = {
      score: 60,
      rating: "fear",
      sourceTimestamp: "2026-08-14T13:56:18.000Z",
      collectedAt: "2026-08-14T14:00:37.800Z",
      provider: "test-sentiment",
    };
    await runSentimentJob(envFor(db), new Date("2026-08-14T14:00:00Z"), {
      name: "test-sentiment",
      collect: async () => valid,
    });
    const health = await readSentimentHealth(db as unknown as D1Database);
    expect(health).toMatchObject({
      provider: "test-sentiment",
      status: "ok",
      lastSourceTimestamp: "2026-08-14T13:56:18.000Z",
      consecutiveFailures: 0,
    });
    expect(health?.lastSuccessfulUpdate).not.toBeNull();

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failed = await runSentimentJob(envFor(db), new Date("2026-08-14T14:30:00Z"), {
      name: "test-sentiment",
      collect: async () => { throw new Error("provider HTTP 429"); },
    });
    errorSpy.mockRestore();
    expect(failed.status).toBe("degraded");
    const degraded = await readSentimentHealth(db as unknown as D1Database);
    expect(degraded).toMatchObject({ status: "degraded", lastError: "provider HTTP 429", consecutiveFailures: 1 });
    // Last-known-good preserved: row still there, read model still valid.
    expect(db.sentiments).toHaveLength(1);
    expect((await readMarketContext(db as unknown as D1Database)).sentiment).toMatchObject({ score: 60 });
  });

  it("skips sentiment on US market holidays", async () => {
    const db = new MemoryD1();
    // 2026-07-03 14:30 UTC = observed Independence Day (Friday), 10:30 ET.
    const result = await runSentimentJob(envFor(db), new Date("2026-07-03T14:30:00Z"));
    expect(result.status).toBe("skipped");
    expect(result.detail).toBe("weekend_or_holiday");
    expect(db.sentiments).toHaveLength(0);
  });

  it("applies market-aware sentiment freshness (session vs off-session)", () => {
    // Tuesday 11:00 ET: session gate (2.5h) applies.
    expect(sentimentStaleAfterSeconds(new Date("2026-08-11T15:00:00Z"))).toBe(SENTIMENT_SESSION_STALE_AFTER_SECONDS);
    // Weekend: 72h+ (Friday close to Monday) stays within the off-session gate.
    expect(sentimentStaleAfterSeconds(new Date("2026-08-15T12:00:00Z"))).toBe(SENTIMENT_OFF_SESSION_STALE_AFTER_SECONDS);
    // Holiday Friday 2026-07-03: off-session gate.
    expect(sentimentStaleAfterSeconds(new Date("2026-07-03T14:30:00Z"))).toBe(SENTIMENT_OFF_SESSION_STALE_AFTER_SECONDS);
    // Pre-market Monday 06:00 ET: off-session gate (last session still valid).
    expect(sentimentStaleAfterSeconds(new Date("2026-08-10T10:00:00Z"))).toBe(SENTIMENT_OFF_SESSION_STALE_AFTER_SECONDS);
    // DST-safe: same UTC wall clock in January (EST) lands inside the
    // session-open grace, so the off-session gate still applies.
    expect(sentimentStaleAfterSeconds(new Date("2026-01-12T14:30:00Z"))).toBe(SENTIMENT_OFF_SESSION_STALE_AFTER_SECONDS);
  });

  it("keeps the prior session's reading usable during the session-open grace", () => {
    // Monday 10:30 ET (09:30 + 90min grace): prior Friday close stays usable.
    expect(sentimentStaleAfterSeconds(new Date("2026-08-10T14:30:00Z"))).toBe(SENTIMENT_OFF_SESSION_STALE_AFTER_SECONDS);
    // Tuesday 10:45 ET: a normal-day open must not blank the card either.
    expect(sentimentStaleAfterSeconds(new Date("2026-08-11T14:45:00Z"))).toBe(SENTIMENT_OFF_SESSION_STALE_AFTER_SECONDS);
    // Monday 11:00 ET: grace ends, session gate applies.
    expect(sentimentStaleAfterSeconds(new Date("2026-08-10T15:00:00Z"))).toBe(SENTIMENT_SESSION_STALE_AFTER_SECONDS);
    // January (EST): same grace — 09:45 ET off-session, 11:00 ET session.
    expect(sentimentStaleAfterSeconds(new Date("2026-01-12T14:45:00Z"))).toBe(SENTIMENT_OFF_SESSION_STALE_AFTER_SECONDS);
    expect(sentimentStaleAfterSeconds(new Date("2026-01-12T16:00:00Z"))).toBe(SENTIMENT_SESSION_STALE_AFTER_SECONDS);
  });
});
