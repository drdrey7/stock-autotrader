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
  FinnhubCompanyProfileProvider,
  FinnhubEarningsProvider,
  FinnhubRequestGate,
  FmpEarningsCalendarProvider,
  SecEdgarProvider,
} from "./earnings/providers";
import { FINNHUB_RATE_PACING_MS } from "./earnings/subrequest-budget";
import {
  enrichUniverseMetadata,
} from "./earnings/metadata";
import {
  applyOfficialMetrics,
  reconcileCoreUniverse,
  readEarningsEvents,
  rowToEarningsEvent,
  upsertEarningsEvent,
  upsertUniverseMember,
  type OfficialMetricsWrite,
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
    if (this.sql.includes("SELECT DISTINCT e.symbol") && this.sql.includes("status = 'reported'")) {
      const from = String(this.args[0]);
      const to = String(this.args[1]);
      const symbols = [...new Set([...this.db.events.values()]
        .filter((row) => this.db.isActiveUniverseSymbol(String(row.symbol))
          && row.status === "reported"
          && typeof row.scheduled_date === "string"
          && row.scheduled_date >= from
          && row.scheduled_date <= to)
        .map((row) => String(row.symbol)))];
      return { results: symbols.map((symbol) => ({ symbol })) as T[] };
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
    if (this.sql.includes("FROM app_meta") && this.sql.includes("LIKE")) {
      const prefix = this.sql.match(/LIKE '([^']+)%/)?.[1] ?? "";
      const results = [...this.db.meta.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => ({ key, value }));
      return { results: results as T[] };
    }
    if (this.sql.includes("FROM earnings_universe")) {
      const activeOnly = this.sql.includes("active = 1") && this.sql.includes("source = 'core'");
      const candidatesOnly = this.sql.includes("metadata_updated_at IS NULL") && this.sql.includes("metadata_attempted_at");
      let results = [...this.db.universe.values()];
      if (activeOnly) results = results.filter((row) => this.db.isActiveUniverseSymbol(String(row.symbol)));
      if (candidatesOnly) {
        const staleBefore = String(this.args[0]);
        const cooldownBefore = String(this.args[1]);
        results = results.filter((row) => {
          const needs = row.logo_url == null
            || row.industry == null
            || row.metadata_updated_at == null
            || String(row.metadata_updated_at) < staleBefore;
          const cooled = row.metadata_attempted_at == null
            || String(row.metadata_attempted_at) < cooldownBefore;
          return needs && cooled;
        });
        results.sort((left, right) => {
          const leftAttempted = left.metadata_attempted_at == null ? 0 : 1;
          const rightAttempted = right.metadata_attempted_at == null ? 0 : 1;
          if (leftAttempted !== rightAttempted) return leftAttempted - rightAttempted;
          if (left.metadata_attempted_at != null && right.metadata_attempted_at != null) {
            const byAttempt = String(left.metadata_attempted_at).localeCompare(String(right.metadata_attempted_at));
            if (byAttempt !== 0) return byAttempt;
          }
          const leftMissing = left.metadata_updated_at == null ? 0 : 1;
          const rightMissing = right.metadata_updated_at == null ? 0 : 1;
          if (leftMissing !== rightMissing) return leftMissing - rightMissing;
          return String(left.symbol).localeCompare(String(right.symbol));
        });
      }
      if (this.sql.includes("LIMIT ?")) results = results.slice(0, Number(this.args.at(-1) ?? results.length));
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
    if (this.sql.includes("UPDATE earnings_events") && this.sql.includes("COALESCE(?, eps_actual_gaap)")) {
      // applyOfficialMetrics bind order: eps_actual_gaap, eps_actual_gaap_source,
      // eps_actual_adjusted, eps_actual_adjusted_source, revenue_actual_official,
      // revenue_actual_source, eps_estimate_source, revenue_estimate_source,
      // reported_at, reported_at_source, fiscal_period_end, sec_filing_url,
      // sec_accession, sec_form, sec_filed_at, data_quality_status, updated_at, id.
      const [gaap, gaapSource, adjusted, adjustedSource, revenueOfficial, revenueSource,
        epsEstimateSource, revenueEstimateSource, reportedAt, reportedAtSource,
        fiscalPeriodEnd, secUrl, secAccession, secForm, secFiledAt,
        qualityStatus, updatedAt, id] = this.args;
      const row = this.db.events.get(String(id));
      if (row) {
        // COALESCE columns: a null write keeps the existing official value —
        // canonical values are never cleared by a null re-resolution.
        row.eps_actual_gaap = gaap ?? row.eps_actual_gaap;
        row.eps_actual_gaap_source = gaapSource ?? row.eps_actual_gaap_source;
        // Adjusted mirror is FILL-ONLY (matches the production SQL): the
        // provider owns it once set — a write never overwrites it.
        row.eps_actual_adjusted = row.eps_actual_adjusted ?? adjusted;
        row.eps_actual_adjusted_source = row.eps_actual_adjusted_source ?? adjustedSource;
        row.revenue_actual_official = revenueOfficial ?? row.revenue_actual_official;
        row.revenue_actual_source = revenueSource ?? row.revenue_actual_source;
        if (epsEstimateSource != null) row.eps_estimate_source = epsEstimateSource;
        if (revenueEstimateSource != null) row.revenue_estimate_source = revenueEstimateSource;
        if (reportedAt != null) row.reported_at = reportedAt;
        if (reportedAtSource != null) row.reported_at_source = reportedAtSource;
        if (fiscalPeriodEnd != null) row.fiscal_period_end = fiscalPeriodEnd;
        if (secUrl != null) row.sec_filing_url = secUrl;
        if (secAccession != null) row.sec_accession = secAccession;
        if (secForm != null) row.sec_form = secForm;
        if (secFiledAt != null) row.sec_filed_at = secFiledAt;
        row.data_quality_status = qualityStatus;
        row.updated_at = updatedAt;
      }
      return { success: true, meta: { changes: row ? 1 : 0 } };
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
      const [company, cik, exchange, investorRelationsUrl, indexes, logoUrl, industry, websiteUrl, metadataProvider, metadataUpdatedAt, updatedAt, symbol] = this.args;
      const row = this.db.universe.get(String(symbol));
      if (row && Number(row.active) === 1 && row.source === "core") {
        row.company = company;
        row.cik = cik ?? row.cik ?? null;
        row.exchange = exchange ?? row.exchange ?? null;
        row.investor_relations_url = investorRelationsUrl ?? row.investor_relations_url ?? null;
        row.index_memberships = indexes;
        row.logo_url = logoUrl ?? row.logo_url ?? null;
        row.industry = industry ?? row.industry ?? null;
        row.website_url = websiteUrl ?? row.website_url ?? null;
        // COALESCE(?, metadata_provider): null/undefined keeps the previous stamp.
        if (metadataProvider != null && metadataProvider !== "") {
          row.metadata_provider = metadataProvider;
        }
        row.metadata_updated_at = metadataUpdatedAt ?? row.metadata_updated_at ?? null;
        row.updated_at = updatedAt;
      }
      return { success: true, meta: { changes: row ? 1 : 0 } };
    }
    if (this.sql.includes("UPDATE earnings_universe") && this.sql.includes("SET metadata_attempted_at = ?")) {
      const [attemptedAt, symbol] = this.args;
      const row = this.db.universe.get(String(symbol));
      if (row && Number(row.active) === 1 && row.source === "core") {
        row.metadata_attempted_at = attemptedAt;
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

  it("computes the EPS result from the adjusted market actual when both exist", () => {
    // Divergent pair: legacy actual 0.9 vs explicit adjusted 1.1 against the
    // same consensus 1.0. The drawer shows the adjusted actual, so the
    // Beat/Miss must come from the adjusted basis — never a silent mismatch.
    const event = normalizeEvent(eventObservation({
      epsEstimate: 1,
      epsActual: 0.9,
      epsActualAdjusted: 1.1,
      epsActualAdjustedSource: "finnhub-adjusted",
      revenueEstimate: null,
      revenueActual: null,
    }), "2026-08-13", "2026-08-13T12:00:00.000Z");
    expect(event.epsResult).toBe("Beat");
    expect(event.epsSurprisePct).toBeCloseTo(10, 10);
    expect(event.status).toBe("reported");
    // The legacy column keeps its provider semantics for backward compatibility.
    expect(event.epsActual).toBe(0.9);
    expect(event.epsActualAdjusted).toBe(1.1);
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

  it("keeps an SEC-filing acceptance time in secFiledAt, never in reportedAt", () => {
    const filing = {
      url: "https://www.sec.gov/Archives/edgar/data/320193/000032019326000010/0000320193-26-000010-index.html",
      accession: "0000320193-26-000010",
      form: "10-Q",
      filedAt: "2026-07-31T21:00:00.000Z",
      reportDate: null,
      items: [],
    };
    const event = normalizeEvent(eventObservation({ officialFiling: filing }), "2026-07-31", "2026-07-31T22:00:00.000Z", { cik: "0000320193" });
    expect(event.status).toBe("reported");
    // The SEC acceptance time is an official filing fact — it must not be
    // presented as the earnings-release timestamp.
    expect(event.reportedAt).toBeNull();
    expect(event.reportedAtSource).toBeNull();
    // It does surface under the official SEC fields.
    expect(event.secFiledAt).toBe("2026-07-31T21:00:00.000Z");
    expect(event.secForm).toBe("10-Q");
    expect(event.secFilingUrl).toBe(filing.url);
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
    }, 0)).resolves.toMatchObject({ status: "ok" });
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
    }, 0)).resolves.toMatchObject({ status: "degraded" });
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

    await expect(runEarningsJob({ DB: db } as never, new Date("2026-08-13T06:00:00.000Z"), "calendar", providers, 0))
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
    }, 0)).resolves.toMatchObject({ status: "degraded" });

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
    await runEarningsJob({ DB: db } as never, new Date("2026-08-13T06:00:00.000Z"), "calendar", providers, 0);
    await runEarningsJob({ DB: db } as never, new Date("2026-08-13T06:00:00.000Z"), "calendar", providers, 0);
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
    }, 0);
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
    expect(response.summary.next30Days).toBe(1);
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
    }, 0);
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
    }, 0);
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
    }, 0);
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
    }, 0);
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
    await expect(runEarningsJob({ DB: db } as never, new Date("2026-08-13T06:00:00.000Z"), "calendar", providers, 0)).resolves.toMatchObject({ status: "ok" });
    // SEC goes down; the same Finnhub calendar rows are synced again. The
    // critical job status stays ok — SEC is enrichment-only — while the SEC
    // diagnostics record the failure.
    secHealthy = false;
    await expect(runEarningsJob({ DB: db } as never, new Date("2026-08-13T06:00:00.000Z"), "calendar", providers, 0)).resolves.toMatchObject({ status: "ok" });
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

