import type { EarningsEngineEvent } from "@stock-autotrader/contracts";
import type {
  CompanyMetadata,
  CompanyProfileObservation,
  CompanyProfileProvider,
  EarningsCalendarObservation,
  EarningsCalendarProvider,
  EarningsConsensusObservation,
  EarningsConsensusProvider,
  EarningsDateRange,
  EarningsProviderBundle,
  EarningsProviderResult,
  OfficialFiling,
  OfficialFilingsProvider,
} from "./types";
import { isInEarningsUniverse, normalizeSymbol } from "./universe";
import { FINNHUB_RATE_PACING_MS, MAX_PROVIDER_ATTEMPTS } from "./subrequest-budget";

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type Sleeper = (milliseconds: number) => Promise<void>;

const FMP_URL = "https://financialmodelingprep.com/stable/earnings-calendar";
const FINNHUB_URL = "https://finnhub.io/api/v1/calendar/earnings";
const FINNHUB_PROFILE_URL = "https://finnhub.io/api/v1/stock/profile2";
const SEC_TICKERS_URL = "https://www.sec.gov/files/company_tickers_exchange.json";
const SEC_SUBMISSIONS_URL = "https://data.sec.gov/submissions/CIK";
const SEC_FULL_INDEX_URL = "https://www.sec.gov/Archives/edgar/full-index";
const PROVIDER_TIMEOUT_MS = 8_000;
const SEC_MIN_REQUEST_INTERVAL_MS = 125;
// SEC full-index rows do not identify the subject of a 6-K. Keep 6-K for
// targeted filing enrichment, but do not turn arbitrary 6-K rows into events.
const SEC_CALENDAR_FORMS = new Set(["10-Q", "10-K"]);

const defaultSleep: Sleeper = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

/**
 * Shared Finnhub physical-request gate. Every HTTP attempt (including retries)
 * waits until FINNHUB_RATE_PACING_MS has elapsed since the previous attempt,
 * unless Retry-After already delayed longer. Production calendar + recovery +
 * profile providers share one gate so free-tier bursts cannot form.
 */
export class FinnhubRequestGate {
  private lastRequestAt = 0;

