import { describe, expect, it } from "vitest";
import { readLatestQuotes, upsertLatestQuotes } from "./storage";
import type { QuoteObservation } from "@stock-autotrader/contracts";

const quote = (symbol: string, price: number): QuoteObservation => ({
  symbol,
  price,
  changeAbs: 1,
  changePct: 0.5,
  dayHigh: price + 1,
  dayLow: price - 1,
  dayOpen: price - 0.5,
  previousClose: price - 1,
  asOf: "2026-08-13T14:00:05.000Z",
  provider: "finnhub-quote",
});

interface Row {
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

/** Minimal in-memory D1 fake targeting latest_quotes upserts. */
function createDb() {
  const rows = new Map<string, Row>();
  let batchCalls = 0;
  const request = {
    rows,
    batchCalls: () => batchCalls,
    prepare(sql: string) {
      let args: unknown[] = [];
      return {
        bind(...values: unknown[]) {
          args = values;
          return this;
        },
        async run() {
          if (!sql.includes("INSERT INTO latest_quotes")) return { meta: { changes: 0 } };
          const [symbol, price, changeAbs, changePct, dayHigh, dayLow, dayOpen, previousClose, provider, providerTimestamp, updatedAt] = args as [string, number, number, number, number | null, number | null, number | null, number | null, string, string, string];
          const existing = rows.get(symbol);
          const row: Row = existing ?? {
            symbol,
            price: 0,
            change_abs: 0,
            change_pct: 0,
            day_high: null,
            day_low: null,
            day_open: null,
            previous_close: null,
            provider,
            provider_timestamp: "",
            updated_at: "",
          };
          row.price = price;
          row.change_abs = changeAbs;
          row.change_pct = changePct;
          row.day_high = dayHigh;
          row.day_low = dayLow;
          row.day_open = dayOpen;
          row.previous_close = previousClose;
          row.provider = provider;
          row.provider_timestamp = providerTimestamp;
          row.updated_at = updatedAt;
          rows.set(symbol, row);
          return { meta: { changes: 1 } };
        },
        async all<T>() {
          if (sql.includes("FROM latest_quotes")) {
            return { results: [...rows.values()] as T[] };
          }
          return { results: [] as T[] };
        },
      };
    },
    async batch(statements: Array<{ run(): Promise<{ meta: { changes: number } }> }>) {
      batchCalls += 1;
      const results: Array<{ meta: { changes: number } }> = [];
      for (const statement of statements) {
        results.push(await statement.run());
      }
      return results;
    },
  };
  return request;
}

describe("latest_quotes storage", () => {
  it("upserts one row per symbol — a refresh updates, never appends", async () => {
    const db = createDb();
    const updatedAt = "2026-08-13T14:00:00.000Z";
    const first = await upsertLatestQuotes(db as unknown as D1Database, [quote("AAPL", 230)], updatedAt);
    expect(first).toBe(1);
    expect(db.rows.size).toBe(1);

    const second = await upsertLatestQuotes(db as unknown as D1Database, [quote("AAPL", 232.5)], updatedAt);
    expect(second).toBe(1);
    expect(db.rows.size).toBe(1);
    expect(db.rows.get("AAPL")?.price).toBe(232.5);
  });

  it("writes the whole shard in one D1 batch call", async () => {
    const db = createDb();
    const updatedAt = "2026-08-13T14:00:00.000Z";
    const symbols = ["AAPL", "MSFT", "NVDA", "TSLA", "AMZN", "GOOGL", "META", "AMD", "INTC", "CRM"];
    await upsertLatestQuotes(
      db as unknown as D1Database,
      symbols.map((symbol, index) => quote(symbol, 100 + index)),
      updatedAt,
    );
    expect(db.rows.size).toBe(10);
    expect(db.batchCalls()).toBe(1);
  });

  it("drops symbols outside the canonical Core Universe defensively", async () => {
    const db = createDb();
    const updatedAt = "2026-08-13T14:00:00.000Z";
    const rowsWritten = await upsertLatestQuotes(
      db as unknown as D1Database,
      [quote("AAPL", 230), quote("NOTACORE", 5)],
      updatedAt,
    );
    expect(rowsWritten).toBe(1);
    expect(db.rows.has("AAPL")).toBe(true);
    expect(db.rows.has("NOTACORE")).toBe(false);
  });

  it("returns zero rows when there is nothing valid to write", async () => {
    const db = createDb();
    const written = await upsertLatestQuotes(db as unknown as D1Database, [], "2026-08-13T14:00:00.000Z");
    expect(written).toBe(0);
  });

  it("propagates a D1 batch failure so the job can degrade health", async () => {
    const db = createDb();
    db.batch = async () => { throw new Error("D1 batch unavailable"); };
    await expect(
      upsertLatestQuotes(db as unknown as D1Database, [quote("AAPL", 230)], "2026-08-13T14:00:00.000Z"),
    ).rejects.toThrow("D1 batch unavailable");
  });

  it("reads back the full latest-quote state", async () => {
    const db = createDb();
    const updatedAt = "2026-08-13T14:00:00.000Z";
    const observation = quote("MSFT", 400);
    await upsertLatestQuotes(db as unknown as D1Database, [observation], updatedAt);
    const rows = await readLatestQuotes(db as unknown as D1Database);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      symbol: "MSFT",
      price: 400,
      provider: "finnhub-quote",
      provider_timestamp: observation.asOf,
      updated_at: updatedAt,
    });
  });
});