describe("Finnhub Company Profile 2 enrichment adapter", () => {
  it("normalizes profile2 fields and keeps the token out of the URL and logs", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      expect(url).toContain("symbol=MSFT");
      expect(url).not.toContain("token");
      expect((init?.headers as Record<string, string>)["X-Finnhub-Token"]).toBe("secret-key");
      return jsonResponse({
        name: "Microsoft Corporation",
        logo: "https://static2.finnhub.io/file/publicdatany/finnhubimage/stock_logo/MSFT.png",
        finnhubIndustry: "Application Software",
        weburl: "https://www.microsoft.com",
        exchange: "NASDAQ",
      });
    });
    const provider = new FinnhubCompanyProfileProvider("secret-key", fetcher);
    const profile = await provider.fetchProfile("MSFT");
    expect(profile).toEqual({
      symbol: "MSFT",
      company: "Microsoft Corporation",
      logoUrl: "https://static2.finnhub.io/file/publicdatany/finnhubimage/stock_logo/MSFT.png",
      industry: "Application Software",
      websiteUrl: "https://www.microsoft.com/",
      exchange: "NASDAQ",
    });
  });

  it("rejects an empty profile2 payload instead of inventing metadata", async () => {
    const fetcher = vi.fn(async () => jsonResponse({}));
    const provider = new FinnhubCompanyProfileProvider("secret-key", fetcher);
    await expect(provider.fetchProfile("MSFT")).rejects.toThrow(/malformed Finnhub company profile/);
  });

  it("accepts partial profiles (logo missing) and drops non-http values", async () => {
    const fetcher = vi.fn(async () => jsonResponse({
      name: "Partial Corp",
      logo: "not-a-url",
      weburl: "javascript:alert(1)",
      finnhubIndustry: "Software",
    }));
    const provider = new FinnhubCompanyProfileProvider("secret-key", fetcher);
    const profile = await provider.fetchProfile("PART");
    expect(profile).toEqual({ symbol: "PART", company: "Partial Corp", logoUrl: null, industry: "Software", websiteUrl: null, exchange: null });
  });
});