  constructor(
    private readonly minIntervalMs: number = FINNHUB_RATE_PACING_MS,
    private readonly sleeper: Sleeper = defaultSleep,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async beforeAttempt(): Promise<void> {
    const wait = Math.max(0, this.lastRequestAt + this.minIntervalMs - this.now());
    if (wait > 0) await this.sleeper(wait);
    this.lastRequestAt = this.now();
  }
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number(value.replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function integer(value: unknown): number | null {
  const parsed = finiteNumber(value);
  return parsed !== null && Number.isInteger(parsed) ? parsed : null;
}

function dateKey(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value ? value : null;
}

function isoTimestamp(value: unknown, fallback: string): string {
  if (typeof value === "string") {
    const dateOnly = dateKey(value);
    if (dateOnly) return `${dateOnly}T00:00:00.000Z`;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return fallback;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function httpUrlValue(value: unknown): string | null {
  const candidate = stringValue(value);
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function parseQuarter(value: unknown): number | null {
  const numeric = integer(value);
  if (numeric !== null && numeric >= 1 && numeric <= 4) return numeric;
  const text = stringValue(value)?.toUpperCase() ?? "";
  const match = text.match(/Q([1-4])/);
  return match ? Number(match[1]) : null;
}

function timing(value: unknown): "BMO" | "AMC" | "TBD" {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "bmo" || normalized === "before market open") return "BMO";
  if (normalized === "amc" || normalized === "after market close") return "AMC";
  return "TBD";
}

/**
 * Finnhub's calendar uses bmo, amc and dmh.  dmh means during market hours,
 * which is not a precise BMO/AMC window for the monitor, so it stays TBD.
 */
export function normalizeFinnhubTiming(value: unknown): "BMO" | "AMC" | "TBD" {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "bmo") return "BMO";
  if (normalized === "amc") return "AMC";
  return "TBD";
}

function rowObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function rowsFromPayload(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) return payload.flatMap((row) => {
    const object = rowObject(row);
    return object ? [object] : [];
  });
  const object = rowObject(payload);
  if (!object) throw new Error("malformed earnings provider response");
  for (const key of ["data", "results", "earningsCalendar"]) {
    if (Array.isArray(object[key])) {
      return object[key].flatMap((row) => {
        const item = rowObject(row);
        return item ? [item] : [];
      });
    }
  }
  throw new Error("malformed earnings provider response");
}

async function fetchWithRetry(
  fetcher: Fetcher,
  url: URL,
  init: RequestInit,
  sleeper: Sleeper = defaultSleep,
  timeoutMs = PROVIDER_TIMEOUT_MS,
  beforeAttempt?: () => Promise<void>,
): Promise<Response> {
  let lastError: unknown = new Error("provider request failed");
  for (let attempt = 0; attempt < MAX_PROVIDER_ATTEMPTS; attempt += 1) {
    await beforeAttempt?.();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetcher(url, { ...init, signal: controller.signal });
      if (response.ok) return response;
      const retryAfter = response.headers.get("Retry-After");
      const retryAfterMs = retryAfter && /^\d+(?:\.\d+)?$/.test(retryAfter)
        ? Number(retryAfter) * 1000
        : 0;
      lastError = new Error(`provider HTTP ${response.status}`);
      if (response.status < 500 && response.status !== 429) break;
      if (attempt + 1 < MAX_PROVIDER_ATTEMPTS) {
        await sleeper(Math.max(100 * (attempt + 1), retryAfterMs));
      }
      continue;
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timeout);
    }
    if (attempt + 1 < MAX_PROVIDER_ATTEMPTS) await sleeper(100 * (attempt + 1));
  }
  throw lastError;
}

async function fetchJsonWithRetry(
  fetcher: Fetcher,
  url: URL,
  init: RequestInit,
  sleeper: Sleeper = defaultSleep,
  timeoutMs = PROVIDER_TIMEOUT_MS,
  beforeAttempt?: () => Promise<void>,
): Promise<unknown> {
  const response = await fetchWithRetry(fetcher, url, init, sleeper, timeoutMs, beforeAttempt);
  return response.json();
}

async function fetchTextWithRetry(
  fetcher: Fetcher,
  url: URL,
  init: RequestInit,
  sleeper: Sleeper = defaultSleep,
  timeoutMs = PROVIDER_TIMEOUT_MS,
  beforeAttempt?: () => Promise<void>,
): Promise<string> {
  const response = await fetchWithRetry(fetcher, url, init, sleeper, timeoutMs, beforeAttempt);
  return response.text();
}

function normalizedFmpRow(
  row: Record<string, unknown>,
  collectedAt: string,
  universe: ReadonlySet<string>,
): EarningsCalendarObservation | null {
  const rawSymbol = stringValue(row.symbol);
  if (!rawSymbol) return null;
  const symbol = normalizeSymbol(rawSymbol);
  if (!universe.has(symbol) || !isInEarningsUniverse(symbol)) return null;
  const scheduledDate = dateKey(row.date ?? row.reportDate ?? row.announcementDate);
  if (!scheduledDate) return null;
  const fiscalQuarter = parseQuarter(row.fiscalQuarter ?? row.quarter ?? row.fiscal_period);
  const fiscalYear = integer(row.fiscalYear ?? row.year);
  const fiscalPeriodEnd = dateKey(row.fiscalDateEnding ?? row.fiscal_period_end ?? row.periodEnd);
  const providerStatus = String(row.status ?? row.eventStatus ?? "").trim().toLowerCase();
  const providerEventId = stringValue(row.id ?? row.eventId ?? row.providerEventId)
    ?? `${symbol}:${fiscalYear ?? ""}:${fiscalQuarter ?? ""}:${scheduledDate}`;
  return {
    symbol,
    company: stringValue(row.company ?? row.name),
    scheduledDate,
    scheduledTime: stringValue(row.time ?? row.announcementTime),
    timing: timing(row.time ?? row.hour),
    fiscalYear,
    fiscalQuarter,
    fiscalPeriod: stringValue(row.fiscalPeriod ?? row.period ?? (fiscalQuarter ? `Q${fiscalQuarter}` : null)),
    fiscalPeriodEnd,
    epsEstimate: finiteNumber(row.epsEstimated ?? row.epsEstimate ?? row.eps_estimate),
    revenueEstimate: finiteNumber(row.revenueEstimated ?? row.revenueEstimate ?? row.revenue_estimate),
    epsActual: finiteNumber(row.epsActual ?? row.eps_actual),
    revenueActual: finiteNumber(row.revenueActual ?? row.revenue_actual),
    providerEventId,
    providerUpdatedAt: isoTimestamp(row.lastUpdated ?? row.updatedAt ?? row.updated_at, collectedAt),
    officialReportUrl: httpUrlValue(row.officialReportUrl ?? row.official_report_url),
    cancelled: row.cancelled === true || row.isCancelled === true || providerStatus === "cancelled" || providerStatus === "canceled",
  };
}

export function deduplicateCalendarRows(rows: EarningsCalendarObservation[]): EarningsCalendarObservation[] {
  const byKey = new Map<string, EarningsCalendarObservation>();
  for (const row of rows) {
    const key = row.providerEventId ?? `${row.symbol}:${row.scheduledDate}`;
    const previous = byKey.get(key);
    if (!previous || (row.providerUpdatedAt ?? "") >= (previous.providerUpdatedAt ?? "")) byKey.set(key, row);
  }
  return [...byKey.values()];
}

export class FmpEarningsCalendarProvider implements EarningsCalendarProvider, EarningsConsensusProvider {
  readonly name = "fmp-earnings-calendar";
  readonly supportsForwardCalendar = true;

