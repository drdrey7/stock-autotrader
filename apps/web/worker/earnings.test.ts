import { describe, expect, it, vi } from "vitest";
import { EARNINGS_BACKFILL_DAYS, EarningsQueryError, readEarningsApi, runEarningsJob } from "./earnings";
import {
  addDays,
  buildEventId,
  calculateMetric,
  calculateOverallResult,
  normalizeEvent,
  rollingEarningsRange,
  shouldPollEarnings,
} from "./earnings/logic";
import {
  createDefaultEarningsProviders,
  FmpEarningsCalendarProvider,
  SecEdgarProvider,
} from "./earnings/providers";
import {
  readEarningsEvents,
  upsertEarningsEvent,
} from "./earnings/storage";
import type {
  EarningsCalendarObservation,
  EarningsCalendarProvider,
  EarningsProviderBundle,
  OfficialFilingsProvider,
} from "./earnings/types";

type Row = Record<string, unknown>;

class MemoryStatement {
  private args: unknown[] = [];

  constructor(private readonly db: MemoryD1, private readonly sql: string) {}

  bind(...args: unknown[]): this {
    this.args = args;
    return this;
  }

  async first<T>(): Promise<T | null> {
    if (this.sql.includes("FROM earnings_events WHERE id = ?")) {
      const row = this.db.events.get(String(this.args[0]));
      return (row ? (this.sql.includes("SELECT id") ? { id: row.id } : row) : null) as T | null;
    }
    if (this.sql.includes("FROM earnings_events WHERE provider_event_id = ?")) {
      const row = [...this.db.events.values()].find((candidate) => candidate.provider_event_id === this.args[0]
        && (!this.sql.includes("calendar_provider = ?") || candidate.calendar_provider === this.args[1]));
      return row as T | null;
    }
    if (this.sql.includes("FROM earnings_events WHERE symbol = ? AND fiscal_year = ?")) {
      const row = [...this.db.events.values()].find((candidate) => candidate.symbol === this.args[0]
        && candidate.fiscal_year === this.args[1]
        && candidate.fiscal_quarter === this.args[2]);
      return row as T | null;
    }
    if (this.sql.includes("FROM earnings_events WHERE symbol = ? AND scheduled_date = ?")) {
      const row = [...this.db.events.values()].find((candidate) => candidate.symbol === this.args[0]
        && candidate.scheduled_date === this.args[1]);
      return row as T | null;
    }
    throw new Error(`Unhandled first SQL: ${this.sql}`);
  }

  async all<T>(): Promise<{ results: T[] }> {
    if (this.sql.includes("FROM earnings_events") && this.sql.includes("status = 'scheduled'") && !this.sql.includes("status = 'reported'")) {
      const results = [...this.db.events.values()]
        .filter((row) => row.symbol === this.args[0] && row.status === "scheduled" && row.fiscal_year === null)
        .sort((left, right) => String(right.scheduled_date).localeCompare(String(left.scheduled_date)));
      return { results: results as T[] };
    }
    if (this.sql.includes("FROM earnings_events") && this.sql.includes("status = 'reported'")) {
      const today = String(this.args[0]);
      const results = [...this.db.events.values()].filter((row) => row.scheduled_date === today
        && (row.status === "scheduled" || (row.status === "reported" && (row.eps_actual === null || row.revenue_actual === null || row.sec_filing_url === null))));
      return { results: results as T[] };
    }
    if (this.sql === "SELECT * FROM earnings_events") {
      return { results: [...this.db.events.values()] as T[] };
    }
    if (this.sql.includes("FROM earnings_events WHERE symbol = ? AND fiscal_year = ?")) {
      const results = [...this.db.events.values()].filter((row) => row.symbol === this.args[0] && row.fiscal_year === this.args[1]);
      return { results: results as T[] };
    }
    if (this.sql.includes("status != 'cancelled'")) {
      const results = [...this.db.events.values()]
        .filter((row) => row.symbol === this.args[0] && row.status !== "cancelled" && row.fiscal_year === null && row.fiscal_quarter === null && row.fiscal_period === null)
        .sort((left, right) => String(right.scheduled_date).localeCompare(String(left.scheduled_date)));
      return { results: results as T[] };
    }
    if (this.sql.includes("FROM earnings_events") && this.sql.includes("scheduled_date IS NOT NULL")) {
      const from = String(this.args[0]);
      const to = String(this.args[1]);
      let argumentIndex = 2;
      const symbol = this.sql.includes("symbol = ?") ? String(this.args[argumentIndex++]) : null;
      const status = this.sql.includes("status = ?") ? String(this.args[argumentIndex]) : null;
      const results = [...this.db.events.values()]
        .filter((row) => typeof row.scheduled_date === "string"
          && row.scheduled_date >= from
          && row.scheduled_date <= to
          && (symbol === null || row.symbol === symbol)
          && (status === null || row.status === status))
        .sort((left, right) => String(right.scheduled_date).localeCompare(String(left.scheduled_date)) || String(left.symbol).localeCompare(String(right.symbol)));
      return { results: results as T[] };
    }
    if (this.sql.includes("FROM earnings_universe")) {
      return { results: [...this.db.universe.values()] as T[] };
    }
    throw new Error(`Unhandled all SQL: ${this.sql}`);
  }

