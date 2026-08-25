import { describe, expect, it } from "vitest";
import type { Env } from "../index";
import { readScreenerApi } from "./api";

interface QuoteRow {
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

interface CompanyRow {
  symbol: string;
  company: string;
  logo_url: string | null;
  industry: string | null;
  pe_ttm: number | null;
  market_cap: number | null;
  shareholders_equity: number | null;
}

function createDb(quote: QuoteRow, company: CompanyRow): D1Database {
  return {
    prepare(sql: string) {
      let args: unknown[] = [];
      const statement = {
        bind(...values: unknown[]) {
          args = values;
          return statement;
        },
        async first<T>(): Promise<T | null> {
          void args;
          return null;
        },
        async all<T>(): Promise<{ results: T[] }> {
          if (sql.includes("FROM latest_quotes")) return { results: [quote] as T[] };
          if (sql.includes("FROM earnings_universe")) return { results: [company] as T[] };
          if (sql.includes("FROM technical_metrics")) return { results: [] as T[] };
          if (sql.includes("FROM stock_support_levels")) return { results: [] as T[] };
          if (sql.includes("FROM stock_intrinsic_values")) return { results: [] as T[] };
          if (sql.includes("stock_split_events")) return { results: [] as T[] };
          return { results: [] as T[] };
        },
        async run(): Promise<{ meta: { changes: number } }> {
          return { meta: { changes: 0 } };
        },
      };
      return statement;
    },
  } as unknown as D1Database;
}

const NOW = new Date("2026-08-13T14:00:00.000Z");
const NOW_ISO = NOW.toISOString();

describe("Screener automatic intrinsic value fallback", () => {
  it("regression: Adobe without manual IV receives the same midpoint Base used by Stock Detail", async () => {
    const quote: QuoteRow = {
      symbol: "ADBE",
      price: 276.24,
      change_abs: 22.25,
      change_pct: 8.74,
      day_high: 280,
      day_low: 260,
      day_open: 265,
      previous_close: 253.99,
      provider: "finnhub-quote",
      provider_timestamp: NOW_ISO,
      updated_at: NOW_ISO,
    };
    const company: CompanyRow = {
      symbol: "ADBE",
      company: "Adobe Inc.",
      logo_url: null,
      industry: "Technology",
      pe_ttm: 15.137946495292185,
      market_cap: 119_000_000_000,
      shareholders_equity: 14_000_000_000,
    };

    const env = { DB: createDb(quote, company) } as Env;
    const response = await readScreenerApi(env, NOW);
    const adobe = response.rows.find((row) => row.symbol === "ADBE");

    expect(adobe).toBeDefined();
    expect(adobe!.intrinsicValue).not.toBeNull();
    expect(adobe!.intrinsicValue!.low).toBe(401.46);
    expect(adobe!.intrinsicValue!.base).toBe(456.21);
    expect(adobe!.intrinsicValue!.high).toBe(510.95);
    expect(adobe!.intrinsicValue!.method).toBe("automatic-p-e");
    expect(adobe!.intrinsicValue!.asOf).toBe("2026-08-13");
    expect(adobe!.intrinsicValue!.distancePct).toBeCloseTo(-39.4489, 3);
  });
});