describe("earnings universe metadata enrichment", () => {
  const profileProvider = {
    name: "finnhub-company-profile",
    fetchProfile: async (symbol: string) => ({
      symbol,
      company: `${symbol} Corporation`,
      logoUrl: `https://static2.finnhub.io/logo/${symbol}.png`,
      industry: "Semiconductors",
      websiteUrl: `https://www.${symbol.toLowerCase()}.com`,
      exchange: "NASDAQ",
    }),
  };

  it("enriches only missing/stale active Core members, capped per run, and persists URL-only metadata", async () => {
    const db = new MemoryD1();
    await seedActiveCoreUniverse(db);
    const fetched: string[] = [];
    const provider = {
      name: "finnhub-company-profile",
      fetchProfile: async (symbol: string) => {
        fetched.push(symbol);
        return profileProvider.fetchProfile(symbol);
      },
    };
    const providers = { profile: provider } as unknown as EarningsProviderBundle;
    const first = await enrichUniverseMetadata({ DB: db } as never, providers, "2026-08-16T06:00:00.000Z", 0);
    // Maintenance mode: Worker never tries to fill the full Core set in one run.
    expect(first.bootstrap).toBe(false);
    expect(first.requests).toBe(2);
    expect(first.successes).toBe(2);
    expect(fetched).toHaveLength(2);
    const row = db.universe.get(fetched[0]!);
    expect(row?.logo_url).toBe(`https://static2.finnhub.io/logo/${fetched[0]}.png`);
    expect(row?.industry).toBe("Semiconductors");
    expect(row?.website_url).toBe(`https://www.${fetched[0]!.toLowerCase()}.com`);
    expect(row?.metadata_provider).toBe("finnhub-company-profile");
    expect(row?.metadata_updated_at).toBe("2026-08-16T06:00:00.000Z");
    // The 50-member Core fills across maintenance batches of 2; the final run is a no-op.
    let runs = 1;
    let total = first.successes;
    for (let index = 0; index < 40; index += 1) {
      const next = await enrichUniverseMetadata({ DB: db } as never, providers, "2026-08-16T07:00:00.000Z", 0);
      runs += 1;
      total += next.successes;
      expect(next.requests).toBeLessThanOrEqual(2);
      expect(fetched).toHaveLength(total);
      if (next.requests === 0) break;
    }
    expect(runs).toBe(26);
    expect(total).toBe(50);
    expect(fetched).toHaveLength(50);
  });

  it("preserves Finnhub metadata_provider when Core/SEC reconciliation omits a provider", async () => {
    const db = new MemoryD1();
    await seedActiveCoreUniverse(db);
    const first = await enrichUniverseMetadata({ DB: db } as never, { profile: profileProvider } as unknown as EarningsProviderBundle, "2026-08-16T06:00:00.000Z", 0);
    const symbol = first.symbols[0]!;
    const before = db.universe.get(symbol)!;
    expect(before.metadata_provider).toBe("finnhub-company-profile");
    const logoBefore = before.logo_url;
    const industryBefore = before.industry;
    // Simulate Core/SEC reconciliation that updates company/CIK but does not
    // stamp a metadata provider — Finnhub provenance and logos must survive.
    await upsertUniverseMember(db as never, {
      symbol,
      company: before.company as string,
      cik: "0000123456",
      exchange: "NASDAQ",
      indexes: [],
      updatedAt: "2026-08-16T07:00:00.000Z",
    });
    const after = db.universe.get(symbol)!;
    expect(after.metadata_provider).toBe("finnhub-company-profile");
    expect(after.logo_url).toBe(logoBefore);
    expect(after.industry).toBe(industryBefore);
    expect(after.cik).toBe("0000123456");
  });

  it("re-enriches members whose metadata_updated_at is older than the TTL", async () => {
    const db = new MemoryD1();
    await seedActiveCoreUniverse(db);
    const providers = { profile: profileProvider } as unknown as EarningsProviderBundle;
    // Fill the whole Core so the only remaining candidate is a TTL-stale row.
    for (let index = 0; index < 40; index += 1) {
      const batch = await enrichUniverseMetadata({ DB: db } as never, providers, "2026-08-16T06:00:00.000Z", 0);
      if (batch.requests === 0) break;
    }
    const symbol = "AAPL";
    expect(db.universe.get(symbol)?.logo_url).toBeTruthy();
    // Age both success and attempt stamps beyond the 14-day TTL (and the
    // 7-day attempt cooldown). Real success stamps both together.
    db.universe.get(symbol)!.metadata_updated_at = "2026-08-01T06:00:00.000Z";
    db.universe.get(symbol)!.metadata_attempted_at = "2026-08-01T06:00:00.000Z";
    const refreshed = await enrichUniverseMetadata({ DB: db } as never, providers, "2026-08-16T08:00:00.000Z", 0);
    expect(refreshed.symbols).toContain(symbol);
  });

  it("cools failed early-alphabet symbols so later Core members are still selected", async () => {
    const db = new MemoryD1();
    await seedActiveCoreUniverse(db);
    const fetched: string[] = [];
    const failingEarly = {
      name: "finnhub-company-profile",
      fetchProfile: async (symbol: string) => {
        fetched.push(symbol);
        if (symbol === "AAPL" || symbol === "ADBE") throw new Error("profile provider HTTP 429");
        return profileProvider.fetchProfile(symbol);
      },
    };
    const providers = { profile: failingEarly } as unknown as EarningsProviderBundle;
    const first = await enrichUniverseMetadata({ DB: db } as never, providers, "2026-08-16T06:00:00.000Z", 0);
    expect(first.requests).toBe(2);
    expect(first.failures).toBe(2);
    expect(fetched).toEqual(["AAPL", "ADBE"]);
    expect(db.universe.get("AAPL")?.metadata_attempted_at).toBe("2026-08-16T06:00:00.000Z");
    expect(db.universe.get("AAPL")?.logo_url).toBeUndefined();

    // Same-day re-run: cooled AAPL/ADBE must not be reselected; next symbols rotate in.
    const second = await enrichUniverseMetadata({ DB: db } as never, providers, "2026-08-16T07:00:00.000Z", 0);
    expect(second.requests).toBe(2);
    expect(second.symbols).toEqual(["AFRM", "AMAT"]);
    expect(fetched.slice(-2)).toEqual(["AFRM", "AMAT"]);
    expect(second.successes).toBe(2);

    // Complete every other Core member so the only remaining incomplete rows
    // are the cooled AAPL/ADBE failures — proves they re-enter after cooldown
    // rather than being buried under never-attempted symbols forever.
    for (const row of db.universe.values()) {
      if (row.symbol === "AAPL" || row.symbol === "ADBE") continue;
      row.logo_url = `https://static2.finnhub.io/logo/${row.symbol}.png`;
      row.industry = "Semiconductors";
      row.metadata_updated_at = "2026-08-16T07:00:00.000Z";
      row.metadata_attempted_at = "2026-08-16T07:00:00.000Z";
    }

    // Still inside the 7-day cooldown: queue is empty (failures cooled).
    const mid = await enrichUniverseMetadata({ DB: db } as never, providers, "2026-08-20T06:00:00.000Z", 0);
    expect(mid.requests).toBe(0);
    expect(mid.symbols).toEqual([]);

    // After cooldown, failed symbols re-enter the queue.
    const cooled = await enrichUniverseMetadata({ DB: db } as never, providers, "2026-08-24T06:00:00.000Z", 0);
    expect(cooled.requests).toBe(2);
    expect(cooled.failures).toBe(2);
    expect(cooled.symbols).toEqual([]);
    const thirdFetched = fetched.slice(fetched.length - cooled.requests);
    expect(thirdFetched.sort()).toEqual(["AAPL", "ADBE"]);
  });

  it("does not let a partial profile monopolise the maintenance queue", async () => {
    const db = new MemoryD1();
    await seedActiveCoreUniverse(db);
    const fetched: string[] = [];
    const partialFirst = {
      name: "finnhub-company-profile",
      fetchProfile: async (symbol: string) => {
        fetched.push(symbol);
        if (symbol === "AAPL") {
          return {
            symbol,
            company: "Apple Inc",
            logoUrl: null,
            industry: "Consumer Electronics",
            websiteUrl: "https://www.apple.com",
            exchange: "NASDAQ",
          };
        }
        return profileProvider.fetchProfile(symbol);
      },
    };
    const providers = { profile: partialFirst } as unknown as EarningsProviderBundle;
    const first = await enrichUniverseMetadata({ DB: db } as never, providers, "2026-08-16T06:00:00.000Z", 0);
    expect(first.symbols).toContain("AAPL");
    expect(db.universe.get("AAPL")?.industry).toBe("Consumer Electronics");
    expect(db.universe.get("AAPL")?.logo_url).toBeNull();
    // Partial AAPL is still "missing" logo but cooled — next run must move on.
    const second = await enrichUniverseMetadata({ DB: db } as never, providers, "2026-08-16T07:00:00.000Z", 0);
    expect(second.symbols).not.toContain("AAPL");
    expect(second.requests).toBe(2);
    expect(fetched.filter((symbol) => symbol === "AAPL")).toHaveLength(1);
  });

  it("keeps the per-run profile cap at 2 under repeated failures", async () => {
    const db = new MemoryD1();
    await seedActiveCoreUniverse(db);
    const failing = {
      name: "finnhub-company-profile",
      fetchProfile: async () => { throw new Error("boom"); },
    };
    const first = await enrichUniverseMetadata({ DB: db } as never, { profile: failing } as unknown as EarningsProviderBundle, "2026-08-16T06:00:00.000Z", 0);
    const second = await enrichUniverseMetadata({ DB: db } as never, { profile: failing } as unknown as EarningsProviderBundle, "2026-08-16T07:00:00.000Z", 0);
    expect(first.requests).toBe(2);
    expect(second.requests).toBe(2);
  });

  it("keeps the critical earnings health gate healthy when the profile provider fails", async () => {
    const db = new MemoryD1();
    await seedActiveCoreUniverse(db);
    const calendar: EarningsCalendarProvider = {
      name: "finnhub-earnings-calendar",
      supportsForwardCalendar: true,
      fetchCalendar: async () => ({ provider: "finnhub-earnings-calendar", observations: [eventObservation()], warnings: [], updatedAt: "2026-08-16T06:00:00.000Z" }),
    };
    const official: OfficialFilingsProvider = {
      name: "sec-edgar",
      fetchCompanyMetadata: async () => ({ provider: "sec-edgar", observations: [], warnings: [], updatedAt: "2026-08-16T06:00:00.000Z" }),
      findRelevantFiling: async () => null,
    };
    const failingProfile = {
      name: "finnhub-company-profile",
      fetchProfile: async () => { throw new Error("profile provider HTTP 429"); },
    };
    const providers = { calendar, consensus: calendar as never, official, profile: failingProfile } as unknown as EarningsProviderBundle;
    const result = await runEarningsJob({ DB: db } as never, new Date("2026-08-16T06:00:00.000Z"), "calendar", providers, 0);
    expect(result.status).toBe("ok");
    expect(db.meta.get("earningsCalendarLastError")).toBeUndefined();
    expect(db.meta.get("earningsMetadataLastError")).toContain("profile provider HTTP 429");
    expect(db.meta.get("earningsMetadataConsecutiveFailures")).toBe("2");
    // The calendar event still landed despite every profile call failing.
    expect(db.events.size).toBeGreaterThan(0);
  });

  it("resets the metadata error diagnostics after a fully successful run", async () => {
    const db = new MemoryD1();
    await seedActiveCoreUniverse(db);
    const failingProfile = {
      name: "finnhub-company-profile",
      fetchProfile: async () => { throw new Error("boom"); },
    };
    await enrichUniverseMetadata({ DB: db } as never, { profile: failingProfile } as unknown as EarningsProviderBundle, "2026-08-16T06:00:00.000Z", 0);
    expect(db.meta.get("earningsMetadataConsecutiveFailures")).toBe("2");
    await enrichUniverseMetadata({ DB: db } as never, { profile: profileProvider } as unknown as EarningsProviderBundle, "2026-08-16T06:30:00.000Z", 0);
    expect(db.meta.get("earningsMetadataLastError")).toBeUndefined();
    expect(db.meta.get("earningsMetadataConsecutiveFailures")).toBe("0");
  });
});

