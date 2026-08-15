import { describe, expect, it, vi } from "vitest";
import { CORE_UNIVERSE, CORE_UNIVERSE_VERSION } from "@stock-autotrader/contracts";
import { EARNINGS_BACKFILL_DAYS, EarningsQueryError, readEarningsApi, runEarningsJob } from "./earnings";
import {
  addDays,
  buildEventId,
  calculateMetric,
  calculateOverallResult,
  endOfWeek,
  normalizeEvent,
  rollingEarningsRange,
  shouldPollEarnings,
  startOfWeek,
} from "./earnings/logic";
import {
  createDefaultEarningsProviders,
  FinnhubEarningsProvider,
  FmpEarningsCalendarProvider,
  SecEdgarProvider,
} from "./earnings/providers";
import {
  reconcileCoreUniverse,
  readEarningsEvents,
  upsertEarningsEvent,
  upsertUniverseMember,
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
    if (this.sql.includes("SELECT value FROM app_meta WHERE key = ?")) {
      const value = this.db.meta.get(String(this.args[0]));
      return (value === undefined ? null : { value }) as T | null;
    }
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
        .filter((row) => this.db.isActiveUniverseSymbol(String(row.symbol)) && row.symbol === this.args[0] && row.status === "scheduled" && row.fiscal_year === null)
        .sort((left, right) => String(right.scheduled_date).localeCompare(String(left.scheduled_date)));
      return { results: results as T[] };
    }
    if (this.sql.includes("FROM earnings_events") && this.sql.includes("status = 'reported'")) {
      const today = String(this.args[0]);
      const results = [...this.db.events.values()].filter((row) => this.db.isActiveUniverseSymbol(String(row.symbol)) && row.scheduled_date === today
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
          && this.db.isActiveUniverseSymbol(String(row.symbol))
          && row.scheduled_date >= from
          && row.scheduled_date <= to
          && (symbol === null || row.symbol === symbol)
          && (status === null || row.status === status))
        .sort((left, right) => String(right.scheduled_date).localeCompare(String(left.scheduled_date)) || String(left.symbol).localeCompare(String(right.symbol)));
      return { results: results as T[] };
    }
    if (this.sql.includes("FROM earnings_universe")) {
      const activeOnly = this.sql.includes("active = 1") && this.sql.includes("source = 'core'");
      const results = [...this.db.universe.values()].filter((row) => !activeOnly || this.db.isActiveUniverseSymbol(String(row.symbol)));
      return { results: results as T[] };
    }
    throw new Error(`Unhandled all SQL: ${this.sql}`);
  }

  async raw<T>(): Promise<T[]> {
    return [];
  }

  async run(): Promise<{ success: true; meta: { changes: number } }> {
    if (this.sql.startsWith("DELETE FROM app_meta")) {
      this.db.meta.delete(String(this.args[0]));
      return { success: true, meta: { changes: 1 } };
    }
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
    if (this.sql.includes("UPDATE earnings_universe") && this.sql.includes("SET active = 0")) {
      const [version, removedAt, updatedAt, ...desiredSymbols] = this.args;
      const desired = new Set(desiredSymbols.map(String));
      for (const row of this.db.universe.values()) {
        if (row.source === "core" && (Number(row.active) === 1 || row.removed_at == null) && !desired.has(String(row.symbol))) {
          row.active = 0;
          row.universe_version = version;
          row.removed_at = row.removed_at ?? removedAt;
          row.updated_at = updatedAt;
        }
      }
      return { success: true, meta: { changes: 1 } };
    }
    if (this.sql.includes("INSERT INTO earnings_universe")) {
      const [symbol, company, version, addedAt, updatedAt] = this.args;
      const previous = this.db.universe.get(String(symbol));
      this.db.universe.set(String(symbol), {
        ...previous,
        symbol,
        company: previous?.company ?? company,
        cik: previous?.cik ?? null,
        exchange: previous?.exchange ?? null,
        investor_relations_url: previous?.investor_relations_url ?? null,
        index_memberships: previous?.index_memberships ?? "[]",
        metadata_provider: previous?.metadata_provider ?? "core-universe",
        active: 1,
        source: "core",
        universe_version: version,
        added_at: previous?.added_at ?? addedAt,
        removed_at: null,
        updated_at: updatedAt,
      });
      return { success: true, meta: { changes: 1 } };
    }
    if (this.sql.includes("UPDATE earnings_universe") && this.sql.includes("SET company =")) {
      const [company, cik, exchange, investorRelationsUrl, indexes, metadataProvider, updatedAt, symbol] = this.args;
      const row = this.db.universe.get(String(symbol));
      if (row && Number(row.active) === 1 && row.source === "core") {
        row.company = company;
        row.cik = cik ?? row.cik ?? null;
        row.exchange = exchange ?? row.exchange ?? null;
        row.investor_relations_url = investorRelationsUrl ?? row.investor_relations_url ?? null;
        row.index_memberships = indexes;
        row.metadata_provider = metadataProvider;
        row.updated_at = updatedAt;
      }
      return { success: true, meta: { changes: row ? 1 : 0 } };
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

  isActiveUniverseSymbol(symbol: string): boolean {
    if (this.universe.size === 0) return true;
    const row = this.universe.get(symbol);
    return Boolean(row && Number(row.active) === 1 && row.source === "core");
  }

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

const seedActiveCoreUniverse = async (db: MemoryD1): Promise<void> => {
  await reconcileCoreUniverse(db as never, CORE_UNIVERSE, CORE_UNIVERSE_VERSION, "2026-08-13T06:00:00.000Z");
};

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
    expect(calculateMetric(1.004, 1).result).toBe("Beat");
    expect(calculateMetric(1, 1).result).toBe("In Line");
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

  it("does not present Finnhub collection time as a genuine report timestamp", () => {
    const event = normalizeEvent(eventObservation({ epsActual: 3.2, revenueActual: 110 }), "2026-08-13", "2026-08-13T12:00:00.000Z");
    expect(event.status).toBe("reported");
    expect(event.reportedAt).toBeNull();
    expect(event.providerUpdatedAt).toBe("2026-08-13T10:00:00.000Z");
  });

  it("polls BMO, AMC and TBD only during their ET windows", () => {
    expect(shouldPollEarnings("BMO", new Date("2026-08-13T11:00:00.000Z"))).toBe(true);
    expect(shouldPollEarnings("BMO", new Date("2026-08-13T16:00:00.000Z"))).toBe(false);
    expect(shouldPollEarnings("AMC", new Date("2026-08-13T19:30:00.000Z"))).toBe(true);
    expect(shouldPollEarnings("AMC", new Date("2026-08-13T13:00:00.000Z"))).toBe(false);
    expect(shouldPollEarnings("TBD", new Date("2026-08-13T17:00:00.000Z"))).toBe(true);
  });

  it("resolves every weekday of a Mon-Sun span to the same startOfWeek/endOfWeek, including Sunday", () => {
    // 2026-08-10 is a Monday; 2026-08-16 is the following Sunday. Every date
    // in that span must resolve to the same week, or a Sunday poll of
    // summary.thisWeek would silently report the wrong (forward) week.
    const monday = "2026-08-10";
    const sunday = "2026-08-16";
    for (const day of ["2026-08-10", "2026-08-11", "2026-08-12", "2026-08-13", "2026-08-14", "2026-08-15", "2026-08-16"]) {
      expect(startOfWeek(day)).toBe(monday);
      expect(endOfWeek(day)).toBe(sunday);
    }
    // The week rolls over cleanly on the following Monday.
    expect(startOfWeek("2026-08-17")).toBe("2026-08-17");
    expect(endOfWeek("2026-08-17")).toBe("2026-08-23");
  });
});