  constructor(
    private readonly apiKey: string,
    private readonly fetcher: Fetcher = fetch,
    private readonly sleeper: Sleeper = defaultSleep,
    private readonly timeoutMs = PROVIDER_TIMEOUT_MS,
  ) {}

  private async fetchRows(range: EarningsDateRange, universe: ReadonlySet<string>, collectedAt: string): Promise<EarningsCalendarObservation[]> {
    if (!this.apiKey.trim()) throw new Error("FMP_API_KEY is not configured");
    const url = new URL(FMP_URL);
    url.searchParams.set("from", range.from);
    url.searchParams.set("to", range.to);
    url.searchParams.set("apikey", this.apiKey);
    const payload = await fetchJsonWithRetry(this.fetcher, url, { headers: { Accept: "application/json" } }, this.sleeper, this.timeoutMs);
    const rows = rowsFromPayload(payload);
    return deduplicateCalendarRows(rows.flatMap((row) => {
      const normalized = normalizedFmpRow(row, collectedAt, universe);
      return normalized && normalized.scheduledDate !== null
        && normalized.scheduledDate >= range.from && normalized.scheduledDate <= range.to
        ? [normalized]
        : [];
    }));
  }

  async fetchCalendar(
    range: EarningsDateRange,
    universe: ReadonlySet<string>,
    collectedAt: string,
  ): Promise<EarningsProviderResult<EarningsCalendarObservation>> {
    const observations = await this.fetchRows(range, universe, collectedAt);
    return { provider: this.name, observations, warnings: [], updatedAt: collectedAt };
  }

  async fetchConsensus(
    range: EarningsDateRange,
    universe: ReadonlySet<string>,
    collectedAt: string,
  ): Promise<EarningsProviderResult<EarningsConsensusObservation>> {
    const observations = await this.fetchRows(range, universe, collectedAt);
    return {
      provider: this.name,
      observations: observations.map((row) => ({
        symbol: row.symbol,
        scheduledDate: row.scheduledDate,
        fiscalYear: row.fiscalYear,
        fiscalQuarter: row.fiscalQuarter,
        fiscalPeriodEnd: row.fiscalPeriodEnd,
        epsEstimate: row.epsEstimate,
        revenueEstimate: row.revenueEstimate,
        epsActual: row.epsActual,
        revenueActual: row.revenueActual,
        providerEventId: row.providerEventId,
        providerUpdatedAt: row.providerUpdatedAt,
        cancelled: row.cancelled,
      })),
      warnings: [],
      updatedAt: collectedAt,
    };
  }
}

function finnhubRowsFromPayload(payload: unknown): Record<string, unknown>[] {
  const object = rowObject(payload);
  const rows = object?.earningsCalendar;
  if (!Array.isArray(rows)) throw new Error("malformed Finnhub earnings calendar response");
  if (rows.some((row) => rowObject(row) === null)) throw new Error("malformed Finnhub earnings calendar rows");
  return rows.map((row) => {
    const item = rowObject(row);
    if (!item) throw new Error("malformed Finnhub earnings calendar row");
    return item;
  });
}

function normalizedFinnhubRow(
  row: Record<string, unknown>,
  collectedAt: string,
  universe: ReadonlySet<string>,
): { observation: EarningsCalendarObservation | null; malformed: boolean } {
  const rawSymbol = stringValue(row.symbol);
  if (!rawSymbol) return { observation: null, malformed: true };
  const symbol = normalizeSymbol(rawSymbol);
  // The bulk endpoint deliberately returns the provider's full calendar. The
  // tracked-universe gate belongs here, after retrieval and before storage.
  if (!universe.has(symbol) || !isInEarningsUniverse(symbol)) return { observation: null, malformed: false };
  const scheduledDate = dateKey(row.date);
  if (!scheduledDate) return { observation: null, malformed: true };
  const fiscalQuarter = parseQuarter(row.quarter);
  const fiscalYear = integer(row.year);
  const timingValue = normalizeFinnhubTiming(row.hour);
  return {
    malformed: false,
    observation: {
      symbol,
      company: null,
      scheduledDate,
      scheduledTime: timingValue,
      timing: timingValue,
      fiscalYear,
      fiscalQuarter,
      fiscalPeriod: fiscalQuarter === null ? null : `Q${fiscalQuarter}`,
      fiscalPeriodEnd: null,
      epsEstimate: finiteNumber(row.epsEstimate),
      revenueEstimate: finiteNumber(row.revenueEstimate),
      epsActual: finiteNumber(row.epsActual),
      revenueActual: finiteNumber(row.revenueActual),
      providerEventId: `finnhub:${symbol}:${fiscalYear ?? "unknown"}:${fiscalQuarter ?? "unknown"}:${scheduledDate}`,
      // Finnhub does not publish a report timestamp in this endpoint. The
      // collection timestamp is provenance for the provider observation; SEC
      // acceptance time remains the source for a genuine filing timestamp.
      providerUpdatedAt: collectedAt,
      officialReportUrl: null,
      cancelled: false,
    },
  };
}

export class FinnhubEarningsProvider implements EarningsCalendarProvider, EarningsConsensusProvider {
  readonly name = "finnhub-earnings-calendar";
  readonly supportsForwardCalendar = true;
  private readonly gate: FinnhubRequestGate;