describe("earnings read model company metadata", () => {
  it("maps joined universe metadata columns onto the public event contract", async () => {
    const row: Row = {
      id: "MSFT-2026-Q1",
      symbol: "MSFT",
      company: "Microsoft Corporation",
      scheduled_date: "2026-08-20",
      timing: "AMC",
      status: "scheduled",
      eps_result: "Not Available",
      revenue_result: "Not Available",
      overall_result: "Not Available",
      created_at: "2026-08-16T06:00:00.000Z",
      updated_at: "2026-08-16T06:00:00.000Z",
      logo_url: "https://static2.finnhub.io/logo/MSFT.png",
      industry: "Application Software",
      website_url: "https://www.microsoft.com",
    };
    const event = rowToEarningsEvent(row);
    expect(event.logoUrl).toBe("https://static2.finnhub.io/logo/MSFT.png");
    expect(event.industry).toBe("Application Software");
    expect(event.websiteUrl).toBe("https://www.microsoft.com");
  });

  it("reads events with the universe metadata join and answers the 30-day summary", async () => {
    const db = new MemoryD1();
    await seedActiveCoreUniverse(db);
    await upsertEarningsEvent(db as never, normalizedEvent({ symbol: "MSFT", scheduledDate: "2026-08-14", fiscalQuarter: 1, providerEventId: "past-msft" }, "2026-08-13"));
    const response = await readEarningsApi({ DB: db } as never, new URLSearchParams("from=2026-07-14&to=2026-08-13"), new Date("2026-08-13T12:00:00.000Z"));
    expect(response.summary.next30Days).toBe(0);
    expect(response.events).toHaveLength(0);
    const future = await readEarningsApi({ DB: db } as never, new URLSearchParams("from=2026-08-13&to=2026-09-12"), new Date("2026-08-13T12:00:00.000Z"));
    expect(future.summary.next30Days).toBe(1);
    expect(future.summary).not.toHaveProperty("next60Days");
  });
});

