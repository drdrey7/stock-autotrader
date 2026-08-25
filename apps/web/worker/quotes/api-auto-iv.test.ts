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
  eps_ttm: number | null;
  market_cap: number | null;
  shareholders_equity: number | null;
  shares_outstanding: number | null;
  market_as_of: string | null;
  market_checked_at: string | null;
  updated_at: string;
}

interface ManualIntrinsicValueRow {
  symbol: string;
  method: "manual";
  low_value: number | null;
  base_value: number;
  high_value: number | null;
  as_of_date: string;
}

function createDb(
  quote: QuoteRow,
  company: CompanyRow,
  manualIntrinsicValue: ManualIntrinsicValueRow | null = null,
): D1Database {
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
          if (sql.includes("FROM stock_intrinsic_values")) {
            return { results: (manualIntrinsicValue ? [manualIntrinsicValue] : []) as T[] };
          }
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
const ADBE_EPS_TTM = 276.24 / 15.137946495292185;

function adobeCompany(overrides: Partial<CompanyRow> = {}): CompanyRow {
  return {
    symbol: "ADBE",
    company: "Adobe Inc.",
    logo_url: null,
    industry: "Technology",
    pe_ttm: 15.137946495292185,
    eps_ttm: ADBE_EPS_TTM,
    market_cap: 119_000_000_000,
    shareholders_equity: 14_000_000_000,
    shares_outstanding: 420_000_000,
    market_as_of: null,
    market_checked_at: NOW_ISO,
    updated_at: NOW_ISO,
    ...overrides,
  };
}

function adobeQuote(price = 276.24): QuoteRow {
  return {
    symbol: "ADBE",
    price,
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
}

describe("Screener intrinsic value selection", () => {
  it("regression: Adobe without manual IV receives the same midpoint Base used by Stock Detail", async () => {
    const env = { DB: createDb(adobeQuote(), adobeCompany()) } as Env;
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

  it("keeps automatic IV fixed when only the live quote changes", async () => {
    const first = await readScreenerApi({ DB: createDb(adobeQuote(276.24), adobeCompany()) } as Env, NOW);
    const second = await readScreenerApi({ DB: createDb(adobeQuote(270.52), adobeCompany()) } as Env, NOW);
    const firstAdobe = first.rows.find((row) => row.symbol === "ADBE")!;
    const secondAdobe = second.rows.find((row) => row.symbol === "ADBE")!;

    expect(secondAdobe.intrinsicValue?.base).toBe(firstAdobe.intrinsicValue?.base);
    expect(secondAdobe.intrinsicValue?.base).toBe(456.21);
    expect(secondAdobe.intrinsicValue?.distancePct).not.toBe(firstAdobe.intrinsicValue?.distancePct);
  });

  it("always keeps a valid Manual IV ahead of the automatic fallback", async () => {
    const manual: ManualIntrinsicValueRow = {
      symbol: "ADBE",
      method: "manual",
      low_value: null,
      base_value: 333.33,
      high_value: null,
      as_of_date: "2026-08-01",
    };
    const env = { DB: createDb(adobeQuote(), adobeCompany(), manual) } as Env;
    const response = await readScreenerApi(env, NOW);
    const adobe = response.rows.find((row) => row.symbol === "ADBE");

    expect(adobe!.intrinsicValue).not.toBeNull();
    expect(adobe!.intrinsicValue!.base).toBe(333.33);
    expect(adobe!.intrinsicValue!.method).toBe("manual");
  });

  it("fails closed instead of calculating from stale or incomplete persisted fundamentals", async () => {
    const stale = await readScreenerApi({
      DB: createDb(
        adobeQuote(),
        adobeCompany({
          market_checked_at: "2026-08-01T14:00:00.000Z",
          updated_at: "2026-08-01T14:00:00.000Z",
        }),
      ),
    } as Env, NOW);
    const missingEps = await readScreenerApi({
      DB: createDb(adobeQuote(), adobeCompany({ eps_ttm: null })),
    } as Env, NOW);

    expect(stale.rows.find((row) => row.symbol === "ADBE")!.intrinsicValue).toBeNull();
    expect(missingEps.rows.find((row) => row.symbol === "ADBE")!.intrinsicValue).toBeNull();
  });
});