  constructor(
    private readonly apiKey: string,
    private readonly fetcher: Fetcher = fetch,
    private readonly sleeper: Sleeper = defaultSleep,
    private readonly timeoutMs = PROVIDER_TIMEOUT_MS,
    gate?: FinnhubRequestGate,
  ) {
    this.gate = gate ?? new FinnhubRequestGate(FINNHUB_RATE_PACING_MS, sleeper);
  }

  private async fetchRows(
    range: EarningsDateRange,
    universe: ReadonlySet<string>,
    collectedAt: string,
  ): Promise<{ observations: EarningsCalendarObservation[]; warnings: string[]; complete: boolean }> {
    if (!this.apiKey.trim()) throw new Error("FINNHUB_API_KEY is not configured");
    const url = new URL(FINNHUB_URL);
    url.searchParams.set("from", range.from);
    url.searchParams.set("to", range.to);
    const payload = await fetchJsonWithRetry(
      this.fetcher,
      url,
      {
        headers: {
          Accept: "application/json",
          // Keep the token out of URLs, logs and downstream request metadata.
          "X-Finnhub-Token": this.apiKey,
        },
      },
      this.sleeper,
      this.timeoutMs,
      () => this.gate.beforeAttempt(),
    );
    const rawRows = finnhubRowsFromPayload(payload);
    let malformedCount = 0;
    const observations = rawRows.flatMap((row) => {
      const normalized = normalizedFinnhubRow(row, collectedAt, universe);
      if (normalized.malformed) malformedCount += 1;
      return normalized.observation && normalized.observation.scheduledDate !== null
        && normalized.observation.scheduledDate >= range.from
        && normalized.observation.scheduledDate <= range.to
        ? [normalized.observation]
        : [];
    });
    if (rawRows.length > 0 && malformedCount === rawRows.length) {
      throw new Error("malformed Finnhub earnings calendar rows");
    }
    return {
      observations: deduplicateCalendarRows(observations),
      warnings: malformedCount > 0 ? [`ignored ${malformedCount} malformed Finnhub calendar row(s)`] : [],
      complete: malformedCount === 0,
    };
  }

  async fetchCalendar(
    range: EarningsDateRange,
    universe: ReadonlySet<string>,
    collectedAt: string,
  ): Promise<EarningsProviderResult<EarningsCalendarObservation>> {
    const result = await this.fetchRows(range, universe, collectedAt);
    return { provider: this.name, observations: result.observations, warnings: result.warnings, updatedAt: collectedAt, complete: result.complete };
  }