  async raw<T>(): Promise<T[]> {
    return [];
  }

  async run(): Promise<{ success: true; meta: { changes: number } }> {
    if (this.sql.startsWith("INSERT INTO earnings_events")) {
      const columnsText = this.sql.match(/INSERT INTO earnings_events \(([^)]+)\)/)?.[1];
      if (!columnsText) throw new Error("missing event columns");
      const columns = columnsText.split(", ");
      const row = Object.fromEntries(columns.map((column, index) => [column, this.args[index]]));
      const id = String(row.id);
      const duplicateProvider = row.provider_event_id !== null
        && [...this.db.events.values()].some((candidate) => candidate.id !== id
          && candidate.provider_event_id === row.provider_event_id
          && candidate.calendar_provider === row.calendar_provider);
      const duplicatePeriod = row.fiscal_year !== null && row.fiscal_quarter !== null
        && [...this.db.events.values()].some((candidate) => candidate.id !== id
          && candidate.symbol === row.symbol
          && candidate.fiscal_year === row.fiscal_year
          && candidate.fiscal_quarter === row.fiscal_quarter);
      if (duplicateProvider || duplicatePeriod) throw new Error("UNIQUE constraint failed: earnings_events identity");
      this.db.events.set(id, row);
      return { success: true, meta: { changes: 1 } };
    }
    if (this.sql.startsWith("UPDATE earnings_events SET id = ?")) {
      const old = this.db.events.get(String(this.args[1]));
      if (old) {
        this.db.events.delete(String(this.args[1]));
        old.id = this.args[0];
        this.db.events.set(String(this.args[0]), old);
      }
      return { success: true, meta: { changes: old ? 1 : 0 } };
    }
    if (this.sql.includes("UPDATE earnings_events") && this.sql.includes("status = 'unknown'")) {
      const updatedAt = String(this.args[0]);
      const cutoff = String(this.args[2]);
      const upper = this.sql.includes("scheduled_date >= ?") ? String(this.args[3]) : null;
      const syncTimestamp = upper ? String(this.args[4]) : null;
      for (const row of this.db.events.values()) {
        const matches = upper
          ? row.status === "scheduled" && String(row.scheduled_date) >= cutoff && String(row.scheduled_date) <= upper
            && (row.last_checked_at === null || String(row.last_checked_at) < syncTimestamp!)
          : this.sql.includes("scheduled_date > ?")
            ? row.status === "scheduled" && String(row.scheduled_date) > cutoff
            : row.status === "scheduled" && String(row.scheduled_date) < cutoff;
        if (matches) {
          row.status = "unknown";
          row.scheduled = 0;
          row.reported = 0;
          row.unknown = 1;
          row.updated_at = updatedAt;
          row.last_checked_at = String(this.args[1]);
        }
      }
      return { success: true, meta: { changes: 1 } };
    }
    if (this.sql.includes("INSERT INTO earnings_universe")) {
      const [symbol, company, cik, exchange, investorRelationsUrl, indexes, metadataProvider, updatedAt] = this.args;
      const previous = this.db.universe.get(String(symbol));
      this.db.universe.set(String(symbol), {
        symbol, company, cik: cik ?? previous?.cik ?? null, exchange: exchange ?? previous?.exchange ?? null,
        investor_relations_url: investorRelationsUrl ?? previous?.investor_relations_url ?? null,
        index_memberships: indexes, metadata_provider: metadataProvider, updated_at: updatedAt,
      });
      return { success: true, meta: { changes: 1 } };
    }
    if (this.sql.includes("INSERT INTO app_meta")) {
      this.db.meta.set(String(this.args[0]), String(this.args[1]));
      return { success: true, meta: { changes: 1 } };
    }
    throw new Error(`Unhandled run SQL: ${this.sql}`);
  }
}

