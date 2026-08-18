import { describe, expect, it } from "vitest";
import type { Env } from "../index";
import { readScreenerApi } from "./api";
import { QUOTES_HEALTH_META_KEY } from "./health";

interface LatestRow {
  symbol: string;
  price: number;
  change_abs: number;
  change_pct: number;
  day_high: number | null;
  day_low: number | null;
  day_open: number | null;
  previous_close: number | null;
  provider: string;
  provider_timestamp: string;
  updated_at: string;
}

const quoteRow = (symbol: string, price: number, updatedAt: string): LatestRow => ({
  symbol,
  price,
  change_abs: 2,
  change_pct: 1.2,
  day_high: price + 2,
  day_low: price - 2,
  day_open: price - 0.5,
  previous_close: price - 2,
  provider: "finnhub-quote",
  provider_timestamp: updatedAt,
  updated_at: updatedAt,
});

function createApiDb(options: { quotes?: LatestRow[]; companies?: Array<{ symbol: string; company: string }>; health?: unknown }) {
  const meta = new Map<string, string>();
  if (options.health !== undefined) meta.set(QUOTES_HEALTH_META_KEY, JSON.stringify(options.health));
  return {
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
            return { value: meta.get(key) ?? null } as T;
          }
          return null;
        },
        async all<T>(): Promise<{ results: T[] }> {
          if (sql.includes("FROM latest_quotes")) return { results: (options.quotes ?? []) as T[] };
          if (sql.includes("FROM earnings_universe")) return { results: (options.companies ?? []) as T[] };
          return { results: [] as T[] };
        },
        async run(): Promise<{ meta: { changes: number } }> {
          if (sql.includes("INSERT INTO app_meta")) {
            const [key, value] = args as [string, string];
            meta.set(key, value);
          }
          return { meta: { changes: 0 } };
        },
      };
      return statement;
    },
  };
}

const envFrom = (db: ReturnType<typeof createApiDb>): Env => ({ DB: db as unknown as Env["DB"] } as unknown as Env);

const REGULAR = new Date("2026-08-13T14:00:00Z"); // Thursday 10:00 ET
const SATURDAY = new Date("2026-08-15T14:00:00Z"); // weekend
const NOW_ISO = "2026-08-13T14:00:00.000Z";

describe("readScreenerApi", () => {
  it("returns the full 50-stock Core Universe with honest Unavailable rows when empty", async () => {
    const response = await readScreenerApi(envFrom(createApiDb({})), REGULAR);
    expect(response.universe.total).toBe(50);
    expect(response.rows).toHaveLength(50);
    expect(response.marketState).toBe("regular");
    expect(response.quotes.state).toBe("Unavailable");
    expect(response.quotes.provider).toBe("unavailable");
    for (const row of response.rows) {
      expect(row.state).toBe("Unavailable");
      expect(row.price).toBeNull();
      expect(row.company).toBeNull();
    }
  });

  it("merges latest quotes with Core Universe and company names", async () => {
    const db = createApiDb({
      quotes: [quoteRow("AAPL", 232.5, NOW_ISO)],
      companies: [{ symbol: "AAPL", company: "Apple Inc." }],
      health: { provider: "finnhub-quote", status: "ok", lastAttemptAt: NOW_ISO, lastSuccessAt: NOW_ISO, lastError: null, rowsWritten: 1, lastShard: 0, rateLimited: false },
    });
    const response = await readScreenerApi(envFrom(db), REGULAR);
    const apple = response.rows.find((row) => row.symbol === "AAPL")!;
    expect(apple.company).toBe("Apple Inc.");
    expect(apple.price).toBe(232.5);
    expect(apple.changePct).toBe(1.2);
    expect(apple.state).toBe("Live");
    expect(apple.asOf).toBe(NOW_ISO);
    expect(apple.updatedAt).toBe(NOW_ISO);
    expect(response.asOf).toBe(NOW_ISO);
    expect(response.quotes.state).toBe("Live");
    expect(response.quotes.provider).toBe("finnhub-quote");
    // The other 49 rows stay present and honest.
    expect(response.rows.filter((row) => row.symbol !== "AAPL")).toHaveLength(49);
  });

  it("reflects market-closed freshness (Cached, not Stale) over the weekend", async () => {
    const fridayClose = "2026-08-14T20:45:00.000Z";
    const db = createApiDb({
      quotes: [quoteRow("AAPL", 230, fridayClose)],
      health: { provider: "finnhub-quote", status: "ok", lastAttemptAt: fridayClose, lastSuccessAt: fridayClose, lastError: null, rowsWritten: 1, lastShard: 0, rateLimited: false },
    });
    const response = await readScreenerApi(envFrom(db), SATURDAY);
    expect(response.marketState).toBe("closed");
    const apple = response.rows.find((row) => row.symbol === "AAPL")!;
    expect(apple.state).toBe("Cached");
    expect(response.quotes.state).toBe("Cached");
  });

  it("serves the last known quote as Stale after a long in-session gap", async () => {
    const staleAt = "2026-08-13T13:00:00.000Z"; // 1 hour before now (in session)
    const db = createApiDb({
      quotes: [quoteRow("AAPL", 230, staleAt)],
      health: { provider: "finnhub-quote", status: "degraded", lastAttemptAt: staleAt, lastSuccessAt: staleAt, lastError: "AAPL: HTTP 500", rowsWritten: 0, lastShard: 0, rateLimited: false },
    });
    const response = await readScreenerApi(envFrom(db), REGULAR);
    const apple = response.rows.find((row) => row.symbol === "AAPL")!;
    expect(apple.state).toBe("Stale");
    expect(apple.price).toBe(230); // last known remains serviceable
    expect(response.quotes.state).toBe("Stale");
  });
});