  /**
   * Symbol-scoped historical recovery (verified in production 2026-08-16).
   * The bulk calendar endpoint caps its payload at ~1500 rows dominated by
   * near-term dates, so MSFT (2026-07-29) and AAPL (2026-07-30) were absent
   * from the bulk window while the symbol-scoped call returned them with
   * full EPS/revenue estimates AND actuals.
   */
  async fetchSymbolHistory(
    symbol: string,
    range: EarningsDateRange,
    collectedAt: string,
  ): Promise<EarningsProviderResult<EarningsCalendarObservation>> {
    if (!this.apiKey.trim()) throw new Error("FINNHUB_API_KEY is not configured");
    const url = new URL(FINNHUB_URL);
    url.searchParams.set("from", range.from);
    url.searchParams.set("to", range.to);
    url.searchParams.set("symbol", symbol);
    const payload = await fetchJsonWithRetry(
      this.fetcher,
      url,
      {
        headers: {
          Accept: "application/json",
          "X-Finnhub-Token": this.apiKey,
        },
      },
      this.sleeper,
      this.timeoutMs,
      () => this.gate.beforeAttempt(),
    );
    const rawRows = finnhubRowsFromPayload(payload);
    const observations = rawRows.flatMap((row) => {
      const normalized = normalizedFinnhubRow(row, collectedAt, new Set([symbol]));
      return normalized.observation && normalized.observation.scheduledDate !== null
        && normalized.observation.scheduledDate >= range.from
        && normalized.observation.scheduledDate <= range.to
        ? [normalized.observation]
        : [];
    });
    return {
      provider: this.name,
      observations: deduplicateCalendarRows(observations),
      warnings: [],
      updatedAt: collectedAt,
      complete: true,
    };
  }

  async fetchConsensus(
    range: EarningsDateRange,
    universe: ReadonlySet<string>,
    collectedAt: string,
  ): Promise<EarningsProviderResult<EarningsConsensusObservation>> {
    const result = await this.fetchRows(range, universe, collectedAt);
    return {
      provider: this.name,
      observations: result.observations.map((row) => ({
        symbol: row.symbol,
        scheduledDate: row.scheduledDate,
        fiscalYear: row.fiscalYear,
        fiscalQuarter: row.fiscalQuarter,
        fiscalPeriodEnd: row.fiscalPeriodEnd,
        epsEstimate: row.epsEstimate,
        revenueEstimate: row.revenueEstimate,
        epsActual: row.epsActual,
        revenueActual: row.revenueActual,
        providerEventId: row.providerEventId,
        providerUpdatedAt: row.providerUpdatedAt,
        cancelled: row.cancelled,
      })),
      warnings: result.warnings,
      updatedAt: collectedAt,
      complete: result.complete,
    };
  }
}

/**
 * Finnhub Company Profile 2 — stable company metadata enrichment
 * (name, logo, industry, website, exchange).
 *
 * Deliberately NOT on the critical earnings path: fetchProfile failures are
 * recorded as enrichment diagnostics by the caller but never degrade the
 * calendar/monitor health gate. The raw binary is never stored — only the
 * external logo URL is persisted in D1.
 */
function normalizedFinnhubProfile(
  payload: unknown,
  symbol: string,
): CompanyProfileObservation {
  const object = rowObject(payload);
  if (!object) return { symbol, company: null, logoUrl: null, industry: null, websiteUrl: null, exchange: null };
  const logoUrl = httpUrlValue(object.logo);
  const websiteUrl = httpUrlValue(object.weburl);
  return {
    symbol,
    company: stringValue(object.name),
    logoUrl,
    industry: stringValue(object.finnhubIndustry),
    websiteUrl,
    exchange: stringValue(object.exchange),
  };
}

export class FinnhubCompanyProfileProvider implements CompanyProfileProvider {
  readonly name = "finnhub-company-profile";
  private readonly gate: FinnhubRequestGate;

  constructor(
    private readonly apiKey: string,
    private readonly fetcher: Fetcher = fetch,
    private readonly sleeper: Sleeper = defaultSleep,
    private readonly timeoutMs = PROVIDER_TIMEOUT_MS,
    gate?: FinnhubRequestGate,
  ) {
    this.gate = gate ?? new FinnhubRequestGate(FINNHUB_RATE_PACING_MS, sleeper);
  }