class MemoryD1 {
  readonly events = new Map<string, Row>();
  readonly universe = new Map<string, Row>();
  readonly meta = new Map<string, string>();

  prepare(sql: string): D1PreparedStatement {
    return new MemoryStatement(this, sql) as unknown as D1PreparedStatement;
  }
}

const eventObservation = (overrides: Partial<EarningsCalendarObservation> = {}): EarningsCalendarObservation => ({
  symbol: "MSFT",
  company: "Microsoft Corporation",
  scheduledDate: "2026-08-20",
  scheduledTime: "amc",
  timing: "AMC",
  fiscalYear: 2026,
  fiscalQuarter: 1,
  fiscalPeriod: "Q1",
  fiscalPeriodEnd: "2026-06-30",
  epsEstimate: 3,
  revenueEstimate: 100,
  epsActual: null,
  revenueActual: null,
  providerEventId: "fmp-msft-2026-q1",
  providerUpdatedAt: "2026-08-13T10:00:00.000Z",
  officialReportUrl: null,
  ...overrides,
});

const normalizedEvent = (overrides: Partial<EarningsCalendarObservation> = {}, today = "2026-08-13") => normalizeEvent(
  eventObservation(overrides),
  today,
  "2026-08-13T12:00:00.000Z",
  { company: "Microsoft Corporation", cik: "0000789012" },
);

const jsonResponse = (payload: unknown, status = 200): Response => new Response(JSON.stringify(payload), {
  status,
  headers: { "content-type": "application/json" },
});

const providerRange = { from: "2026-08-13", to: "2026-10-12" };
const providerUniverse = new Set(["MSFT", "AAPL"]);

describe("earnings calendar and result logic", () => {
  it("rolls the window across day, month and year boundaries", () => {
    expect(addDays("2026-08-13", 1)).toBe("2026-08-14");
    expect(addDays("2026-01-31", 1)).toBe("2026-02-01");
    expect(addDays("2024-12-31", 1)).toBe("2025-01-01");
    expect(rollingEarningsRange("2026-08-13")).toEqual({ from: "2026-08-13", to: "2026-10-12" });
  });

  it("uses fiscal identity before scheduled date and has a safe fallback", () => {
    expect(buildEventId("msft", 2026, 1, "2026-08-20")).toBe("MSFT-2026-Q1");
    expect(buildEventId("msft", 2026, null, "2026-08-20", "Q1")).toBe("MSFT-2026-Q1");
    expect(buildEventId("MSFT", null, null, "2026-08-20")).toBe("MSFT-2026-08-20");
    expect(normalizeEvent(eventObservation({ cancelled: true }), "2026-08-13", "2026-08-13T12:00:00.000Z").status).toBe("cancelled");
  });

  it("calculates EPS and revenue beat, miss, in-line and unavailable values", () => {
    expect(calculateMetric(1.1, 1)).toMatchObject({ surprise: expect.closeTo(0.1, 10), surprisePct: expect.closeTo(10, 10), result: "Beat" });
    expect(calculateMetric(0.9, 1).result).toBe("Miss");
    expect(calculateMetric(1.004, 1).result).toBe("In Line");
    expect(calculateMetric(110, 100).result).toBe("Beat");
    expect(calculateMetric(90, 100).result).toBe("Miss");
    expect(calculateMetric(null, 100)).toEqual({ surprise: null, surprisePct: null, result: "Not Available" });
    expect(calculateOverallResult("Beat", "Beat")).toBe("Beat");
    expect(calculateOverallResult("Miss", "Miss")).toBe("Miss");
    expect(calculateOverallResult("Beat", "Miss")).toBe("Mixed");
    expect(calculateOverallResult("Beat", "Not Available")).toBe("Not Available");
  });

  it("treats an official filing with missing metrics as reported without inventing a result", () => {
    const event = normalizeEvent(eventObservation({
      epsEstimate: null,
      revenueEstimate: null,
      officialFiling: {
        url: "https://www.sec.gov/Archives/edgar/data/789012/000078901226000010/0000789012-26-000010-index.html",
        accession: "0000789012-26-000010",
        form: "10-Q",
        filedAt: "2026-08-12T13:00:00.000Z",
        reportDate: null,
        items: [],
      },
    }), "2026-08-13", "2026-08-13T12:00:00.000Z", { cik: "0000789012" });
    expect(event).toMatchObject({ status: "reported", epsResult: "Not Available", revenueResult: "Not Available", overallResult: "Not Available" });
    expect(event.secAccession).toBe("0000789012-26-000010");
  });

  it("polls BMO, AMC and TBD only during their ET windows", () => {
    expect(shouldPollEarnings("BMO", new Date("2026-08-13T11:00:00.000Z"))).toBe(true);
    expect(shouldPollEarnings("BMO", new Date("2026-08-13T16:00:00.000Z"))).toBe(false);
    expect(shouldPollEarnings("AMC", new Date("2026-08-13T19:30:00.000Z"))).toBe(true);
    expect(shouldPollEarnings("AMC", new Date("2026-08-13T13:00:00.000Z"))).toBe(false);
    expect(shouldPollEarnings("TBD", new Date("2026-08-13T17:00:00.000Z"))).toBe(true);
  });
});