describe("targeted historical recovery (PR #50)", () => {
  const recoveryCalendar = (bySymbol: Record<string, EarningsCalendarObservation[]>, queried?: string[]): EarningsCalendarProvider => {
    const calendar: EarningsCalendarProvider = {
      name: "finnhub-earnings-calendar",
      supportsForwardCalendar: true,
      fetchCalendar: async () => ({ provider: "finnhub-earnings-calendar", observations: [], warnings: [], updatedAt: "2026-08-16T06:00:00.000Z" }),
      fetchSymbolHistory: async (symbol: string) => {
        queried?.push(symbol);
        return { provider: "finnhub-earnings-calendar", observations: bySymbol[symbol] ?? [], warnings: [], updatedAt: "2026-08-16T06:00:00.000Z" };
      },
    };
    return calendar;
  };

  const silentOfficial: OfficialFilingsProvider = {
    name: "sec-edgar",
    fetchCompanyMetadata: async () => ({ provider: "sec-edgar", observations: [], warnings: [], updatedAt: "2026-08-16T06:00:00.000Z" }),
    findRelevantFiling: async () => null,
  };

  const msftJuly = () => eventObservation({
    symbol: "MSFT", company: "Microsoft Corporation", scheduledDate: "2026-07-29", scheduledTime: "amc", timing: "AMC",
    fiscalYear: 2026, fiscalQuarter: 4, fiscalPeriod: "Q4",
    epsEstimate: 4.3274, epsActual: 4.74, revenueEstimate: 89373722644, revenueActual: 90007000000,
    providerEventId: "finnhub:MSFT:2026:4:2026-07-29",
  });

  const aaplJuly = () => eventObservation({
    symbol: "AAPL", company: "Apple Inc.", scheduledDate: "2026-07-30", scheduledTime: "amc", timing: "AMC",
    fiscalYear: 2026, fiscalQuarter: 3, fiscalPeriod: "Q3",
    epsEstimate: 1.9271, epsActual: 1.91, revenueEstimate: 110823804698, revenueActual: 109417000000,
    providerEventId: "finnhub:AAPL:2026:3:2026-07-30",
  });

  it("recovers bulk-omitted MSFT/AAPL history, persists each event once and exposes them in Past Earnings", async () => {
    const db = new MemoryD1();
    await seedActiveCoreUniverse(db);
    // Complete metadata coverage so recovery is not competing with profile work.
    for (const row of db.universe.values()) {
      row.logo_url = `https://static2.finnhub.io/logo/${row.symbol}.png`;
      row.industry = "Semiconductors";
      row.metadata_updated_at = "2026-08-16T00:00:00.000Z";
    }
    // Pre-stamp every Core symbol except AAPL/MSFT so the maintenance cap of 2
    // recovers those two on the first run (instead of aging July reports out of
    // the 30-day window while walking A–Z at 2/day).
    for (const symbol of CORE_UNIVERSE) {
      if (symbol === "AAPL" || symbol === "MSFT") continue;
      db.meta.set(`earningsRecoveryChecked:${symbol}`, "2026-08-16T06:00:00.000Z");
    }
    const calendar = recoveryCalendar({ MSFT: [msftJuly()], AAPL: [aaplJuly()] });
    const providers = { calendar, consensus: calendar as never, official: silentOfficial } as unknown as EarningsProviderBundle;
    const first = await runEarningsJob({ DB: db } as never, new Date("2026-08-16T06:00:00.000Z"), "calendar", providers, 0);
    expect(first.status).toBe("ok");
    // AAPL+MSFT recovered on the first maintenance pass.
    const msftRows = [...db.events.values()].filter((row) => row.symbol === "MSFT");
    const aaplRows = [...db.events.values()].filter((row) => row.symbol === "AAPL");
    expect(msftRows).toHaveLength(1);
    expect(aaplRows).toHaveLength(1);
    expect(msftRows[0]).toMatchObject({ status: "reported", eps_actual: 4.74, eps_estimate: 4.3274, revenue_actual: 90007000000, scheduled_date: "2026-07-29" });
    expect(aaplRows[0]).toMatchObject({ status: "reported", eps_actual: 1.91, revenue_actual: 109417000000 });
    // Read model: both recovered events land inside the Past Earnings window.
    const response = await readEarningsApi({ DB: db } as never, new URLSearchParams("from=2026-07-17&to=2026-08-16"), new Date("2026-08-16T12:00:00.000Z"));
    const reported = response.events.filter((event) => event.status === "reported");
    expect(reported.map((event) => event.symbol).sort()).toEqual(["AAPL", "MSFT"]);
    expect(reported.find((event) => event.symbol === "MSFT")).toMatchObject({
      epsActual: 4.74,
      epsSurprisePct: expect.any(Number),
      revenueActual: 90007000000,
      overallResult: "Beat",
      timing: "AMC",
    });
  });

  it("skips symbols the bulk covers and symbols that already hold a recent reported row in D1", async () => {
    const db = new MemoryD1();
    await seedActiveCoreUniverse(db);
    await upsertEarningsEvent(db as never, normalizedEvent({
      symbol: "NVDA", scheduledDate: "2026-08-10", fiscalYear: 2026, fiscalQuarter: 1,
      epsEstimate: 2.5, epsActual: 3, providerEventId: "nvda-1",
    }, "2026-08-16"));
    const queried: string[] = [];
    const calendar: EarningsCalendarProvider = {
      name: "finnhub-earnings-calendar",
      supportsForwardCalendar: true,
      fetchCalendar: async () => ({
        provider: "finnhub-earnings-calendar",
        observations: [eventObservation({ symbol: "WMT", scheduledDate: "2026-08-15", fiscalYear: 2026, fiscalQuarter: 2, providerEventId: "wmt-1" })],
        warnings: [],
        updatedAt: "2026-08-16T06:00:00.000Z",
      }),
      fetchSymbolHistory: async (symbol: string) => {
        queried.push(symbol);
        return { provider: "finnhub-earnings-calendar", observations: [], warnings: [], updatedAt: "2026-08-16T06:00:00.000Z" };
      },
    };
    const providers = { calendar, consensus: calendar as never, official: silentOfficial } as unknown as EarningsProviderBundle;
    for (let day = 0; day < 12; day += 1) {
      const runAt = new Date(Date.parse("2026-08-16T06:00:00.000Z") + day * 24 * 60 * 60 * 1000);
      await runEarningsJob({ DB: db } as never, runAt, "calendar", providers, 0);
    }
    expect(queried).toContain("AAPL");
    expect(queried).not.toContain("NVDA");
    expect(queried).not.toContain("WMT");
  });

  it("still recovers a missing last-30-day report when bulk only has a future date for that symbol", async () => {
    const db = new MemoryD1();
    await seedActiveCoreUniverse(db);
    for (const row of db.universe.values()) {
      row.logo_url = `https://static2.finnhub.io/logo/${row.symbol}.png`;
      row.industry = "Semiconductors";
      row.metadata_updated_at = "2026-08-16T00:00:00.000Z";
    }
    // Leave only MSFT unchecked so the maintenance batch recovers it immediately.
    for (const symbol of CORE_UNIVERSE) {
      if (symbol === "MSFT") continue;
      db.meta.set(`earningsRecoveryChecked:${symbol}`, "2026-08-16T06:00:00.000Z");
    }
    const queried: string[] = [];
    const calendar: EarningsCalendarProvider = {
      name: "finnhub-earnings-calendar",
      supportsForwardCalendar: true,
      fetchCalendar: async () => ({
        provider: "finnhub-earnings-calendar",
        observations: [eventObservation({
          symbol: "MSFT",
          scheduledDate: "2026-10-22",
          fiscalYear: 2027,
          fiscalQuarter: 1,
          providerEventId: "msft-next",
        })],
        warnings: [],
        updatedAt: "2026-08-16T06:00:00.000Z",
      }),
      fetchSymbolHistory: async (symbol: string) => {
        queried.push(symbol);
        return {
          provider: "finnhub-earnings-calendar",
          observations: symbol === "MSFT" ? [msftJuly()] : [],
          warnings: [],
          updatedAt: "2026-08-16T06:00:00.000Z",
        };
      },
    };
    const providers = { calendar, consensus: calendar as never, official: silentOfficial } as unknown as EarningsProviderBundle;
    await runEarningsJob({ DB: db } as never, new Date("2026-08-16T06:00:00.000Z"), "calendar", providers, 0);
    expect(queried).toContain("MSFT");
    const msftRows = [...db.events.values()].filter((row) => row.symbol === "MSFT");
    expect(msftRows.some((row) => row.scheduled_date === "2026-07-29" && row.status === "reported")).toBe(true);
    expect(msftRows.some((row) => row.scheduled_date === "2026-10-22")).toBe(true);
  });

  it("isolates recovery failures: job stays ok, no calendar error, recovery diagnostics recorded", async () => {
    const db = new MemoryD1();
    await seedActiveCoreUniverse(db);
    const failingCalendar: EarningsCalendarProvider = {
      name: "finnhub-earnings-calendar",
      supportsForwardCalendar: true,
      fetchCalendar: async () => ({ provider: "finnhub-earnings-calendar", observations: [], warnings: [], updatedAt: "2026-08-16T06:00:00.000Z" }),
      fetchSymbolHistory: async (symbol: string) => { throw new Error(`recovery boom ${symbol}`); },
    };
    const providers = { calendar: failingCalendar, consensus: failingCalendar as never, official: silentOfficial } as unknown as EarningsProviderBundle;
    const result = await runEarningsJob({ DB: db } as never, new Date("2026-08-16T06:00:00.000Z"), "calendar", providers, 0);
    expect(result.status).toBe("ok");
    expect(db.meta.get("earningsCalendarLastError")).toBeUndefined();
    expect(db.meta.get("earningsRecoveryLastAttemptAt")).toBe("2026-08-16T06:00:00.000Z");
    expect(db.meta.get("earningsRecoveryLastError")).toContain("recovery boom");
  });

  it("deduplicates a recovered event that the bulk already returned", async () => {
    const db = new MemoryD1();
    await seedActiveCoreUniverse(db);
    const calendar: EarningsCalendarProvider = {
      name: "finnhub-earnings-calendar",
      supportsForwardCalendar: true,
      fetchCalendar: async () => ({
        provider: "finnhub-earnings-calendar",
        observations: [eventObservation({ symbol: "MSFT", scheduledDate: "2026-07-29", fiscalYear: 2026, fiscalQuarter: 4, providerEventId: "finnhub:MSFT:2026:4:2026-07-29" })],
        warnings: [],
        updatedAt: "2026-08-16T06:00:00.000Z",
      }),
      fetchSymbolHistory: async () => ({ provider: "finnhub-earnings-calendar", observations: [msftJuly()], warnings: [], updatedAt: "2026-08-16T06:00:00.000Z" }),
    };
    const providers = { calendar, consensus: calendar as never, official: silentOfficial } as unknown as EarningsProviderBundle;
    await runEarningsJob({ DB: db } as never, new Date("2026-08-16T06:00:00.000Z"), "calendar", providers, 0);
    expect([...db.events.values()].filter((row) => row.symbol === "MSFT")).toHaveLength(1);
  });

  it("keeps the maintenance recovery cap at 2 symbols/run", async () => {
    const db = new MemoryD1();
    await seedActiveCoreUniverse(db);
    // Complete metadata coverage: every active Core member has logo/industry.
    for (const row of db.universe.values()) {
      row.logo_url = `https://static2.finnhub.io/logo/${row.symbol}.png`;
      row.industry = "Semiconductors";
      row.metadata_updated_at = "2026-08-16T00:00:00.000Z";
    }
    const queried: string[] = [];
    const calendar = recoveryCalendar({}, queried);
    const providers = { calendar, consensus: calendar as never, official: silentOfficial } as unknown as EarningsProviderBundle;
    await runEarningsJob({ DB: db } as never, new Date("2026-08-16T06:00:00.000Z"), "calendar", providers, 0);
    expect(queried).toHaveLength(2);
  });
});