  async fetchProfile(symbol: string, collectedAt?: string): Promise<CompanyProfileObservation> {
    void collectedAt;
    if (!this.apiKey.trim()) throw new Error("FINNHUB_API_KEY is not configured");
    const url = new URL(FINNHUB_PROFILE_URL);
    url.searchParams.set("symbol", symbol);
    const payload = await fetchJsonWithRetry(
      this.fetcher,
      url,
      {
        headers: {
          Accept: "application/json",
          // Keep the token out of URLs, logs and downstream request metadata.
          "X-Finnhub-Token": this.apiKey,
        },
      },
      this.sleeper,
      this.timeoutMs,
      () => this.gate.beforeAttempt(),
    );
    const profile = normalizedFinnhubProfile(payload, symbol);
    if (profile.company === null && profile.logoUrl === null
      && profile.industry === null && profile.websiteUrl === null && profile.exchange === null) {
      throw new Error(`malformed Finnhub company profile response for ${symbol}`);
    }
    return profile;
  }
}

function padCik(value: unknown): string | null {
  const digits = String(value ?? "").replace(/\D/g, "");
  return digits ? digits.padStart(10, "0").slice(-10) : null;
}

function parseSecMetadata(payload: unknown): CompanyMetadata[] {
  const object = rowObject(payload);
  if (!object) throw new Error("malformed SEC company metadata response");
  const fields = Array.isArray(object.fields) ? object.fields.map(String) : [];
  const rows = Array.isArray(object.data) ? object.data : [];
  if (fields.length > 0 && rows.every((row) => Array.isArray(row))) {
    return rows.flatMap((row) => {
      const values = row as unknown[];
      const raw = Object.fromEntries(fields.map((field, index) => [field, values[index]]));
      const symbol = normalizeSymbol(String(raw.ticker ?? ""));
      if (!symbol || !/^[A-Z0-9-]{1,12}$/.test(symbol)) return [];
      return [{ symbol, company: String(raw.name ?? symbol), cik: padCik(raw.cik), exchange: stringValue(raw.exchange), investorRelationsUrl: httpUrlValue(raw.investorRelationsUrl ?? raw.irUrl) }];
    });
  }
  if (Array.isArray(object.data)) {
    return object.data.flatMap((row) => {
      const raw = rowObject(row);
      if (!raw) return [];
      const symbol = normalizeSymbol(String(raw.ticker ?? ""));
      if (!symbol || !/^[A-Z0-9-]{1,12}$/.test(symbol)) return [];
      return [{ symbol, company: String(raw.name ?? symbol), cik: padCik(raw.cik), exchange: stringValue(raw.exchange), investorRelationsUrl: httpUrlValue(raw.investorRelationsUrl ?? raw.irUrl) }];
    });
  }
  throw new Error("malformed SEC company metadata response");
}

type SecRecent = Record<string, unknown>;

function secRecentRows(payload: unknown): SecRecent[] {
  const object = rowObject(payload);
  const recent = object ? rowObject(object.filings) : null;
  const rows = recent ? rowObject(recent.recent) : null;
  if (!rows) throw new Error("malformed SEC submissions response");
  const keys = ["form", "filingDate", "acceptanceDateTime", "accessionNumber", "primaryDocument", "reportDate", "items"];
  const length = Array.isArray(rows.form) ? rows.form.length : 0;
  if (length === 0) return [];
  return Array.from({ length }, (_, index) => Object.fromEntries(keys.map((key) => [key, Array.isArray(rows[key]) ? rows[key][index] : null])));
}

function filingUrl(cik: string, accession: string, primaryDocument: string | null): string | null {
  if (!/^\d{10}$/.test(cik) || !/^\d{10}-\d{2}-\d{6}$/.test(accession)) return null;
  const accessionPath = accession.replace(/-/g, "");
  const document = primaryDocument && /^[A-Za-z0-9._-]+$/.test(primaryDocument)
    ? primaryDocument
    : `${accession}-index.html`;
  return `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accessionPath}/${document}`;
}

function dateDistanceDays(left: string, right: string): number {
  return Math.abs(Date.parse(`${left}T00:00:00.000Z`) - Date.parse(`${right}T00:00:00.000Z`)) / (24 * 60 * 60 * 1000);
}

function secFiledTimestamp(value: unknown, filedDate: string): string {
  if (typeof value === "string") {
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) return new Date(timestamp).toISOString();
  }
  return `${filedDate}T00:00:00.000Z`;
}

function filingPriority(filing: OfficialFiling): number {
  const baseForm = filing.form.replace(/\/A$/, "");
  if (baseForm === "8-K" && filing.items.includes("2.02")) return 0;
  if (baseForm === "10-Q") return 1;
  if (baseForm === "10-K") return 2;
  if (baseForm === "6-K") return 3;
  return 9;
}

export function secIndexQuarters(range: EarningsDateRange): string[] {
  const from = new Date(`${range.from}T12:00:00.000Z`);
  const to = new Date(`${range.to}T12:00:00.000Z`);
  const quarters: string[] = [];
  let year = from.getUTCFullYear();
  let quarter = Math.floor(from.getUTCMonth() / 3) + 1;
  const endYear = to.getUTCFullYear();
  const endQuarter = Math.floor(to.getUTCMonth() / 3) + 1;
  while (year < endYear || (year === endYear && quarter <= endQuarter)) {
    quarters.push(`${year}/QTR${quarter}`);
    quarter += 1;
    if (quarter === 5) {
      quarter = 1;
      year += 1;
    }
  }
  return quarters;
}