describe("free provider adapters", () => {
  it("uses SEC as the default when FMP is not configured", () => {
    const providers = createDefaultEarningsProviders(undefined, "StockAutotraderTest/1.0");
    expect(providers.calendar).toBe(providers.official);
    expect(providers.consensus).toBe(providers.official);
    expect(providers.calendar.name).toBe("sec-edgar");
  });

  it("normalizes FMP rows, filters the universe and keeps the newest duplicate", async () => {
    const provider = new FmpEarningsCalendarProvider("test-key", async () => jsonResponse([
      { symbol: "MSFT", date: "2026-08-20", fiscalYear: 2026, fiscalQuarter: 1, epsEstimated: 3, revenueEstimated: 100, id: "event-1", lastUpdated: "2026-08-13T11:00:00Z" },
      { symbol: "MSFT", date: "2026-08-21", fiscalYear: 2026, fiscalQuarter: 1, epsEstimated: 3.1, revenueEstimated: 101, id: "event-1", lastUpdated: "2026-08-13T12:00:00Z", officialReportUrl: "javascript:alert(1)" },
      { symbol: "PRIVATE", date: "2026-08-20" },
      { symbol: "MSFT", date: "not-a-date" },
    ]));
    const result = await provider.fetchCalendar(providerRange, providerUniverse, "2026-08-13T13:00:00.000Z");
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]).toMatchObject({ scheduledDate: "2026-08-21", epsEstimate: 3.1, officialReportUrl: null });
  });

  it("retries transient responses and rejects malformed payloads", async () => {
    let calls = 0;
    const sleeper = vi.fn(async () => undefined);
    const provider = new FmpEarningsCalendarProvider("test-key", async () => {
      calls += 1;
      return calls === 1 ? jsonResponse({ error: "busy" }, 503) : jsonResponse([]);
    }, sleeper);
    await expect(provider.fetchCalendar(providerRange, providerUniverse, "2026-08-13T13:00:00.000Z")).resolves.toMatchObject({ observations: [] });
    expect(calls).toBe(2);
    expect(sleeper).toHaveBeenCalledWith(100);

    const malformed = new FmpEarningsCalendarProvider("test-key", async () => jsonResponse({ unexpected: true }));
    await expect(malformed.fetchCalendar(providerRange, providerUniverse, "2026-08-13T13:00:00.000Z")).rejects.toThrow("malformed");
  });

  it("aborts a timed-out request and retries it once", async () => {
    const sleeper = vi.fn(async () => undefined);
    const fetcher = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
    const provider = new FmpEarningsCalendarProvider("test-key", fetcher, sleeper, 1);
    await expect(provider.fetchCalendar(providerRange, providerUniverse, "2026-08-13T13:00:00.000Z")).rejects.toThrow("aborted");
    expect(sleeper).toHaveBeenCalledWith(100);
  });

  it("honors SEC Retry-After while pacing requests", async () => {
    let calls = 0;
    const sleeper = vi.fn(async () => undefined);
    const provider = new SecEdgarProvider("StockAutotraderTest/1.0", async () => {
      calls += 1;
      return calls === 1
        ? new Response("busy", { status: 429, headers: { "Retry-After": "1" } })
        : jsonResponse({ filings: { recent: { form: [] } } });
    }, sleeper);
    await expect(provider.findRelevantFiling({ cik: "0000789012", scheduledDate: "2026-08-12", fiscalPeriodEnd: "2026-06-30" }, "2026-08-13")).resolves.toBeNull();
    expect(calls).toBe(2);
    expect(sleeper).toHaveBeenCalledWith(1000);
  });

  it("sends the SEC user agent, pads CIKs and prioritizes 8-K Item 2.02", async () => {
    const calls: Array<{ url: string; userAgent: string | null }> = [];
    const provider = new SecEdgarProvider("StockAutotraderTest/1.0 (+https://example.test/contact)", async (input, init) => {
      const url = input.toString();
      calls.push({ url, userAgent: new Headers(init?.headers).get("User-Agent") });
      if (url.includes("company_tickers_exchange")) {
        return jsonResponse({ fields: ["cik", "name", "ticker", "exchange"], data: [[789012, "Microsoft Corporation", "MSFT", "Nasdaq"]] });
      }
      return jsonResponse({ filings: { recent: {
        form: ["10-Q", "8-K", "8-K", "8-K"],
        filingDate: ["2026-08-12", "2026-08-13", "2026-08-13", "2026-08-13"],
        acceptanceDateTime: ["2026-08-12T13:00:00.000Z", "2026-08-13T20:02:03.000Z", "2026-08-13T20:02:03.000Z", "2026-08-13T20:04:00.000Z"],
        accessionNumber: ["0000789012-26-000010", "0000789012-26-000011", "0000789012-26-000011", "0000789012-26-000012"],
        primaryDocument: ["msft10q.htm", "msft8k.htm", "duplicate.htm", "other8k.htm"],
        reportDate: ["2026-06-30", "2026-06-30", "2026-06-30", "2026-06-30"],
        items: ["", "2.02", "2.02", "2.01"],
      } } });
    });
    const metadata = await provider.fetchCompanyMetadata("2026-08-13T14:00:00.000Z");
    expect(metadata.observations[0]).toMatchObject({ symbol: "MSFT", cik: "0000789012" });
    const filing = await provider.findRelevantFiling({ cik: "0000789012", scheduledDate: "2026-08-12", fiscalPeriodEnd: "2026-06-30" }, "2026-08-13");
    expect(filing).toMatchObject({ accession: "0000789012-26-000011", form: "8-K", filedAt: "2026-08-13T20:02:03.000Z" });
    expect(filing?.url).toContain("msft8k.htm");
    expect(calls.every((call) => call.userAgent === "StockAutotraderTest/1.0 (+https://example.test/contact)")).toBe(true);
    expect(new Set(calls.map((call) => call.url)).size).toBe(2);
  });

  it("ignores non-earnings SEC filings and duplicate accession rows", async () => {
    const provider = new SecEdgarProvider("StockAutotraderTest/1.0", async () => jsonResponse({ filings: { recent: {
      form: ["8-K", "8-K"],
      filingDate: ["2026-08-13", "2026-08-13"],
      acceptanceDateTime: ["2026-08-13T20:00:00.000Z", "2026-08-13T20:00:00.000Z"],
      accessionNumber: ["0000789012-26-000020", "0000789012-26-000020"],
      primaryDocument: ["bad.htm", "bad-duplicate.htm"],
      reportDate: ["2026-06-30", "2026-06-30"],
      items: ["2.01", "2.01"],
    } } }));
    await expect(provider.findRelevantFiling({ cik: "0000789012", scheduledDate: "2026-08-12", fiscalPeriodEnd: "2026-06-30" }, "2026-08-13")).resolves.toBeNull();
  });

  it("backfills official SEC calendar filings from the quarterly full index", async () => {
    const provider = new SecEdgarProvider("StockAutotraderTest/1.0", async (input) => {
      const url = input.toString();
      if (url.includes("company_tickers_exchange")) {
        return jsonResponse({ fields: ["cik", "name", "ticker", "exchange"], data: [[789012, "Microsoft Corporation", "MSFT", "Nasdaq"]] });
      }
      if (url.includes("full-index")) {
        return new Response([
          "CIK|Company Name|Form Type|Date Filed|Filename",
          "789012|Microsoft Corporation|10-Q|2026-06-30|edgar/data/789012/0000789012-26-000010.txt",
          "789012|Microsoft Corporation|10-K|2026-08-01|edgar/data/789012/0000789012-26-000011.txt",
          "789012|Microsoft Corporation|6-K|2026-08-02|edgar/data/789012/0000789012-26-000013.txt",
          "789012|Microsoft Corporation|8-K|2026-08-02|edgar/data/789012/0000789012-26-000012.txt",
        ].join("\n"));
      }
      throw new Error(`unexpected SEC URL: ${url}`);
    }, async () => undefined);
    await provider.fetchCompanyMetadata("2026-08-13T14:00:00.000Z");
    const result = await provider.fetchCalendar({ from: "2026-05-15", to: "2026-10-12" }, new Set(["MSFT"]), "2026-08-13T14:00:00.000Z");
    expect(result.observations).toHaveLength(2);
    expect(result.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ symbol: "MSFT", scheduledDate: "2026-06-30", providerEventId: "0000789012-26-000010" }),
      expect.objectContaining({ scheduledDate: "2026-08-01", officialFiling: expect.objectContaining({ form: "10-K" }) }),
    ]));
    expect(result.observations.every((observation) => observation.epsEstimate === null && observation.revenueEstimate === null)).toBe(true);
  });

  it("does not backfill 10-Q/A or 10-K/A as additional calendar events", async () => {
    const provider = new SecEdgarProvider("StockAutotraderTest/1.0", async (input) => {
      const url = input.toString();
      if (url.includes("company_tickers_exchange")) {
        return jsonResponse({ fields: ["cik", "name", "ticker", "exchange"], data: [[789012, "Microsoft Corporation", "MSFT", "Nasdaq"]] });
      }
      if (url.includes("full-index")) {
        return new Response([
          "CIK|Company Name|Form Type|Date Filed|Filename",
          "789012|Microsoft Corporation|10-Q|2026-06-30|edgar/data/789012/0000789012-26-000010.txt",
          "789012|Microsoft Corporation|10-Q/A|2026-08-01|edgar/data/789012/0000789012-26-000011.txt",
          "789012|Microsoft Corporation|10-K/A|2026-08-02|edgar/data/789012/0000789012-26-000012.txt",
        ].join("\n"));
      }
      throw new Error(`unexpected SEC URL: ${url}`);
    }, async () => undefined);

    await provider.fetchCompanyMetadata("2026-08-13T14:00:00.000Z");
    const result = await provider.fetchCalendar({ from: "2026-05-15", to: "2026-10-12" }, new Set(["MSFT"]), "2026-08-13T14:00:00.000Z");

    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]).toMatchObject({
      providerEventId: "0000789012-26-000010",
      officialFiling: { form: "10-Q" },
    });
    expect(result.observations.some((observation) => observation.officialFiling?.form.endsWith("/A"))).toBe(false);
  });
});