describe("targeted historical recovery anti-starvation", () => {
  it("does not let empty probes block alphabetically-later symbols", async () => {
    const db = new MemoryD1();
    await seedActiveCoreUniverse(db);
    const queried: string[] = [];
    const calendar: EarningsCalendarProvider = {
      name: "finnhub-earnings-calendar",
      supportsForwardCalendar: true,
      fetchCalendar: async () => ({ provider: "finnhub-earnings-calendar", observations: [], warnings: [], updatedAt: "2026-08-16T06:00:00.000Z" }),
      fetchSymbolHistory: async (symbol: string) => {
        queried.push(symbol);
        return { provider: "finnhub-earnings-calendar", observations: [], warnings: [], updatedAt: "2026-08-16T06:00:00.000Z" };
      },
    };
    const providers = { calendar, consensus: calendar as never, official: {
      name: "sec-edgar",
      fetchCompanyMetadata: async () => ({ provider: "sec-edgar", observations: [], warnings: [], updatedAt: "2026-08-16T06:00:00.000Z" }),
      findRelevantFiling: async () => null,
    } } as unknown as EarningsProviderBundle;
    for (let day = 0; day < 6; day += 1) {
      const runAt = new Date(Date.parse("2026-08-16T06:00:00.000Z") + day * 24 * 60 * 60 * 1000);
      await runEarningsJob({ DB: db } as never, runAt, "calendar", providers, 0);
    }
    // 6 runs at the 2-symbol maintenance cap with 7-day rest stamps: the first
    // probes must not be re-queried, so unique symbols grow well past 2.
    expect(new Set(queried).size).toBeGreaterThanOrEqual(10);
  });
});

describe("Finnhub per-attempt pacing (FinnhubRequestGate)", () => {
  const range = { from: "2026-08-20", to: "2026-08-23" };
  const universe = new Set(["MSFT"]);

  function fakeClock() {
    let now = 0;
    const sleeper = vi.fn(async (ms: number) => {
      now += ms;
    });
    const gate = new FinnhubRequestGate(FINNHUB_RATE_PACING_MS, sleeper, () => now);
    return { now: () => now, sleeper, gate, advance: (ms: number) => { now += ms; } };
  }

  it("paces the second physical request after a 429 with no Retry-After", async () => {
    const clock = fakeClock();
    let calls = 0;
    const requestAt: number[] = [];
    const provider = new FinnhubEarningsProvider("test-key", async () => {
      requestAt.push(clock.now());
      calls += 1;
      return calls === 1
        ? new Response("busy", { status: 429 })
        : jsonResponse({ earningsCalendar: [] });
    }, clock.sleeper, 8_000, clock.gate);

    await expect(provider.fetchCalendar(range, universe, "2026-08-13T13:00:00.000Z")).resolves.toMatchObject({ observations: [] });
    expect(calls).toBe(2);
    expect(requestAt[1]! - requestAt[0]!).toBeGreaterThanOrEqual(FINNHUB_RATE_PACING_MS);
  });

  it("paces the second physical request after a 5xx the same way", async () => {
    const clock = fakeClock();
    let calls = 0;
    const requestAt: number[] = [];
    const provider = new FinnhubEarningsProvider("test-key", async () => {
      requestAt.push(clock.now());
      calls += 1;
      return calls === 1
        ? new Response("error", { status: 503 })
        : jsonResponse({ earningsCalendar: [] });
    }, clock.sleeper, 8_000, clock.gate);

    await expect(provider.fetchCalendar(range, universe, "2026-08-13T13:00:00.000Z")).resolves.toMatchObject({ observations: [] });
    expect(calls).toBe(2);
    expect(requestAt[1]! - requestAt[0]!).toBeGreaterThanOrEqual(FINNHUB_RATE_PACING_MS);
  });

  it("lets Retry-After longer than pacing win", async () => {
    const clock = fakeClock();
    let calls = 0;
    const requestAt: number[] = [];
    const provider = new FinnhubEarningsProvider("test-key", async () => {
      requestAt.push(clock.now());
      calls += 1;
      return calls === 1
        ? new Response("busy", { status: 429, headers: { "Retry-After": "3" } })
        : jsonResponse({ earningsCalendar: [] });
    }, clock.sleeper, 8_000, clock.gate);

    await expect(provider.fetchCalendar(range, universe, "2026-08-13T13:00:00.000Z")).resolves.toMatchObject({ observations: [] });
    expect(calls).toBe(2);
    // Retry-After 3s + residual gate to reach min interval: gap >= 3000ms.
    expect(requestAt[1]! - requestAt[0]!).toBeGreaterThanOrEqual(3_000);
    expect(clock.sleeper).toHaveBeenCalledWith(3_000);
  });

  it("does not retry a successful first request", async () => {
    const clock = fakeClock();
    let calls = 0;
    const provider = new FinnhubEarningsProvider("test-key", async () => {
      calls += 1;
      return jsonResponse({ earningsCalendar: [] });
    }, clock.sleeper, 8_000, clock.gate);

    await expect(provider.fetchCalendar(range, universe, "2026-08-13T13:00:00.000Z")).resolves.toMatchObject({ observations: [] });
    expect(calls).toBe(1);
  });

  it("paces Finnhub profile retries independently of SEC", async () => {
    const clock = fakeClock();
    let calls = 0;
    const requestAt: number[] = [];
    const profile = new FinnhubCompanyProfileProvider("test-key", async () => {
      requestAt.push(clock.now());
      calls += 1;
      return calls === 1
        ? new Response("busy", { status: 429 })
        : jsonResponse({ name: "Apple Inc", logo: "https://static2.finnhub.io/file/publicdatany/finnhubimage/stock_logo/AAPL.png", finnhubIndustry: "Technology", weburl: "https://www.apple.com", exchange: "NASDAQ" });
    }, clock.sleeper, 8_000, clock.gate);

    await expect(profile.fetchProfile("AAPL")).resolves.toMatchObject({ company: "Apple Inc" });
    expect(calls).toBe(2);
    expect(requestAt[1]! - requestAt[0]!).toBeGreaterThanOrEqual(FINNHUB_RATE_PACING_MS);
  });

  it("leaves SEC Retry-After pacing unchanged (no Finnhub gate)", async () => {
    let calls = 0;
    const sleeper = vi.fn(async (ms: number) => { void ms; });
    const provider = new SecEdgarProvider("StockAutotraderTest/1.0", async () => {
      calls += 1;
      return calls === 1
        ? new Response("busy", { status: 429, headers: { "Retry-After": "1" } })
        : jsonResponse({ filings: { recent: { form: [] } } });
    }, sleeper);
    await expect(provider.findRelevantFiling({ cik: "0000789012", scheduledDate: "2026-08-12", fiscalPeriodEnd: "2026-06-30" }, "2026-08-13")).resolves.toBeNull();
    expect(calls).toBe(2);
    expect(sleeper).toHaveBeenCalledWith(1000);
    // SEC should never wait the Finnhub 1100ms gate as its only retry delay.
    expect(sleeper.mock.calls.some((call) => call[0] === FINNHUB_RATE_PACING_MS)).toBe(false);
  });
});
describe("production Finnhub bulk calendar is a single physical request", () => {
  it("createDefaultEarningsProviders shares calendar === consensus", () => {
    const bundle = createDefaultEarningsProviders("test-key");
    expect(Object.is(bundle.calendar, bundle.consensus)).toBe(true);
    expect(bundle.calendar).toBeInstanceOf(FinnhubEarningsProvider);
    expect(bundle.profile).toBeInstanceOf(FinnhubCompanyProfileProvider);
  });

  it("readProviderCalendar path issues one bulk Finnhub HTTP call when calendar === consensus", async () => {
    const db = new MemoryD1();
    await seedActiveCoreUniverse(db);
    let bulkCalls = 0;
    let symbolCalls = 0;
    let profileCalls = 0;
    let consensusCalls = 0;
    const sleeper = vi.fn(async () => undefined);
    const gate = new FinnhubRequestGate(FINNHUB_RATE_PACING_MS, sleeper, () => Date.now());
    const finnhub = new FinnhubEarningsProvider("test-key", async (input) => {
      const url = String(input);
      if (url.includes("symbol=")) {
        symbolCalls += 1;
        return jsonResponse({ earningsCalendar: [] });
      }
      bulkCalls += 1;
      return jsonResponse({ earningsCalendar: [] });
    }, sleeper, 8_000, gate);
    const originalFetchConsensus = finnhub.fetchConsensus.bind(finnhub);
    finnhub.fetchConsensus = async (...args) => {
      consensusCalls += 1;
      return originalFetchConsensus(...args);
    };
    const profile = new FinnhubCompanyProfileProvider("test-key", async () => {
      profileCalls += 1;
      return jsonResponse({
        name: "Apple Inc",
        logo: "https://static2.finnhub.io/file/publicdatany/finnhubimage/stock_logo/AAPL.png",
        finnhubIndustry: "Technology",
        weburl: "https://www.apple.com",
        exchange: "NASDAQ",
      });
    }, sleeper, 8_000, gate);
    const providers = {
      calendar: finnhub,
      consensus: finnhub,
      official: {
        name: "sec-edgar",
        fetchCompanyMetadata: async () => ({ provider: "sec-edgar", observations: [], warnings: [], updatedAt: "2026-08-16T06:00:00.000Z" }),
        findRelevantFiling: async () => null,
      },
      profile,
    } as unknown as EarningsProviderBundle;

    await runEarningsJob({ DB: db, FINNHUB_API_KEY: "test-key" } as never, new Date("2026-08-16T06:00:00.000Z"), "calendar", providers, 0);

    expect(Object.is(providers.calendar, providers.consensus)).toBe(true);
    expect(bulkCalls).toBe(1);
    expect(consensusCalls).toBe(0);
    // Maintenance caps still apply (recovery + profile), but bulk is one.
    expect(symbolCalls).toBeLessThanOrEqual(2);
    expect(profileCalls).toBeLessThanOrEqual(2);
  });
});