function parseSecMasterIndex(
  payload: string,
  range: EarningsDateRange,
  metadataByCik: ReadonlyMap<string, CompanyMetadata>,
  universe: ReadonlySet<string>,
): EarningsCalendarObservation[] {
  const observations: EarningsCalendarObservation[] = [];
  const seen = new Set<string>();
  for (const line of payload.split(/\r?\n/)) {
    const match = line.match(/^(\d+)\|([^|]*)\|([^|]+)\|(\d{4}-\d{2}-\d{2})\|(.+)$/);
    if (!match) continue;
    const cik = padCik(match[1]);
    const form = match[3]!.trim();
    const filedDate = dateKey(match[4]!);
    const filename = match[5]!.trim();
    const accession = filename.match(/(\d{10}-\d{2}-\d{6})/)?.[1] ?? null;
    if (!cik || !filedDate || filedDate < range.from || filedDate > range.to || !accession) continue;
    const baseForm = form.replace(/\/A$/, "");
    if (form !== baseForm || !SEC_CALENDAR_FORMS.has(baseForm) || seen.has(accession)) continue;
    const company = metadataByCik.get(cik);
    if (!company || !universe.has(company.symbol) || !isInEarningsUniverse(company.symbol)) continue;
    const url = filingUrl(cik, accession, null);
    if (!url) continue;
    const filing: OfficialFiling = {
      url,
      accession,
      form,
      filedAt: `${filedDate}T00:00:00.000Z`,
      reportDate: null,
      items: [],
    };
    seen.add(accession);
    observations.push({
      symbol: company.symbol,
      company: company.company,
      scheduledDate: filedDate,
      scheduledTime: null,
      timing: "TBD",
      fiscalYear: null,
      fiscalQuarter: null,
      fiscalPeriod: null,
      fiscalPeriodEnd: null,
      epsEstimate: null,
      revenueEstimate: null,
      epsActual: null,
      revenueActual: null,
      providerEventId: accession,
      providerUpdatedAt: filing.filedAt,
      officialReportUrl: url,
      officialFiling: filing,
      cancelled: false,
    });
  }
  return observations;
}

export class SecEdgarProvider implements OfficialFilingsProvider, EarningsCalendarProvider, EarningsConsensusProvider {
  readonly name = "sec-edgar";
  readonly supportsForwardCalendar = false;
  private lastRequestAt = 0;
  private readonly metadataByCik = new Map<string, CompanyMetadata>();

  constructor(
    private readonly userAgent = "StockAutotrader/1.0 (+https://github.com/drdrey7/stock-autotrader)",
    private readonly fetcher: Fetcher = fetch,
    private readonly sleeper: Sleeper = defaultSleep,
    private readonly timeoutMs = PROVIDER_TIMEOUT_MS,
  ) {}

  private headers(accept = "application/json"): HeadersInit {
    return { Accept: accept, "User-Agent": this.userAgent };
  }

  private async waitForSecRequestSlot(): Promise<void> {
    const wait = Math.max(0, this.lastRequestAt + SEC_MIN_REQUEST_INTERVAL_MS - Date.now());
    if (wait > 0) await this.sleeper(wait);
    this.lastRequestAt = Date.now();
  }

  async fetchCompanyMetadata(collectedAt: string): Promise<EarningsProviderResult<CompanyMetadata>> {
    const payload = await fetchJsonWithRetry(this.fetcher, new URL(SEC_TICKERS_URL), { headers: this.headers() }, this.sleeper, this.timeoutMs, () => this.waitForSecRequestSlot());
    const observations = parseSecMetadata(payload);
    for (const observation of observations) {
      if (observation.cik) this.metadataByCik.set(observation.cik, observation);
    }
    return { provider: this.name, observations, warnings: [], updatedAt: collectedAt };
  }