describe("earnings D1 write model and API", () => {
  it("requests the 90-day historical backfill plus the 60-day forward window", async () => {
    expect(EARNINGS_BACKFILL_DAYS).toBe(90);
    let requestedRange: { from: string; to: string } | null = null;
    const calendar: EarningsCalendarProvider = {
      name: "test-calendar",
      fetchCalendar: async (range) => {
        requestedRange = range;
        return { provider: "test-calendar", observations: [], warnings: [], updatedAt: "2026-08-13T06:00:00.000Z" };
      },
    };
    const official: OfficialFilingsProvider = {
      name: "test-sec",
      fetchCompanyMetadata: async () => ({ provider: "test-sec", observations: [], warnings: [], updatedAt: "2026-08-13T06:00:00.000Z" }),
      findRelevantFiling: async () => null,
    };
    await expect(runEarningsJob({ DB: new MemoryD1() } as never, new Date("2026-08-13T06:00:00.000Z"), "calendar", {
      calendar,
      consensus: calendar as never,
      official,
    })).resolves.toMatchObject({ status: "ok" });
    expect(requestedRange).toEqual({ from: "2026-05-15", to: "2026-10-12" });
  });

  it("preserves future schedule rows when the provider only reports filed history", async () => {
    const db = new MemoryD1();
    await upsertEarningsEvent(db, normalizedEvent({ scheduledDate: "2026-09-20", providerUpdatedAt: "2026-08-12T06:00:00.000Z" }));
    const calendar: EarningsCalendarProvider = {
      name: "official-history-only",
      supportsForwardCalendar: false,
      fetchCalendar: async () => ({ provider: "official-history-only", observations: [], warnings: [], updatedAt: "2026-08-13T06:00:00.000Z" }),
    };
    const official: OfficialFilingsProvider = {
      name: "test-sec",
      fetchCompanyMetadata: async () => ({ provider: "test-sec", observations: [], warnings: [], updatedAt: "2026-08-13T06:00:00.000Z" }),
      findRelevantFiling: async () => null,
    };
    await runEarningsJob({ DB: db } as never, new Date("2026-08-13T06:00:00.000Z"), "calendar", {
      calendar,
      consensus: calendar as never,
      official,
    });
    expect((await readEarningsEvents(db, { from: "2026-09-20", to: "2026-09-20" }))[0]?.status).toBe("scheduled");
  });

  it("upserts by fiscal identity when the provider moves the scheduled date", async () => {
    const db = new MemoryD1();
    const first = await upsertEarningsEvent(db, normalizedEvent());
    const moved = await upsertEarningsEvent(db, normalizedEvent({ scheduledDate: "2026-08-21", providerUpdatedAt: "2026-08-13T13:00:00.000Z" }));
    expect(first.id).toBe("MSFT-2026-Q1");
    expect(moved.id).toBe(first.id);
    expect(db.events.size).toBe(1);
    expect((await readEarningsEvents(db, { from: "2026-08-13", to: "2026-08-31" }))[0]?.scheduledDate).toBe("2026-08-21");
  });

  it("keeps provider IDs scoped while fiscal identity remains authoritative", async () => {
    const db = new MemoryD1();
    await upsertEarningsEvent(db, normalizedEvent({ fiscalQuarter: 1, providerEventId: "reused-id" }));
    const second = { ...normalizedEvent({ fiscalQuarter: 2, providerEventId: "reused-id", scheduledDate: "2026-09-20" }), calendarProvider: "other-provider" };
    await upsertEarningsEvent(db, second);
    expect(db.events.size).toBe(2);
  });

  it("does not merge two known fiscal periods that share a scheduled date", async () => {
    const db = new MemoryD1();
    await upsertEarningsEvent(db, normalizedEvent({ fiscalQuarter: 1, providerEventId: "q1" }));
    const second = await upsertEarningsEvent(db, normalizedEvent({ fiscalQuarter: 2, providerEventId: "q2" }));
    expect(second.id).toBe("MSFT-2026-Q2");
    expect(db.events.size).toBe(2);
  });

  it("uses the no-fiscal-period fallback once and preserves newer valid data", async () => {
    const db = new MemoryD1();
    const first = normalizedEvent({ fiscalYear: null, fiscalQuarter: null, fiscalPeriod: null, providerEventId: null });
    await upsertEarningsEvent(db, first);
    await upsertEarningsEvent(db, { ...normalizedEvent({ fiscalYear: null, fiscalQuarter: null, fiscalPeriod: null, providerEventId: null, scheduledDate: "2026-08-21", providerUpdatedAt: "2026-08-13T13:00:00.000Z" }), epsActual: 4, revenueActual: 120, reported: true, status: "reported", scheduled: false, unknown: false });
    const older = normalizedEvent({ fiscalYear: null, fiscalQuarter: null, fiscalPeriod: null, providerEventId: null, scheduledDate: "2026-08-21", epsActual: 2, revenueActual: 80, providerUpdatedAt: "2026-08-13T11:00:00.000Z" });
    await upsertEarningsEvent(db, older);
    const [event] = await readEarningsEvents(db, { from: "2026-08-13", to: "2026-08-31" });
    expect(event?.id).toBe(first.id);
    expect(event).toMatchObject({ scheduledDate: "2026-08-21", epsActual: 4, revenueActual: 120, status: "reported" });
  });

  it("preserves the newer lifecycle when rejecting an older provider payload", async () => {
    const db = new MemoryD1();
    await upsertEarningsEvent(db, normalizedEvent({
      scheduledDate: "2026-09-20",
      providerUpdatedAt: "2026-08-13T13:00:00.000Z",
    }));

    await upsertEarningsEvent(db, normalizedEvent({
      scheduledDate: "2026-08-10",
      providerUpdatedAt: "2026-08-13T11:00:00.000Z",
    }));

    const [event] = await readEarningsEvents(db, { from: "2026-08-13", to: "2026-09-30" });
    expect(event).toMatchObject({
      scheduledDate: "2026-09-20",
      status: "scheduled",
      scheduled: true,
      reported: false,
      cancelled: false,
      unknown: false,
    });
  });

  it("keeps history and supports the rolling query, symbol/status filters and validation", async () => {
    const db = new MemoryD1();
    await upsertEarningsEvent(db, normalizedEvent({ symbol: "MSFT", scheduledDate: "2026-02-10", fiscalQuarter: 2, providerEventId: "old", epsActual: 3.2, revenueActual: 101 }, "2026-02-11"));
    await upsertEarningsEvent(db, normalizedEvent({ symbol: "AAPL", scheduledDate: "2026-08-20", fiscalQuarter: 3, providerEventId: "future" }));
    const response = await readEarningsApi({ DB: db } as never, new URLSearchParams("from=2026-08-13&to=2026-10-12"), new Date("2026-08-13T12:00:00.000Z"));
    expect(response.events.map((event) => event.symbol)).toEqual(["AAPL"]);
    expect(response.summary.next60Days).toBe(1);
    const symbol = await readEarningsApi({ DB: db } as never, new URLSearchParams("symbol=aapl&status=scheduled"), new Date("2026-08-13T12:00:00.000Z"));
    expect(symbol.events).toHaveLength(1);
    await expect(readEarningsApi({ DB: db } as never, new URLSearchParams("from=2026-99-01"))).rejects.toBeInstanceOf(EarningsQueryError);
    await expect(readEarningsApi({ DB: db } as never, new URLSearchParams("from=2020-01-01&to=2026-12-31"))).rejects.toBeInstanceOf(EarningsQueryError);
    expect((await readEarningsEvents(db, { from: "2026-01-01", to: "2026-12-31" })).some((event) => event.scheduledDate === "2026-02-10")).toBe(true);
  });

  it("updates reports independently when one company has no official filing", async () => {
    const db = new MemoryD1();
    await upsertEarningsEvent(db, normalizedEvent({ symbol: "MSFT", scheduledDate: "2026-08-13", fiscalQuarter: 2, providerEventId: "monitor-msft" }));
    await upsertEarningsEvent(db, normalizedEvent({ symbol: "AAPL", scheduledDate: "2026-08-13", fiscalQuarter: 2, providerEventId: "monitor-aapl" }));
    const calendar: EarningsCalendarProvider = {
      name: "test-calendar",
      fetchCalendar: async () => ({
        provider: "test-calendar",
        observations: [
          eventObservation({ symbol: "MSFT", scheduledDate: "2026-08-13", fiscalQuarter: 2, providerEventId: "monitor-msft", epsActual: 3.2, revenueActual: 120 }),
          eventObservation({ symbol: "AAPL", scheduledDate: "2026-08-13", fiscalQuarter: 2, providerEventId: "monitor-aapl", epsActual: 1.1, revenueActual: 90 }),
        ],
        warnings: [],
        updatedAt: "2026-08-13T19:30:00.000Z",
      }),
    };
    const official: OfficialFilingsProvider = {
      name: "test-sec",
      fetchCompanyMetadata: async () => ({ provider: "test-sec", observations: [], warnings: [], updatedAt: "2026-08-13T19:30:00.000Z" }),
      findRelevantFiling: async () => null,
    };
    const providers: EarningsProviderBundle = { calendar, consensus: calendar as never, official };
    const result = await runEarningsJob({ DB: db } as never, new Date("2026-08-13T19:30:00.000Z"), "monitor", providers);
    expect(result.status).toBe("ok");
    expect((await readEarningsEvents(db, { from: "2026-08-13", to: "2026-08-13", status: "reported" })).map((event) => event.symbol)).toEqual(["AAPL", "MSFT"]);
  });

  it("detects a provider event that moved onto today without a scheduled D1 row", async () => {
    const db = new MemoryD1();
    const calendar: EarningsCalendarProvider = {
      name: "test-calendar",
      fetchCalendar: async () => ({
        provider: "test-calendar",
        observations: [eventObservation({
          symbol: "AAPL",
          scheduledDate: "2026-08-13",
          fiscalQuarter: 2,
          providerEventId: "moved-onto-today",
          epsActual: 2.1,
          revenueActual: 110,
        })],
        warnings: [],
        updatedAt: "2026-08-13T19:30:00.000Z",
      }),
    };
    const official: OfficialFilingsProvider = {
      name: "test-sec",
      fetchCompanyMetadata: async () => ({ provider: "test-sec", observations: [], warnings: [], updatedAt: "2026-08-13T19:30:00.000Z" }),
      findRelevantFiling: async () => null,
    };
    const result = await runEarningsJob({ DB: db } as never, new Date("2026-08-13T19:30:00.000Z"), "monitor", {
      calendar,
      consensus: calendar as never,
      official,
    });
    expect(result.status).toBe("ok");
    expect((await readEarningsEvents(db, { from: "2026-08-13", to: "2026-08-13", status: "reported" })).map((event) => event.symbol)).toEqual(["AAPL"]);
  });
});