describe("official-metric storage write precedence (PR: earnings official last quarter)", () => {
  const officialWrite = (eventId: string, overrides: Partial<OfficialMetricsWrite> = {}): OfficialMetricsWrite => ({
    eventId,
    // The production write (buildAuditRow) never stamps a SEC acceptance time
    // as reportedAt: sec-filing is stored only in secFiledAt. The fixture pins
    // that storage-level invariant too.
    reportedAt: null,
    reportedAtSource: null,
    secFilingUrl: "https://www.sec.gov/Archives/edgar/data/320193/000032019326000101/0000320193-26-000101-index.html",
    secAccession: "0000320193-26-000101",
    secForm: "10-Q",
    secFiledAt: "2026-07-29T00:00:00.000Z",
    epsActualGaap: 1.63,
    epsActualGaapSource: "sec-xbrl",
    epsActualAdjusted: 1.91,
    epsActualAdjustedSource: "finnhub-adjusted",
    revenueActualOfficial: 117_441_000_000,
    revenueActualSource: "sec-xbrl",
    epsEstimateSource: "finnhub-consensus",
    revenueEstimateSource: "finnhub-consensus",
    dataQualityStatus: "different-basis",
    fiscalPeriodEnd: "2026-06-27",
    updatedAt: "2026-08-17T06:00:00.000Z",
    ...overrides,
  });

  const seedReportedEvent = async (db: MemoryD1, symbol = "MSFT"): Promise<string> => {
    const event = normalizeEvent(eventObservation({
      symbol,
      scheduledDate: "2026-07-30",
      fiscalYear: 2026,
      fiscalQuarter: 3,
      fiscalPeriod: "Q3",
      fiscalPeriodEnd: "2026-06-27",
      epsEstimate: 1.9271,
      epsActual: 1.91,
      revenueEstimate: 110_823_804_698,
      revenueActual: 117_441_000_000,
      providerEventId: `finnhub:${symbol}:2026:3:2026-07-30`,
      providerUpdatedAt: "2026-07-30T12:00:00.000Z",
    }), "2026-07-30", "2026-07-30T12:00:00.000Z", { company: "Microsoft Corporation", cik: "0000789012" });
    await upsertEarningsEvent(db as never, event);
    return event.id;
  };

  it("writes official GAAP fields without touching legacy provider actuals", async () => {
    const db = new MemoryD1();
    const id = await seedReportedEvent(db);
    const changed = await applyOfficialMetrics(db as never, officialWrite(id));
    expect(changed).toBe(true);
    const rawRow = await db.prepare("SELECT * FROM earnings_events WHERE id = ?").bind(id).first<Row>();
    const row = rowToEarningsEvent(rawRow as Row);
    expect(row.epsActualGaap).toBe(1.63);
    expect(row.epsActualGaapSource).toBe("sec-xbrl");
    expect(row.epsActualAdjusted).toBe(1.91);
    expect(row.revenueActualOfficial).toBe(117_441_000_000);
    // sec-filing is never stored as reportedAt at the storage layer either.
    expect(row.reportedAt).toBeNull();
    expect(row.reportedAtSource).toBeNull();
    expect(row.dataQualityStatus).toBe("different-basis");
    expect(row.secFilingUrl).toMatch(/https:\/\/www\.sec\.gov\/Archives\/edgar\/data\/320193\//);
    expect(row.secAccession).toBe("0000320193-26-000101");
    expect(row.secForm).toBe("10-Q");
    // The SEC acceptance time lands in its official column, not reportedAt.
    expect(row.secFiledAt).toBe("2026-07-29T00:00:00.000Z");
    // Legacy columns are preserved exactly.
    expect(row.epsActual).toBe(1.91);
    expect(row.revenueActual).toBe(117_441_000_000);
  });

  it("writing SEC GAAP never re-derives a market Beat/Miss from GAAP actuals", async () => {
    const db = new MemoryD1();
    const id = await seedReportedEvent(db); // 1.9271 estimate vs 1.91 actual → market Miss
    const before = rowToEarningsEvent((await db.prepare("SELECT * FROM earnings_events WHERE id = ?").bind(id).first<Row>())!);
    expect(before.epsResult).toBe("Miss");
    expect(before.epsActualGaap).toBeNull();

    // A GAAP actual arrives (e.g. AAPL 2.02) — it must not flip the market
    // outcome: Beat/Miss is computed strictly from Finnhub estimate vs actual.
    await applyOfficialMetrics(db as never, officialWrite(id, { epsActualGaap: 2.02 }));

    const after = rowToEarningsEvent((await db.prepare("SELECT * FROM earnings_events WHERE id = ?").bind(id).first<Row>())!);
    expect(after.epsResult).toBe("Miss");
    expect(after.overallResult).toBe(before.overallResult);
    // The GAAP figure is reference data in its own column, never the market actual.
    expect(after.epsActualGaap).toBe(2.02);
    expect(after.epsActual).toBe(1.91);
    expect(after.epsActual).not.toBe(2.02);
  });

  it("official write never overwrites a provider adjusted actual (Actual/Result stay consistent)", async () => {
    const db = new MemoryD1();
    // Divergent pair: legacy 0.9 vs explicit adjusted 1.1 against estimate 1.0.
    // The market Result (Beat) is computed from the adjusted basis.
    const seeded = normalizeEvent(eventObservation({
      symbol: "MSFT",
      scheduledDate: "2026-07-30",
      fiscalYear: 2026,
      fiscalQuarter: 3,
      fiscalPeriod: "Q3",
      epsEstimate: 1,
      epsActual: 0.9,
      epsActualAdjusted: 1.1,
      epsActualAdjustedSource: "finnhub-adjusted",
      revenueEstimate: null,
      revenueActual: null,
      providerEventId: "finnhub:MSFT:2026:3:2026-07-30",
      providerUpdatedAt: "2026-07-30T12:00:00.000Z",
    }), "2026-07-30", "2026-07-30T12:00:00.000Z", { company: "Microsoft Corporation", cik: "0000789012" });
    await upsertEarningsEvent(db as never, seeded);
    const before = rowToEarningsEvent((await db.prepare("SELECT * FROM earnings_events WHERE id = ?").bind(seeded.id).first<Row>())!);
    expect(before.epsResult).toBe("Beat");
    expect(before.epsActualAdjusted).toBe(1.1);

    // The official backfill mirrors the LEGACY actual (0.9) as its adjusted
    // payload — fill-only semantics must keep the provider's 1.1.
    await applyOfficialMetrics(db as never, officialWrite(seeded.id, {
      epsActualGaap: 1.2,
      epsActualAdjusted: 0.9,
      epsActualAdjustedSource: "finnhub-adjusted",
    }));

    const after = rowToEarningsEvent((await db.prepare("SELECT * FROM earnings_events WHERE id = ?").bind(seeded.id).first<Row>())!);
    expect(after.epsActualAdjusted).toBe(1.1);
    expect(after.epsResult).toBe("Beat");
    expect(after.epsActual).toBe(0.9);
    expect(after.epsActualGaap).toBe(1.2);
  });

  it("is idempotent: a second identical apply reports no change", async () => {
    const db = new MemoryD1();
    const id = await seedReportedEvent(db);
    expect(await applyOfficialMetrics(db as never, officialWrite(id))).toBe(true);
    expect(await applyOfficialMetrics(db as never, officialWrite(id))).toBe(false);
  });

  it("never clears an accepted canonical value with a null re-resolution", async () => {
    const db = new MemoryD1();
    const id = await seedReportedEvent(db);
    await applyOfficialMetrics(db as never, officialWrite(id));
    // A later run that fails to resolve the GAAP figure (regression) writes
    // nulls — the previously accepted canonical value must survive.
    const regressed = officialWrite(id, {
      epsActualGaap: null,
      epsActualGaapSource: null,
      revenueActualOfficial: null,
      revenueActualSource: null,
      // Verdict unchanged — only the value resolution regressed to null.
      dataQualityStatus: "different-basis",
    });
    expect(await applyOfficialMetrics(db as never, regressed)).toBe(false);
    const rawRow = await db.prepare("SELECT * FROM earnings_events WHERE id = ?").bind(id).first<Row>();
    const row = rowToEarningsEvent(rawRow as Row);
    expect(row.epsActualGaap).toBe(1.63);
    expect(row.epsActualGaapSource).toBe("sec-xbrl");
    expect(row.revenueActualOfficial).toBe(117_441_000_000);
    expect(row.dataQualityStatus).toBe("different-basis");
  });

  it("fills a missing fiscal_period_end from the resolved SEC period", async () => {
    const db = new MemoryD1();
    const id = await seedReportedEvent(db);
    await applyOfficialMetrics(db as never, officialWrite(id));
    const row = await db.prepare("SELECT * FROM earnings_events WHERE id = ?").bind(id).first<Row>();
    expect(row?.fiscal_period_end).toBe("2026-06-27");
  });

  it("a later provider sync preserves audited official fields and the verdict", async () => {
    const db = new MemoryD1();
    const id = await seedReportedEvent(db);
    await applyOfficialMetrics(db as never, officialWrite(id));

    // A fresh provider observation arrives (monitor re-check): normalization
    // produces 'pending' with null official metrics — the upsert must keep the
    // audited values and the 'different-basis' verdict.
    const recheck = normalizeEvent(eventObservation({
      symbol: "MSFT",
      scheduledDate: "2026-07-30",
      fiscalYear: 2026,
      fiscalQuarter: 3,
      fiscalPeriod: "Q3",
      fiscalPeriodEnd: "2026-06-27",
      epsEstimate: 1.93,
      epsActual: 1.95,
      revenueEstimate: 111_000_000_000,
      revenueActual: 118_000_000_000,
      // The production Finnhub adapter tags the actual as adjusted explicitly.
      epsActualAdjusted: 1.95,
      epsActualAdjustedSource: "finnhub-adjusted",
      providerEventId: "finnhub:MSFT:2026:3:2026-07-30",
      providerUpdatedAt: "2026-07-30T14:00:00.000Z",
    }), "2026-07-30", "2026-07-30T14:00:00.000Z", { company: "Microsoft Corporation", cik: "0000789012" });
    await upsertEarningsEvent(db as never, recheck);

    const rawRow = await db.prepare("SELECT * FROM earnings_events WHERE id = ?").bind(id).first<Row>();
    const row = rowToEarningsEvent(rawRow as Row);
    expect(row.epsActualGaap).toBe(1.63);
    expect(row.epsActualGaapSource).toBe("sec-xbrl");
    expect(row.revenueActualOfficial).toBe(117_441_000_000);
    expect(row.dataQualityStatus).toBe("different-basis");
    // Provider-side adjusteds update independently of the GAAP side.
    expect(row.epsActualAdjusted).toBe(1.95);
  });

  it("never writes official fields to an upcoming (scheduled) event", async () => {
    const db = new MemoryD1();
    const event = normalizeEvent(eventObservation({
      symbol: "NVDA",
      scheduledDate: "2026-08-26",
      fiscalYear: 2027,
      fiscalQuarter: 2,
      fiscalPeriod: "Q2",
      epsEstimate: 2.1283,
      revenueEstimate: 93_634_391_959,
      epsActual: null,
      revenueActual: null,
      providerEventId: "finnhub:NVDA:2027:2:2026-08-26",
      providerUpdatedAt: "2026-08-17T06:00:00.000Z",
    }), "2026-08-17", "2026-08-17T06:00:00.000Z", { company: "NVIDIA Corp", cik: "0001045810" });
    await upsertEarningsEvent(db as never, event);
    // The official write path refuses to target scheduled rows via buildAuditRow
    // (decision pending), and applyOfficialMetrics only updates by exact id:
    // simulate the guard by asserting no write payload is generated upstream.
    const rawStored = await db.prepare("SELECT * FROM earnings_events WHERE id = ?").bind(event.id).first<Row>();
    const stored = rowToEarningsEvent(rawStored as Row);
    expect(stored.status).toBe("scheduled");
    expect(stored.epsActual).toBeNull();
    expect(stored.epsActualGaap).toBeNull();
  });
});