describe("free provider adapters", () => {
  it("selects Finnhub for calendar data with SEC official enrichment", () => {
    const providers = createDefaultEarningsProviders(undefined, "StockAutotraderTest/1.0");
    expect(providers.calendar).not.toBe(providers.official);
    expect(providers.consensus).toBe(providers.calendar);
    expect(providers.calendar.name).toBe("finnhub-earnings-calendar");
    expect(providers.official.name).toBe("sec-edgar");
  });

  it("normalizes the bulk Finnhub calendar, timing, metrics and universe filter", async () => {
    const calls: Array<{ url: string; token: string | null }> = [];
    const provider = new FinnhubEarningsProvider("test-key", async (input, init) => {
      calls.push({ url: input.toString(), token: new Headers(init?.headers).get("X-Finnhub-Token") });
      return jsonResponse({ earningsCalendar: [
        { symbol: "MSFT", date: "2026-08-20", hour: "bmo", quarter: 1, year: 2026, epsEstimate: 3, epsActual: 3.2, revenueEstimate: 100, revenueActual: 110 },
        { symbol: "AAPL", date: "2026-08-21", hour: "amc", quarter: 3, year: 2026, epsEstimate: 1, epsActual: 0.9, revenueEstimate: 90, revenueActual: 90 },
        { symbol: "NVDA", date: "2026-08-22", hour: "dmh", quarter: 2, year: 2026, epsEstimate: 0, epsActual: 0 },
        { symbol: "TSLA", date: "2026-08-23", quarter: 3, year: 2026, epsEstimate: null, epsActual: null, revenueEstimate: null, revenueActual: null },
        { symbol: "ABNB", date: "2026-08-23", hour: "bmo", quarter: 3, year: 2026 },
        { symbol: "PRIVATE", date: "2026-08-20", hour: "bmo", quarter: 1, year: 2026 },
      ] });
    });
    const result = await provider.fetchCalendar({ from: "2026-08-20", to: "2026-08-23" }, new Set(["MSFT", "AAPL", "NVDA", "TSLA", "ABNB", "PRIVATE"]), "2026-08-13T13:00:00.000Z");
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]!.url).search).toBe("?from=2026-08-20&to=2026-08-23");
    expect(calls[0]!.token).toBe("test-key");
    expect(result.complete).toBe(true);
    expect(result.observations).toHaveLength(4);
    expect(result.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ symbol: "MSFT", timing: "BMO", scheduledTime: "BMO", epsActual: 3.2, revenueActual: 110 }),
      expect.objectContaining({ symbol: "AAPL", timing: "AMC", epsActual: 0.9, revenueActual: 90 }),
      expect.objectContaining({ symbol: "NVDA", timing: "TBD", epsEstimate: 0, epsActual: 0 }),
      expect.objectContaining({ symbol: "TSLA", timing: "TBD", epsEstimate: null, revenueActual: null }),
    ]));
    expect(result.observations.some((row) => row.symbol === "PRIVATE")).toBe(false);
    expect(result.observations.some((row) => row.symbol === "ABNB")).toBe(false);
  });

  it("marks a mixed Finnhub payload incomplete without discarding valid rows", async () => {
    const provider = new FinnhubEarningsProvider("test-key", async () => jsonResponse({ earningsCalendar: [
      { symbol: "MSFT", date: "2026-08-20", hour: "amc", quarter: 1, year: 2026 },
      { symbol: "AAPL", date: "not-a-date", hour: "bmo", quarter: 3, year: 2026 },
    ] }));
    const result = await provider.fetchCalendar(providerRange, providerUniverse, "2026-08-13T12:00:00.000Z");
    expect(result.complete).toBe(false);
    expect(result.warnings[0]).toContain("malformed");
    expect(result.observations).toEqual([expect.objectContaining({ symbol: "MSFT", scheduledDate: "2026-08-20" })]);
  });

  it("fails closed on malformed Finnhub rows and retries rate limits without exposing a token", async () => {
    const malformed = new FinnhubEarningsProvider("test-key", async () => jsonResponse({ earningsCalendar: [null] }));
    await expect(malformed.fetchCalendar(providerRange, providerUniverse, "2026-08-13T13:00:00.000Z")).rejects.toThrow("malformed");

    let calls = 0;
    const sleeper = vi.fn(async () => undefined);
    const rateLimited = new FinnhubEarningsProvider("test-key", async (_input, init) => {
      expect(new Headers(init?.headers).get("X-Finnhub-Token")).toBe("test-key");
      calls += 1;
      return calls === 1
        ? new Response("busy", { status: 429, headers: { "Retry-After": "1" } })
        : jsonResponse({ earningsCalendar: [] });
    }, sleeper);
    await expect(rateLimited.fetchCalendar(providerRange, providerUniverse, "2026-08-13T13:00:00.000Z")).resolves.toMatchObject({ observations: [] });
    expect(calls).toBe(2);
    expect(sleeper).toHaveBeenCalledWith(1000);
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
  it("requests the 30-day historical backfill plus the 60-day forward window", async () => {
    expect(EARNINGS_BACKFILL_DAYS).toBe(30);
    let requestedRange: { from: string; to: string } | null = null;
    let requestedUniverse: Set<string> | null = null;
    const calendar: EarningsCalendarProvider = {
      name: "test-calendar",
      fetchCalendar: async (range, universe) => {
        requestedRange = range;
        requestedUniverse = new Set(universe);
        return {
          provider: "test-calendar",
          observations: [
            eventObservation({ symbol: "MSFT", providerEventId: "core-msft" }),
            eventObservation({ symbol: "ABNB", providerEventId: "legacy-abnb" }),
          ],
          warnings: [],
          updatedAt: "2026-08-13T06:00:00.000Z",
        };
      },
    };
    const official: OfficialFilingsProvider = {
      name: "test-sec",
      fetchCompanyMetadata: async () => ({ provider: "test-sec", observations: [], warnings: [], updatedAt: "2026-08-13T06:00:00.000Z" }),
      findRelevantFiling: async () => null,
    };
    const db = new MemoryD1();
    await expect(runEarningsJob({ DB: db } as never, new Date("2026-08-13T06:00:00.000Z"), "calendar", {
      calendar,
      consensus: calendar as never,
      official,
    })).resolves.toMatchObject({ status: "ok" });
    expect(requestedRange).toEqual({ from: "2026-07-14", to: "2026-10-12" });
    expect(requestedUniverse).toEqual(new Set(CORE_UNIVERSE));
    expect([...db.events.values()].map((event) => event.symbol)).toEqual(["MSFT"]);
    expect(db.universe.size).toBe(50);
  });

  it("preserves the last valid calendar when Finnhub fails", async () => {
    const db = new MemoryD1();
    await upsertEarningsEvent(db, normalizedEvent({ scheduledDate: "2026-09-20" }));
    const calendar: EarningsCalendarProvider = {
      name: "finnhub-test",
      supportsForwardCalendar: true,
      fetchCalendar: async () => { throw new Error("Finnhub HTTP 503"); },
    };
    const official: OfficialFilingsProvider = {
      name: "test-sec",
      fetchCompanyMetadata: async () => ({ provider: "test-sec", observations: [], warnings: [], updatedAt: "2026-08-13T06:00:00.000Z" }),
      findRelevantFiling: async () => null,
    };
    await expect(runEarningsJob({ DB: db } as never, new Date("2026-08-13T06:00:00.000Z"), "calendar", {
      calendar,
      consensus: calendar as never,
      official,
    })).resolves.toMatchObject({ status: "degraded" });
    expect((await readEarningsEvents(db, { from: "2026-09-20", to: "2026-09-20" }))[0]).toMatchObject({ status: "scheduled", scheduledDate: "2026-09-20" });
    expect(db.meta.get("earningsEngineUpdatedAt")).toBeUndefined();
    expect(db.meta.get("earningsEngineLastAttemptAt")).toBe("2026-08-13T06:00:00.000Z");
    expect(db.meta.get("earningsCalendarLastError")).toContain("Finnhub HTTP 503");
    expect(db.meta.get("earningsEngineLastError")).toContain("Finnhub HTTP 503");
  });

  it("keeps a daily calendar failure degraded after a later successful monitor poll", async () => {
    const db = new MemoryD1();
    await upsertEarningsEvent(db, normalizedEvent({ scheduledDate: "2026-08-13", providerEventId: "monitor-msft" }));
    let failCalendar = true;
    const calendar: EarningsCalendarProvider = {
      name: "finnhub-test",
      supportsForwardCalendar: true,
      fetchCalendar: async () => {
        if (failCalendar) throw new Error("Finnhub HTTP 503");
        return {
          provider: "finnhub-test",
          observations: [eventObservation({
            scheduledDate: "2026-08-13",
            providerEventId: "monitor-msft",
            epsActual: 3.2,
            revenueActual: 110,
          })],
          warnings: [],
          updatedAt: "2026-08-13T19:30:00.000Z",
        };
      },
    };
    const official: OfficialFilingsProvider = {
      name: "test-sec",
      fetchCompanyMetadata: async () => ({ provider: "test-sec", observations: [], warnings: [], updatedAt: "2026-08-13T06:00:00.000Z" }),
      findRelevantFiling: async () => null,
    };
    const providers = { calendar, consensus: calendar as never, official };

    await expect(runEarningsJob({ DB: db } as never, new Date("2026-08-13T06:00:00.000Z"), "calendar", providers))
      .resolves.toMatchObject({ status: "degraded" });
    failCalendar = false;
    await expect(runEarningsJob({ DB: db } as never, new Date("2026-08-13T19:30:00.000Z"), "monitor", providers))
      .resolves.toMatchObject({ status: "ok" });

    expect(db.meta.get("earningsCalendarLastError")).toContain("Finnhub HTTP 503");
    expect(db.meta.get("earningsMonitorLastError")).toBeUndefined();
    expect(db.meta.get("earningsEngineLastError")).toContain("Finnhub HTTP 503");
    expect(db.meta.get("earningsEngineCheckedAt")).toBe("2026-08-13T19:30:00.000Z");
    expect(db.meta.get("earningsEngineLastAttemptAt")).toBe("2026-08-13T19:30:00.000Z");
  });

  it("preserves scheduled events when a calendar payload is only partially parsed", async () => {
    const db = new MemoryD1();
    await upsertEarningsEvent(db, normalizedEvent({ symbol: "AAPL", scheduledDate: "2026-08-20", providerEventId: "aapl-existing" }));
    const calendar: EarningsCalendarProvider = {
      name: "finnhub-test",
      supportsForwardCalendar: true,
      fetchCalendar: async () => ({
        provider: "finnhub-test",
        observations: [eventObservation({ providerEventId: "msft-valid", scheduledDate: "2026-08-21" })],
        warnings: ["ignored 1 malformed Finnhub calendar row(s)"],
        complete: false,
        updatedAt: "2026-08-13T06:00:00.000Z",
      }),
    };
    const official: OfficialFilingsProvider = {
      name: "test-sec",
      fetchCompanyMetadata: async () => ({ provider: "test-sec", observations: [], warnings: [], updatedAt: "2026-08-13T06:00:00.000Z" }),
      findRelevantFiling: async () => null,
    };
    await expect(runEarningsJob({ DB: db } as never, new Date("2026-08-13T06:00:00.000Z"), "calendar", {
      calendar,
      consensus: calendar as never,
      official,
    })).resolves.toMatchObject({ status: "degraded" });

    expect((await readEarningsEvents(db, { from: "2026-08-20", to: "2026-08-20" }))[0]).toMatchObject({
      symbol: "AAPL",
      status: "scheduled",
    });
    expect(db.meta.get("earningsCalendarLastError")).toContain("malformed");
  });

  it("is idempotent when the same bulk calendar is synced twice", async () => {
    const db = new MemoryD1();
    const calendar: EarningsCalendarProvider = {
      name: "finnhub-test",
      supportsForwardCalendar: true,
      fetchCalendar: async () => ({ provider: "finnhub-test", observations: [eventObservation({ scheduledDate: "2026-08-20", providerEventId: "finnhub:MSFT:2026:1:2026-08-20" })], warnings: [], updatedAt: "2026-08-13T06:00:00.000Z" }),
    };
    const official: OfficialFilingsProvider = {
      name: "test-sec",
      fetchCompanyMetadata: async () => ({ provider: "test-sec", observations: [], warnings: [], updatedAt: "2026-08-13T06:00:00.000Z" }),
      findRelevantFiling: async () => null,
    };
    const providers = { calendar, consensus: calendar as never, official };
    await runEarningsJob({ DB: db } as never, new Date("2026-08-13T06:00:00.000Z"), "calendar", providers);
    await runEarningsJob({ DB: db } as never, new Date("2026-08-13T06:00:00.000Z"), "calendar", providers);
    expect(db.events.size).toBe(1);
  });

  it("gates empty monitor polls to hourly discovery", async () => {
    const db = new MemoryD1();
    let calls = 0;
    const calendar: EarningsCalendarProvider = {
      name: "finnhub-test",
      fetchCalendar: async () => { calls += 1; return { provider: "finnhub-test", observations: [], warnings: [], updatedAt: "2026-08-13T19:00:00.000Z" }; },
    };
    const official: OfficialFilingsProvider = {
      name: "test-sec",
      fetchCompanyMetadata: async () => ({ provider: "test-sec", observations: [], warnings: [], updatedAt: "2026-08-13T19:00:00.000Z" }),
      findRelevantFiling: async () => null,
    };
    const providers = { calendar, consensus: calendar as never, official };
    await expect(runEarningsJob({ DB: db } as never, new Date("2026-08-13T19:00:00.000Z"), "monitor", providers)).resolves.toMatchObject({ status: "ok" });
    await expect(runEarningsJob({ DB: db } as never, new Date("2026-08-13T19:15:00.000Z"), "monitor", providers)).resolves.toMatchObject({ status: "skipped" });
    expect(calls).toBe(1);
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

  it("surfaces active Core earnings but never surfaces an inactive historical member", async () => {
    const db = new MemoryD1();
    await seedActiveCoreUniverse(db);
    db.universe.set("ABNB", {
      symbol: "ABNB",
      active: 0,
      source: "core",
      universe_version: 1,
      added_at: "2026-08-01T00:00:00.000Z",
      removed_at: "2026-08-14T06:00:00.000Z",
      updated_at: "2026-08-14T06:00:00.000Z",
    });
    await upsertEarningsEvent(db, normalizedEvent({ symbol: "NVDA", scheduledDate: "2026-08-20", providerEventId: "active-nvda" }));
    await upsertEarningsEvent(db, normalizedEvent({ symbol: "ABNB", scheduledDate: "2026-08-20", providerEventId: "removed-abnb" }));

    const events = await readEarningsEvents(db, { from: "2026-08-20", to: "2026-08-20" });
    expect(events.map((event) => event.symbol)).toEqual(["NVDA"]);
  });

  it("updates reports independently when one company has no official filing", async () => {
    const db = new MemoryD1();
    await seedActiveCoreUniverse(db);
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
    await seedActiveCoreUniverse(db);
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

describe("SEC EDGAR enrichment decoupling (issue #35)", () => {
  const finnhubCalendar = (observations: EarningsCalendarObservation[]): EarningsCalendarProvider => ({
    name: "finnhub-test",
    supportsForwardCalendar: true,
    fetchCalendar: async () => ({
      provider: "finnhub-test",
      observations,
      warnings: [],
      updatedAt: "2026-08-13T06:00:00.000Z",
    }),
  });

  it("keeps earnings critical health healthy when SEC EDGAR returns 403 while the Finnhub calendar succeeds", async () => {
    const db = new MemoryD1();
    const official = new SecEdgarProvider(
      "StockAutotraderTest/1.0 (+https://example.test/contact)",
      async () => jsonResponse({ error: "forbidden" }, 403),
    );
    const calendar = finnhubCalendar([eventObservation({ providerEventId: "finnhub:MSFT:2026:1:2026-08-20" })]);
    const result = await runEarningsJob({ DB: db } as never, new Date("2026-08-13T06:00:00.000Z"), "calendar", {
      calendar,
      consensus: calendar as never,
      official,
    });
    // SEC enrichment failure is observable in diagnostics + job log, but the
    // critical job status and calendar/monitor failure keys must stay clean.
    expect(result.status).toBe("ok");
    expect(db.meta.get("earningsCalendarLastError")).toBeUndefined();
    expect(db.meta.get("earningsMonitorLastError")).toBeUndefined();
    expect(db.meta.get("earningsEngineLastError")).toBeUndefined();
    expect(db.meta.get("earningsEngineUpdatedAt")).toBe("2026-08-13T06:00:00.000Z");
    // SEC diagnostics recorded separately.
    expect(db.meta.get("earningsSecLastAttemptAt")).toBe("2026-08-13T06:00:00.000Z");
    expect(db.meta.get("earningsSecLastError")).toContain("403");
    expect(db.meta.get("earningsSecConsecutiveFailures")).toBe("1");
    // The valid Finnhub calendar event survives without official enrichment.
    const [event] = await readEarningsEvents(db, { from: "2026-08-20", to: "2026-08-20" });
    expect(event).toMatchObject({ symbol: "MSFT", status: "scheduled", scheduledDate: "2026-08-20" });
    expect(event?.secFilingUrl).toBeNull();
  });

  it("keeps earnings critical health healthy when SEC EDGAR fails with a network error/timeout", async () => {
    const db = new MemoryD1();
    const official = new SecEdgarProvider(
      "StockAutotraderTest/1.0 (+https://example.test/contact)",
      async () => { throw new TypeError("fetch failed"); },
    );
    const calendar = finnhubCalendar([eventObservation({ providerEventId: "finnhub:MSFT:2026:1:2026-08-20" })]);
    const result = await runEarningsJob({ DB: db } as never, new Date("2026-08-13T06:00:00.000Z"), "calendar", {
      calendar,
      consensus: calendar as never,
      official,
    });
    expect(result.status).toBe("ok");
    expect(db.meta.get("earningsCalendarLastError")).toBeUndefined();
    expect(db.meta.get("earningsMonitorLastError")).toBeUndefined();
    expect(db.meta.get("earningsEngineLastError")).toBeUndefined();
    expect(db.meta.get("earningsSecLastAttemptAt")).toBe("2026-08-13T06:00:00.000Z");
    expect(db.meta.get("earningsSecLastError")).toContain("fetch failed");
    // One logical SEC call failed (provider-internal retries are bounded
    // inside the adapter, MAX_PROVIDER_ATTEMPTS = 2).
    expect(db.meta.get("earningsSecConsecutiveFailures")).toBe("1");
  });

  it("marks earnings critical health degraded when the Finnhub calendar fails even if SEC enrichment succeeds", async () => {
    const db = new MemoryD1();
    const calendar: EarningsCalendarProvider = {
      name: "finnhub-test",
      supportsForwardCalendar: true,
      fetchCalendar: async () => { throw new Error("Finnhub HTTP 503"); },
    };
    const official: OfficialFilingsProvider = {
      name: "test-sec",
      fetchCompanyMetadata: async () => ({
        provider: "test-sec",
        observations: [{ symbol: "MSFT", company: "Microsoft Corporation", cik: "0000789012", exchange: "NASDAQ" }],
        warnings: [],
        updatedAt: "2026-08-13T06:00:00.000Z",
      }),
      findRelevantFiling: async () => null,
    };
    const result = await runEarningsJob({ DB: db } as never, new Date("2026-08-13T06:00:00.000Z"), "calendar", {
      calendar,
      consensus: calendar as never,
      official,
    });
    expect(result.status).toBe("degraded");
    // Critical health reflects the Finnhub calendar failure regardless of SEC.
    expect(db.meta.get("earningsCalendarLastError")).toContain("Finnhub HTTP 503");
    expect(db.meta.get("earningsEngineLastError")).toContain("Finnhub HTTP 503");
    expect(db.meta.get("earningsEngineUpdatedAt")).toBeUndefined();
    // SEC enrichment itself succeeded and is recorded as healthy.
    expect(db.meta.get("earningsSecLastAttemptAt")).toBe("2026-08-13T06:00:00.000Z");
    expect(db.meta.get("earningsSecLastSuccessAt")).toBe("2026-08-13T06:00:00.000Z");
    expect(db.meta.get("earningsSecLastError")).toBeUndefined();
    expect(db.meta.get("earningsSecConsecutiveFailures")).toBe("0");
  });

  it("records SEC enrichment success and populates official filing fields", async () => {
    const db = new MemoryD1();
    const filing = {
      url: "https://www.sec.gov/Archives/edgar/data/789012/000078901226000010/0000789012-26-000010-index.html",
      accession: "0000789012-26-000010",
      form: "10-Q",
      filedAt: "2026-08-12T20:00:00.000Z",
      reportDate: null,
      items: [] as string[],
    };
    const official: OfficialFilingsProvider = {
      name: "test-sec",
      fetchCompanyMetadata: async () => ({
        provider: "test-sec",
        observations: [{ symbol: "MSFT", company: "Microsoft Corporation", cik: "0000789012", exchange: "NASDAQ" }],
        warnings: [],
        updatedAt: "2026-08-13T06:00:00.000Z",
      }),
      findRelevantFiling: async () => filing,
    };
    const calendar = finnhubCalendar([eventObservation({ scheduledDate: "2026-08-12", providerEventId: "finnhub:MSFT:2026:1:2026-08-12", epsActual: 3.2, revenueActual: 110 })]);
    const result = await runEarningsJob({ DB: db } as never, new Date("2026-08-13T06:00:00.000Z"), "calendar", {
      calendar,
      consensus: calendar as never,
      official,
    });
    expect(result.status).toBe("ok");
    expect(db.meta.get("earningsCalendarLastError")).toBeUndefined();
    expect(db.meta.get("earningsSecLastSuccessAt")).toBe("2026-08-13T06:00:00.000Z");
    expect(db.meta.get("earningsSecLastError")).toBeUndefined();
    expect(db.meta.get("earningsSecConsecutiveFailures")).toBe("0");
    const [event] = await readEarningsEvents(db, { from: "2026-08-12", to: "2026-08-12" });
    expect(event).toMatchObject({
      symbol: "MSFT",
      status: "reported",
      epsActual: 3.2,
      revenueActual: 110,
      secAccession: "0000789012-26-000010",
      secForm: "10-Q",
      secFilingUrl: filing.url,
    });
  });

  it("keeps the monitor job status ok when SEC filing enrichment fails", async () => {
    const db = new MemoryD1();
    await seedActiveCoreUniverse(db);
    await upsertUniverseMember(db, { symbol: "MSFT", company: "Microsoft Corporation", cik: "0000789012", exchange: null, indexes: [], updatedAt: "2026-08-13T06:00:00.000Z" });
    await upsertEarningsEvent(db, normalizedEvent({ scheduledDate: "2026-08-13", providerEventId: "monitor-msft" }));
    const calendar: EarningsCalendarProvider = {
      name: "finnhub-test",
      fetchCalendar: async () => ({
        provider: "finnhub-test",
        observations: [eventObservation({ scheduledDate: "2026-08-13", providerEventId: "monitor-msft" })],
        warnings: [],
        updatedAt: "2026-08-13T19:30:00.000Z",
      }),
    };
    const official = new SecEdgarProvider(
      "StockAutotraderTest/1.0 (+https://example.test/contact)",
      async () => jsonResponse({ error: "forbidden" }, 403),
    );
    const result = await runEarningsJob({ DB: db } as never, new Date("2026-08-13T19:30:00.000Z"), "monitor", {
      calendar,
      consensus: calendar as never,
      official,
    });
    // The critical Finnhub-backed monitor path succeeded; the SEC filing
    // lookup failure stays diagnostic-only.
    expect(result.status).toBe("ok");
    expect(db.meta.get("earningsMonitorLastError")).toBeUndefined();
    expect(db.meta.get("earningsCalendarLastError")).toBeUndefined();
    expect(db.meta.get("earningsSecLastAttemptAt")).toBe("2026-08-13T19:30:00.000Z");
    expect(db.meta.get("earningsSecLastError")).toContain("403");
    expect(db.meta.get("earningsSecConsecutiveFailures")).toBe("1");
  });

  it("preserves valid Finnhub data and prior SEC enrichment when a later SEC run fails", async () => {
    const db = new MemoryD1();
    const filing = {
      url: "https://www.sec.gov/Archives/edgar/data/789012/000078901226000010/0000789012-26-000010-index.html",
      accession: "0000789012-26-000010",
      form: "10-Q",
      filedAt: "2026-08-12T20:00:00.000Z",
      reportDate: null,
      items: [] as string[],
    };
    let secHealthy = true;
    const official: OfficialFilingsProvider = {
      name: "test-sec",
      fetchCompanyMetadata: async () => {
        if (!secHealthy) throw new Error("provider HTTP 403");
        return {
          provider: "test-sec",
          observations: [{ symbol: "MSFT", company: "Microsoft Corporation", cik: "0000789012", exchange: "NASDAQ" }],
          warnings: [],
          updatedAt: "2026-08-13T06:00:00.000Z",
        };
      },
      findRelevantFiling: async () => {
        if (!secHealthy) throw new Error("provider HTTP 403");
        return filing;
      },
    };
    const observation = eventObservation({ scheduledDate: "2026-08-12", providerEventId: "finnhub:MSFT:2026:1:2026-08-12", epsActual: 3.2, revenueActual: 110 });
    const calendar = finnhubCalendar([observation]);
    const providers = {
      calendar,
      consensus: calendar as never,
      official,
    };
    await expect(runEarningsJob({ DB: db } as never, new Date("2026-08-13T06:00:00.000Z"), "calendar", providers)).resolves.toMatchObject({ status: "ok" });
    // SEC goes down; the same Finnhub calendar rows are synced again. The
    // critical job status stays ok — SEC is enrichment-only — while the SEC
    // diagnostics record the failure.
    secHealthy = false;
    await expect(runEarningsJob({ DB: db } as never, new Date("2026-08-13T06:00:00.000Z"), "calendar", providers)).resolves.toMatchObject({ status: "ok" });
    // Critical health stays clean; SEC diagnostics show the new failure.
    expect(db.meta.get("earningsCalendarLastError")).toBeUndefined();
    expect(db.meta.get("earningsSecLastError")).toContain("403");
    // Run 2: metadata call + filing lookup both failed (2 logical SEC calls).
    expect(db.meta.get("earningsSecConsecutiveFailures")).toBe("2");
    // The valid event keeps its Finnhub data and its prior official enrichment.
    const [event] = await readEarningsEvents(db, { from: "2026-08-12", to: "2026-08-12" });
    expect(event).toMatchObject({
      symbol: "MSFT",
      status: "reported",
      epsActual: 3.2,
      revenueActual: 110,
      secAccession: "0000789012-26-000010",
      secForm: "10-Q",
      secFilingUrl: filing.url,
    });
  });
});