  async fetchCalendar(
    range: EarningsDateRange,
    universe: ReadonlySet<string>,
    collectedAt: string,
  ): Promise<EarningsProviderResult<EarningsCalendarObservation>> {
    if (this.metadataByCik.size === 0) await this.fetchCompanyMetadata(collectedAt);
    const observations: EarningsCalendarObservation[] = [];
    const warnings: string[] = [];
    let successfulIndexes = 0;
    for (const quarter of secIndexQuarters(range)) {
      try {
        const payload = await fetchTextWithRetry(
          this.fetcher,
          new URL(`${SEC_FULL_INDEX_URL}/${quarter}/master.idx`),
          { headers: this.headers("text/plain") },
          this.sleeper,
          this.timeoutMs,
          () => this.waitForSecRequestSlot(),
        );
        successfulIndexes += 1;
        observations.push(...parseSecMasterIndex(payload, range, this.metadataByCik, universe));
      } catch (error) {
        warnings.push(`${quarter}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (successfulIndexes === 0 && secIndexQuarters(range).length > 0) {
      throw new Error(`SEC full index unavailable${warnings[0] ? `: ${warnings[0]}` : ""}`);
    }
    return {
      provider: this.name,
      observations: deduplicateCalendarRows(observations),
      warnings,
      updatedAt: collectedAt,
    };
  }

  async fetchConsensus(
    _range: EarningsDateRange,
    _universe: ReadonlySet<string>,
    collectedAt: string,
  ): Promise<EarningsProviderResult<EarningsConsensusObservation>> {
    return {
      provider: this.name,
      observations: [],
      warnings: ["SEC EDGAR does not publish analyst consensus estimates"],
      updatedAt: collectedAt,
    };
  }

  async findRelevantFiling(
    event: Pick<EarningsEngineEvent, "scheduledDate" | "fiscalPeriodEnd" | "cik">,
    asOf: string,
  ): Promise<OfficialFiling | null> {
    if (!event.cik) return null;
    const url = new URL(`${SEC_SUBMISSIONS_URL}${event.cik}.json`);
    const payload = await fetchJsonWithRetry(this.fetcher, url, { headers: this.headers() }, this.sleeper, this.timeoutMs, () => this.waitForSecRequestSlot());
    const candidatesByAccession = new Map<string, OfficialFiling>();
    for (const row of secRecentRows(payload)) {
      const form = String(row.form ?? "");
      const baseForm = form.replace(/\/A$/, "");
      if (!(baseForm === "8-K" || baseForm === "10-Q" || baseForm === "10-K" || baseForm === "6-K")) continue;
      const filedAt = dateKey(row.filingDate);
      const accession = stringValue(row.accessionNumber);
      if (!filedAt || !accession || filedAt > asOf) continue;
      const items = String(row.items ?? "").split(",").map((item) => item.trim()).filter(Boolean);
      if (baseForm === "8-K" && !items.includes("2.02")) continue;
      const reportDate = dateKey(row.reportDate);
      const periodMatch = Boolean(event.fiscalPeriodEnd && reportDate === event.fiscalPeriodEnd);
      const scheduleMatch = Boolean(event.scheduledDate && dateDistanceDays(filedAt, event.scheduledDate) <= 14);
      const relevant = baseForm === "8-K"
        ? scheduleMatch
        : event.fiscalPeriodEnd
          ? periodMatch
          : scheduleMatch;
      if (!relevant) continue;
      const urlValue = filingUrl(event.cik, accession, stringValue(row.primaryDocument));
      if (!urlValue) continue;
      if (!candidatesByAccession.has(accession)) {
        candidatesByAccession.set(accession, { url: urlValue, accession, form, filedAt: secFiledTimestamp(row.acceptanceDateTime, filedAt), reportDate, items });
      }
    }
    const candidates = [...candidatesByAccession.values()];
    candidates.sort((left, right) => filingPriority(left) - filingPriority(right) || right.filedAt.localeCompare(left.filedAt));
    return candidates[0] ?? null;
  }
}

export function createDefaultEarningsProviders(finnhubApiKey: string | undefined, secUserAgent?: string): EarningsProviderBundle {
  const sec = new SecEdgarProvider(secUserAgent?.trim() || undefined);
  // One shared Finnhub gate for bulk calendar, symbol recovery and profile2 so
  // every physical Finnhub HTTP attempt (incl. retries) is paced at >= 1.1s.
  // calendar === consensus is intentional: production must not double-fetch bulk.
  const finnhubGate = new FinnhubRequestGate();
  const finnhub = new FinnhubEarningsProvider(finnhubApiKey ?? "", fetch, defaultSleep, PROVIDER_TIMEOUT_MS, finnhubGate);
  return {
    calendar: finnhub,
    consensus: finnhub,
    official: sec,
    profile: new FinnhubCompanyProfileProvider(finnhubApiKey ?? "", fetch, defaultSleep, PROVIDER_TIMEOUT_MS, finnhubGate),
  };
}
