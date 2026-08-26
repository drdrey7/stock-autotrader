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

interface ManualRow {
  symbol: string;
  method: "manual";
  low_value: number | null;
  base_value: number;
  high_value: number | null;
  as_of_date: string;
}

function createDb(company: Record<string, unknown>, quote: QuoteRow, manual: ManualRow | null = null): D1Database {
  return {
    prepare(sql: string) {
      const statement = {
        bind(...values: unknown[]) {
          void values;
          return statement;
        },
        async first<T>(): Promise<T | null> {
          return null;
        },
        async all<T>(): Promise<{ results: T[] }> {
          if (sql.includes("FROM latest_quotes")) return { results: [quote] as T[] };
          if (sql.includes("FROM earnings_universe")) return { results: [company] as T[] };
          if (sql.includes("FROM stock_intrinsic_values")) return { results: (manual ? [manual] : []) as T[] };
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

const NOW = new Date("2026-08-26T14:00:00.000Z");
const NOW_ISO = NOW.toISOString();

function quote(symbol: string, price: number): QuoteRow {
  return {
    symbol,
    price,
    change_abs: 1,
    change_pct: 0.5,
    day_high: price + 1,
    day_low: price - 1,
    day_open: price,
    previous_close: price - 1,
    provider: "finnhub-quote",
    provider_timestamp: NOW_ISO,
    updated_at: NOW_ISO,
  };
}

function amdCompany(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    symbol: "AMD",
    company: "Advanced Micro Devices, Inc.",
    logo_url: null,
    industry: "Semiconductors",
    eps_ttm: 3.8972,
    fcf_per_share_ttm: 5.1533,
    revenue_per_share_ttm: 92.4,
    book_value_per_share: 8,
    revenue_growth_ttm_yoy_pct: 39.54,
    revenue_growth_3y_pct: 13.64,
    revenue_growth_5y_pct: 28.82,
    roe_ttm_pct: 10.07,
    roic_pct: 9.59,
    fcf_margin_pct: 13.51,
    debt_to_equity: 0.048,
    pe_5y_p25: 61.38,
    pe_5y_median: 80.97,
    pe_5y_p75: 166.8,
    pe_5y_samples: 19,
    pe_5y_as_of: "2026-06-30",
    pfcf_5y_p25: 47.11,
    pfcf_5y_median: 59.57,
    pfcf_5y_p75: 110.1,
    pfcf_5y_samples: 20,
    pfcf_5y_as_of: "2026-06-30",
    ps_5y_p25: 4.8,
    ps_5y_median: 8.53,
    ps_5y_p75: 13,
    ps_5y_samples: 20,
    ps_5y_as_of: "2026-06-30",
    pb_5y_p25: 2,
    pb_5y_median: 4.06,
    pb_5y_p75: 7,
    pb_5y_samples: 20,
    pb_5y_as_of: "2026-06-30",
    market_checked_at: "2026-08-25T23:30:00Z",
    market_as_of: null,
    updated_at: "2026-08-25T23:30:01Z",
    ...overrides,
  };
}

describe("Screener Automatic IV V2 selection", () => {
  it("shows Automatic Base when Manual IV is absent", async () => {
    const response = await readScreenerApi({ DB: createDb(amdCompany(), quote("AMD", 480)) } as Env, NOW);
    const amd = response.rows.find((row) => row.symbol === "AMD")!;
    expect(amd.intrinsicValue).not.toBeNull();
    expect(amd.intrinsicValue!.method).toContain("automatic-");
    expect(amd.intrinsicValue!.base).toBeGreaterThan(0);
    expect(amd.intrinsicValue!.asOf).toBe("2026-08-25");
  });

  it("does not hide Automatic IV just because fundamentals are weeks old", async () => {
    const response = await readScreenerApi({
      DB: createDb(
        amdCompany({
          market_checked_at: "2026-07-01T12:00:00Z",
          updated_at: "2026-07-01T12:00:01Z",
        }),
        quote("AMD", 480),
      ),
    } as Env, NOW);
    const amd = response.rows.find((row) => row.symbol === "AMD")!;
    expect(amd.intrinsicValue?.base).toBeGreaterThan(0);
    expect(amd.intrinsicValue?.asOf).toBe("2026-07-01");
  });

  it("keeps valid Manual IV ahead of Automatic Base", async () => {
    const manual: ManualRow = {
      symbol: "AMD",
      method: "manual",
      low_value: null,
      base_value: 333.33,
      high_value: null,
      as_of_date: "2026-08-01",
    };
    const response = await readScreenerApi({ DB: createDb(amdCompany(), quote("AMD", 480), manual) } as Env, NOW);
    const amd = response.rows.find((row) => row.symbol === "AMD")!;
    expect(amd.intrinsicValue?.base).toBe(333.33);
    expect(amd.intrinsicValue?.method).toBe("manual");
  });

  it("keeps Automatic Base fixed when only the quote changes", async () => {
    const first = await readScreenerApi({ DB: createDb(amdCompany(), quote("AMD", 400)) } as Env, NOW);
    const second = await readScreenerApi({ DB: createDb(amdCompany(), quote("AMD", 600)) } as Env, NOW);
    const firstIv = first.rows.find((row) => row.symbol === "AMD")!.intrinsicValue!;
    const secondIv = second.rows.find((row) => row.symbol === "AMD")!.intrinsicValue!;
    expect(secondIv.base).toBe(firstIv.base);
    expect(secondIv.low).toBe(firstIv.low);
    expect(secondIv.high).toBe(firstIv.high);
    expect(secondIv.distancePct).not.toBe(firstIv.distancePct);
  });

  it("serves a CRWV-like stock through P/S instead of returning unavailable", async () => {
    const company = {
      symbol: "CRWV",
      company: "CoreWeave, Inc.",
      logo_url: null,
      industry: "Software - Infrastructure",
      eps_ttm: -4,
      fcf_per_share_ttm: -20,
      revenue_per_share_ttm: 11.8166,
      book_value_per_share: 8.9455,
      revenue_growth_ttm_yoy_pct: 129.93,
      revenue_growth_3y_pct: 586.92,
      revenue_growth_5y_pct: null,
      roe_ttm_pct: -40.33,
      roic_pct: -7.26,
      fcf_margin_pct: 157.5,
      debt_to_equity: 5.274,
      pe_5y_p25: null,
      pe_5y_median: null,
      pe_5y_p75: null,
      pe_5y_samples: 0,
      pfcf_5y_p25: null,
      pfcf_5y_median: null,
      pfcf_5y_p75: null,
      pfcf_5y_samples: 0,
      ps_5y_p25: 6.643,
      ps_5y_median: 6.747,
      ps_5y_p75: 6.851,
      ps_5y_samples: 2,
      ps_5y_as_of: "2026-03-31",
      pb_5y_p25: 8.558,
      pb_5y_median: 10.7,
      pb_5y_p75: 17.47,
      pb_5y_samples: 5,
      pb_5y_as_of: "2026-03-31",
      market_checked_at: "2026-08-25T23:30:00Z",
      market_as_of: null,
      updated_at: "2026-08-25T23:30:01Z",
    };
    const response = await readScreenerApi({ DB: createDb(company, quote("CRWV", 109)) } as Env, NOW);
    const crwv = response.rows.find((row) => row.symbol === "CRWV")!;
    expect(crwv.intrinsicValue?.method).toBe("automatic-p-s");
    expect(crwv.intrinsicValue?.base).toBeGreaterThan(0);
  });
});
