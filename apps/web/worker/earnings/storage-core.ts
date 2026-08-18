import type { EarningsEngineEvent } from "@stock-autotrader/contracts";
import { calculateMetric, calculateOverallResult, canonicalFiscalPeriod } from "./logic";
import type { NormalizedEarningsEvent } from "./types";
import { ACTIVE_UNIVERSE_PREDICATE } from "../stock-universe";

export type Database = Pick<D1Database, "prepare"> & Partial<Pick<D1Database, "batch">>;

interface EarningsRow extends Record<string, unknown> {
  id?: unknown;
  symbol?: unknown;
  company?: unknown;
  cik?: unknown;
  fiscal_year?: unknown;
  fiscal_quarter?: unknown;
  fiscal_period?: unknown;
  fiscal_period_end?: unknown;
  scheduled_date?: unknown;
  scheduled_time?: unknown;
  timing?: unknown;
  status?: unknown;
  scheduled?: unknown;
  reported?: unknown;
  cancelled?: unknown;
  unknown?: unknown;
  eps_estimate?: unknown;
  eps_actual?: unknown;
  eps_surprise?: unknown;
  eps_surprise_pct?: unknown;
  eps_result?: unknown;
  revenue_estimate?: unknown;
  revenue_actual?: unknown;
  revenue_surprise?: unknown;
  revenue_surprise_pct?: unknown;
  revenue_result?: unknown;
  overall_result?: unknown;
  reported_at?: unknown;
  reported_at_source?: unknown;
  eps_actual_gaap?: unknown;
  eps_actual_gaap_source?: unknown;
  eps_actual_adjusted?: unknown;
  eps_actual_adjusted_source?: unknown;
  revenue_actual_official?: unknown;
  revenue_actual_source?: unknown;
  eps_estimate_source?: unknown;
  revenue_estimate_source?: unknown;
  data_quality_status?: unknown;
  calendar_provider?: unknown;
  consensus_provider?: unknown;
  provider_event_id?: unknown;
  provider_updated_at?: unknown;
  official_report_url?: unknown;
  investor_relations_url?: unknown;
  sec_filing_url?: unknown;
  sec_accession?: unknown;
  sec_form?: unknown;
  sec_filed_at?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
  last_checked_at?: unknown;
  // Joined from earnings_universe at read time (never written to events).
  logo_url?: unknown;
  industry?: unknown;
  website_url?: unknown;
}

const text = (value: unknown): string | null => value === null || value === undefined ? null : String(value);
const requiredText = (value: unknown, fallback: string): string => text(value) ?? fallback;
const numberOrNull = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const integerOrNull = (value: unknown): number | null => {
  const parsed = numberOrNull(value);
  return parsed !== null && Number.isInteger(parsed) ? parsed : null;
};
const booleanFrom = (value: unknown): boolean => Number(value) === 1 || value === true;

export function rowToEarningsEvent(row: EarningsRow): EarningsEngineEvent {
  return {
    id: requiredText(row.id, "unknown"),
    symbol: requiredText(row.symbol, ""),
    company: requiredText(row.company, requiredText(row.symbol, "Not published")),
    cik: text(row.cik),
    fiscalYear: integerOrNull(row.fiscal_year),
    fiscalQuarter: integerOrNull(row.fiscal_quarter),
    fiscalPeriod: text(row.fiscal_period),
    fiscalPeriodEnd: text(row.fiscal_period_end),
    scheduledDate: text(row.scheduled_date),
    scheduledTime: text(row.scheduled_time),
    timing: requiredText(row.timing, "TBD") as "BMO" | "AMC" | "TBD",
    status: requiredText(row.status, "unknown") as EarningsEngineEvent["status"],
    scheduled: booleanFrom(row.scheduled),
    reported: booleanFrom(row.reported),
    cancelled: booleanFrom(row.cancelled),
    unknown: booleanFrom(row.unknown),
    epsEstimate: numberOrNull(row.eps_estimate),
    epsActual: numberOrNull(row.eps_actual),
    epsSurprise: numberOrNull(row.eps_surprise),
    epsSurprisePct: numberOrNull(row.eps_surprise_pct),
    epsResult: requiredText(row.eps_result, "Not Available") as EarningsEngineEvent["epsResult"],
    revenueEstimate: numberOrNull(row.revenue_estimate),
    revenueActual: numberOrNull(row.revenue_actual),
    revenueSurprise: numberOrNull(row.revenue_surprise),
    revenueSurprisePct: numberOrNull(row.revenue_surprise_pct),
    revenueResult: requiredText(row.revenue_result, "Not Available") as EarningsEngineEvent["revenueResult"],
    overallResult: requiredText(row.overall_result, "Not Available") as EarningsEngineEvent["overallResult"],
    reportedAt: text(row.reported_at),
    reportedAtSource: text(row.reported_at_source) as EarningsEngineEvent["reportedAtSource"],
    epsActualGaap: numberOrNull(row.eps_actual_gaap),
    epsActualGaapSource: text(row.eps_actual_gaap_source) as EarningsEngineEvent["epsActualGaapSource"],
    epsActualAdjusted: numberOrNull(row.eps_actual_adjusted),
    epsActualAdjustedSource: text(row.eps_actual_adjusted_source) as EarningsEngineEvent["epsActualAdjustedSource"],
    revenueActualOfficial: numberOrNull(row.revenue_actual_official),
    revenueActualSource: text(row.revenue_actual_source) as EarningsEngineEvent["revenueActualSource"],
    epsEstimateSource: text(row.eps_estimate_source) as EarningsEngineEvent["epsEstimateSource"],
    revenueEstimateSource: text(row.revenue_estimate_source) as EarningsEngineEvent["revenueEstimateSource"],
    dataQualityStatus: text(row.data_quality_status) as EarningsEngineEvent["dataQualityStatus"],
    calendarProvider: text(row.calendar_provider),
    consensusProvider: text(row.consensus_provider),
    providerEventId: text(row.provider_event_id),
    providerUpdatedAt: text(row.provider_updated_at),
    officialReportUrl: text(row.official_report_url),
    investorRelationsUrl: text(row.investor_relations_url),
    secFilingUrl: text(row.sec_filing_url),
    secAccession: text(row.sec_accession),
    secForm: text(row.sec_form),
    secFiledAt: text(row.sec_filed_at),
    createdAt: requiredText(row.created_at, "1970-01-01T00:00:00.000Z"),
    updatedAt: requiredText(row.updated_at, "1970-01-01T00:00:00.000Z"),
    lastCheckedAt: text(row.last_checked_at),
    logoUrl: text(row.logo_url),
    industry: text(row.industry),
    websiteUrl: text(row.website_url),
  };
}

async function findExisting(db: Database, event: NormalizedEarningsEvent): Promise<EarningsRow | null> {
  const byId = await db.prepare("SELECT * FROM earnings_events WHERE id = ? LIMIT 1").bind(event.id).first<EarningsRow>();
  if (byId) return byId;

  if (event.providerEventId) {
    const byProviderId = event.calendarProvider
      ? await db.prepare("SELECT * FROM earnings_events WHERE provider_event_id = ? AND calendar_provider = ? LIMIT 1")
        .bind(event.providerEventId, event.calendarProvider).first<EarningsRow>()
      : await db.prepare("SELECT * FROM earnings_events WHERE provider_event_id = ? LIMIT 1")
        .bind(event.providerEventId).first<EarningsRow>();
    if (byProviderId) return byProviderId;
  }

  const incomingPeriod = canonicalFiscalPeriod(event.fiscalQuarter, event.fiscalPeriod);
  if (event.fiscalYear !== null && incomingPeriod !== null) {
    const byPeriod = await db.prepare("SELECT * FROM earnings_events WHERE symbol = ? AND fiscal_year = ? LIMIT 8")
      .bind(event.symbol, event.fiscalYear).all<EarningsRow>();
    const matchingPeriod = byPeriod.results.find((candidate) =>
      canonicalFiscalPeriod(integerOrNull(candidate.fiscal_quarter), text(candidate.fiscal_period)) === incomingPeriod,
    );
    if (matchingPeriod) return matchingPeriod;
  }

  if (event.scheduledDate) {
    const byDate = await db.prepare("SELECT * FROM earnings_events WHERE symbol = ? AND scheduled_date = ? LIMIT 1")
      .bind(event.symbol, event.scheduledDate).first<EarningsRow>();
    const sameFiscalIdentity = event.fiscalYear === null || incomingPeriod === null
      || integerOrNull(byDate?.fiscal_year) === null
      || canonicalFiscalPeriod(integerOrNull(byDate?.fiscal_quarter), text(byDate?.fiscal_period)) === incomingPeriod;
    if (byDate && sameFiscalIdentity) return byDate;
  }

  // Safe fallback for providers that have not exposed fiscal period or an ID:
  // one nearby non-cancelled event for the same symbol is the same event when
  // a calendar provider moves its date by up to two weeks. This also repairs a
  // delayed result whose old scheduled row was already moved to `unknown`.
  const candidates = await db.prepare(
    "SELECT * FROM earnings_events WHERE symbol = ? AND status != 'cancelled' AND fiscal_year IS NULL AND fiscal_quarter IS NULL AND fiscal_period IS NULL ORDER BY scheduled_date DESC LIMIT 8",
  ).bind(event.symbol).all<EarningsRow>();
  if (!event.scheduledDate) return null;
  const target = Date.parse(`${event.scheduledDate}T00:00:00.000Z`);
  const nearby = candidates.results
    .filter((candidate) => typeof candidate.scheduled_date === "string")
    .map((candidate) => ({ row: candidate, distance: Math.abs(Date.parse(`${candidate.scheduled_date as string}T00:00:00.000Z`) - target) }))
    .filter(({ distance }) => Number.isFinite(distance) && distance <= 14 * 24 * 60 * 60 * 1000)
    .sort((left, right) => left.distance - right.distance);
  return nearby.length === 1 ? nearby[0]!.row : null;
}

function incomingProviderIsOlder(existing: EarningsRow, incoming: NormalizedEarningsEvent): boolean {
  const old = text(existing.provider_updated_at);
  const next = incoming.providerUpdatedAt;
  return Boolean(old && next && Date.parse(next) < Date.parse(old));
}

function mergedEvent(existing: EarningsRow | null, incoming: NormalizedEarningsEvent, targetId: string): NormalizedEarningsEvent {
  if (!existing) return { ...incoming, id: targetId };
  const old = rowToEarningsEvent(existing);
  const providerOlder = incomingProviderIsOlder(existing, incoming);
  const providerValues = providerOlder
    ? {
        scheduledDate: old.scheduledDate,
        scheduledTime: old.scheduledTime,
        timing: old.timing,
        fiscalYear: old.fiscalYear,
        fiscalQuarter: old.fiscalQuarter,
        fiscalPeriod: old.fiscalPeriod,
        fiscalPeriodEnd: old.fiscalPeriodEnd,
        epsEstimate: old.epsEstimate,
        epsActual: old.epsActual,
        revenueEstimate: old.revenueEstimate,
        revenueActual: old.revenueActual,
        providerEventId: old.providerEventId,
        providerUpdatedAt: old.providerUpdatedAt,
      }
    : {};
  const reportedAlready = old.reported;
  // If provider values are rejected, keep the lifecycle attached to the
  // schedule/data that won. A stale payload may normalize to `unknown` or
  // `cancelled` even though the preserved event is still scheduled.
  const preservedLifecycle = providerOlder || reportedAlready || old.cancelled
    ? {
        status: old.status,
        scheduled: old.scheduled,
        reported: old.reported,
        cancelled: old.cancelled,
        unknown: old.unknown,
        reportedAt: old.reportedAt,
      }
    : {};
  // Official SEC GAAP metrics and their provenance are owned by the one-shot
  // official backfill, never by the provider sync. A provider observation
  // carries nulls for all of these (dataQualityStatus normalizes to
  // "pending"), so they must be preserved from the existing row instead of
  // being clobbered by the incoming spread.
  const preservedOfficial = {
    reportedAtSource: old.reportedAtSource,
    epsActualGaap: old.epsActualGaap,
    epsActualGaapSource: old.epsActualGaapSource,
    epsActualAdjusted: incoming.epsActualAdjusted ?? old.epsActualAdjusted,
    epsActualAdjustedSource: incoming.epsActualAdjustedSource ?? old.epsActualAdjustedSource,
    revenueActualOfficial: old.revenueActualOfficial,
    revenueActualSource: old.revenueActualSource,
    epsEstimateSource: incoming.epsEstimateSource ?? old.epsEstimateSource,
    revenueEstimateSource: incoming.revenueEstimateSource ?? old.revenueEstimateSource,
    // "pending" (or unset) from a fresh provider event must never downgrade an
    // audited status ("different-basis", "conflict", ...). Undefined-safe: the
    // provider path never sets dataQualityStatus on the incoming event.
    dataQualityStatus: (incoming.dataQualityStatus ?? "pending") === "pending"
      ? old.dataQualityStatus ?? "pending"
      : incoming.dataQualityStatus,
  };
  const epsEstimate = providerOlder ? old.epsEstimate : incoming.epsEstimate ?? old.epsEstimate;
  const epsActual = providerOlder ? old.epsActual : incoming.epsActual ?? old.epsActual;
  const revenueEstimate = providerOlder ? old.revenueEstimate : incoming.revenueEstimate ?? old.revenueEstimate;
  const revenueActual = providerOlder ? old.revenueActual : incoming.revenueActual ?? old.revenueActual;
  // Surprise/Result share the SAME market actual the UI displays: explicit
  // adjusted (incoming ?? preserved) first, legacy provider actual as fallback.
  const epsAdjusted = incoming.epsActualAdjusted ?? old.epsActualAdjusted;
  const eps = calculateMetric(epsAdjusted ?? epsActual, epsEstimate);
  const revenue = calculateMetric(revenueActual, revenueEstimate);
  return {
    ...old,
    ...incoming,
    ...providerValues,
    ...preservedLifecycle,
    ...preservedOfficial,
    id: targetId,
    company: incoming.company || old.company,
    cik: incoming.cik ?? old.cik,
    investorRelationsUrl: incoming.investorRelationsUrl ?? old.investorRelationsUrl,
    officialReportUrl: incoming.officialReportUrl ?? old.officialReportUrl,
    secFilingUrl: incoming.secFilingUrl ?? old.secFilingUrl,
    secAccession: incoming.secAccession ?? old.secAccession,
    secForm: incoming.secForm ?? old.secForm,
    secFiledAt: incoming.secFiledAt ?? old.secFiledAt,
    createdAt: old.createdAt,
    epsEstimate,
    epsActual,
    epsSurprise: eps.surprise,
    epsSurprisePct: eps.surprisePct,
    epsResult: eps.result,
    revenueEstimate,
    revenueActual,
    revenueSurprise: revenue.surprise,
    revenueSurprisePct: revenue.surprisePct,
    revenueResult: revenue.result,
    overallResult: calculateOverallResult(eps.result, revenue.result),
  };
}

const VALUES = [
  "id", "symbol", "company", "cik", "fiscal_year", "fiscal_quarter", "fiscal_period", "fiscal_period_end",
  "scheduled_date", "scheduled_time", "timing", "status", "scheduled", "reported", "cancelled", "unknown",
  "eps_estimate", "eps_actual", "eps_surprise", "eps_surprise_pct", "eps_result", "revenue_estimate", "revenue_actual",
  "revenue_surprise", "revenue_surprise_pct", "revenue_result", "overall_result", "reported_at", "reported_at_source",
  "eps_actual_gaap", "eps_actual_gaap_source", "eps_actual_adjusted", "eps_actual_adjusted_source",
  "revenue_actual_official", "revenue_actual_source", "eps_estimate_source", "revenue_estimate_source",
  "data_quality_status", "calendar_provider",
  "consensus_provider", "provider_event_id", "provider_updated_at", "official_report_url", "investor_relations_url",
  "sec_filing_url", "sec_accession", "sec_form", "sec_filed_at", "created_at", "updated_at", "last_checked_at",
] as const;

function params(event: NormalizedEarningsEvent): unknown[] {
  return [
    event.id, event.symbol, event.company, event.cik, event.fiscalYear, event.fiscalQuarter, event.fiscalPeriod,
    event.fiscalPeriodEnd, event.scheduledDate, event.scheduledTime, event.timing, event.status,
    event.scheduled ? 1 : 0, event.reported ? 1 : 0, event.cancelled ? 1 : 0, event.unknown ? 1 : 0,
    event.epsEstimate, event.epsActual, event.epsSurprise, event.epsSurprisePct, event.epsResult,
    event.revenueEstimate, event.revenueActual, event.revenueSurprise, event.revenueSurprisePct, event.revenueResult,
    event.overallResult, event.reportedAt, event.reportedAtSource,
    event.epsActualGaap, event.epsActualGaapSource, event.epsActualAdjusted, event.epsActualAdjustedSource,
    event.revenueActualOfficial, event.revenueActualSource, event.epsEstimateSource, event.revenueEstimateSource,
    event.dataQualityStatus,
    event.calendarProvider, event.consensusProvider, event.providerEventId,
    event.providerUpdatedAt, event.officialReportUrl, event.investorRelationsUrl, event.secFilingUrl, event.secAccession,
    event.secForm, event.secFiledAt, event.createdAt, event.updatedAt, event.lastCheckedAt,
  ];
}

function isUniqueConstraintError(error: unknown): boolean {
  return /unique constraint|constraint failed/i.test(error instanceof Error ? error.message : String(error));
}

const EVENT_COLUMNS = VALUES.join(", ");
const EVENT_PLACEHOLDERS = VALUES.map(() => "?").join(", ");
const EVENT_UPDATES = [
  "symbol = excluded.symbol",
  "company = COALESCE(excluded.company, earnings_events.company)",
  "cik = COALESCE(excluded.cik, earnings_events.cik)",
  "fiscal_year = COALESCE(excluded.fiscal_year, earnings_events.fiscal_year)",
  "fiscal_quarter = COALESCE(excluded.fiscal_quarter, earnings_events.fiscal_quarter)",
  "fiscal_period = COALESCE(excluded.fiscal_period, earnings_events.fiscal_period)",
  "fiscal_period_end = COALESCE(excluded.fiscal_period_end, earnings_events.fiscal_period_end)",
  "scheduled_date = COALESCE(excluded.scheduled_date, earnings_events.scheduled_date)",
  "scheduled_time = COALESCE(excluded.scheduled_time, earnings_events.scheduled_time)",
  "timing = excluded.timing",
  "status = CASE WHEN earnings_events.reported = 1 AND excluded.reported = 0 THEN earnings_events.status ELSE excluded.status END",
  "scheduled = CASE WHEN earnings_events.reported = 1 AND excluded.reported = 0 THEN earnings_events.scheduled ELSE excluded.scheduled END",
  "reported = MAX(earnings_events.reported, excluded.reported)",
  "cancelled = CASE WHEN earnings_events.reported = 1 THEN earnings_events.cancelled WHEN excluded.cancelled = 1 THEN 1 ELSE earnings_events.cancelled END",
  "unknown = CASE WHEN earnings_events.reported = 1 AND excluded.reported = 0 THEN earnings_events.unknown ELSE excluded.unknown END",
  "eps_estimate = COALESCE(excluded.eps_estimate, earnings_events.eps_estimate)",
  "eps_actual = COALESCE(excluded.eps_actual, earnings_events.eps_actual)",
  "eps_surprise = COALESCE(excluded.eps_surprise, earnings_events.eps_surprise)",
  "eps_surprise_pct = COALESCE(excluded.eps_surprise_pct, earnings_events.eps_surprise_pct)",
  "eps_result = CASE WHEN excluded.eps_result = 'Not Available' THEN earnings_events.eps_result ELSE excluded.eps_result END",
  "revenue_estimate = COALESCE(excluded.revenue_estimate, earnings_events.revenue_estimate)",
  "revenue_actual = COALESCE(excluded.revenue_actual, earnings_events.revenue_actual)",
  "revenue_surprise = COALESCE(excluded.revenue_surprise, earnings_events.revenue_surprise)",
  "revenue_surprise_pct = COALESCE(excluded.revenue_surprise_pct, earnings_events.revenue_surprise_pct)",
  "revenue_result = CASE WHEN excluded.revenue_result = 'Not Available' THEN earnings_events.revenue_result ELSE excluded.revenue_result END",
  "overall_result = CASE WHEN excluded.overall_result = 'Not Available' THEN earnings_events.overall_result ELSE excluded.overall_result END",
  "reported_at = COALESCE(excluded.reported_at, earnings_events.reported_at)",
  // Official metric fields are owned by the one-shot backfill: a provider
  // upsert must never overwrite them (COALESCE keeps the existing value when
  // the provider row carries null). data_quality_status uses the same
  // "pending never downgrades an audited verdict" rule as mergedEvent.
  "reported_at_source = COALESCE(excluded.reported_at_source, earnings_events.reported_at_source)",
  "eps_actual_gaap = COALESCE(excluded.eps_actual_gaap, earnings_events.eps_actual_gaap)",
  "eps_actual_gaap_source = COALESCE(excluded.eps_actual_gaap_source, earnings_events.eps_actual_gaap_source)",
  "eps_actual_adjusted = COALESCE(excluded.eps_actual_adjusted, earnings_events.eps_actual_adjusted)",
  "eps_actual_adjusted_source = COALESCE(excluded.eps_actual_adjusted_source, earnings_events.eps_actual_adjusted_source)",
  "revenue_actual_official = COALESCE(excluded.revenue_actual_official, earnings_events.revenue_actual_official)",
  "revenue_actual_source = COALESCE(excluded.revenue_actual_source, earnings_events.revenue_actual_source)",
  "eps_estimate_source = COALESCE(excluded.eps_estimate_source, earnings_events.eps_estimate_source)",
  "revenue_estimate_source = COALESCE(excluded.revenue_estimate_source, earnings_events.revenue_estimate_source)",
  "data_quality_status = CASE WHEN excluded.data_quality_status = 'pending' OR excluded.data_quality_status IS NULL THEN earnings_events.data_quality_status ELSE excluded.data_quality_status END",
  "calendar_provider = COALESCE(excluded.calendar_provider, earnings_events.calendar_provider)",
  "consensus_provider = COALESCE(excluded.consensus_provider, earnings_events.consensus_provider)",
  "provider_event_id = COALESCE(excluded.provider_event_id, earnings_events.provider_event_id)",
  "provider_updated_at = CASE WHEN earnings_events.provider_updated_at IS NULL OR excluded.provider_updated_at > earnings_events.provider_updated_at THEN excluded.provider_updated_at ELSE earnings_events.provider_updated_at END",
  "official_report_url = COALESCE(excluded.official_report_url, earnings_events.official_report_url)",
  "investor_relations_url = COALESCE(excluded.investor_relations_url, earnings_events.investor_relations_url)",
  "sec_filing_url = COALESCE(excluded.sec_filing_url, earnings_events.sec_filing_url)",
  "sec_accession = COALESCE(excluded.sec_accession, earnings_events.sec_accession)",
  "sec_form = COALESCE(excluded.sec_form, earnings_events.sec_form)",
  "sec_filed_at = COALESCE(excluded.sec_filed_at, earnings_events.sec_filed_at)",
  "updated_at = CASE WHEN excluded.updated_at > earnings_events.updated_at THEN excluded.updated_at ELSE earnings_events.updated_at END",
  "last_checked_at = CASE WHEN earnings_events.last_checked_at IS NULL OR excluded.last_checked_at > earnings_events.last_checked_at THEN excluded.last_checked_at ELSE earnings_events.last_checked_at END",
].join(", ");

function eventUpsertStatement(db: Database, event: NormalizedEarningsEvent): D1PreparedStatement {
  return db.prepare(`INSERT INTO earnings_events (${EVENT_COLUMNS}) VALUES (${EVENT_PLACEHOLDERS}) ON CONFLICT(id) DO UPDATE SET ${EVENT_UPDATES}`)
    .bind(...params(event));
}

function rowFromEvent(event: NormalizedEarningsEvent): EarningsRow {
  const values = params(event);
  return Object.fromEntries(VALUES.map((column, index) => [column, values[index]]));
}

function findExistingInRows(rows: EarningsRow[], event: NormalizedEarningsEvent): EarningsRow | null {
  const byId = rows.find((row) => String(row.id) === event.id);
  if (byId) return byId;
  if (event.providerEventId) {
    const byProvider = rows.find((row) => String(row.provider_event_id ?? "") === event.providerEventId
      && (!event.calendarProvider || String(row.calendar_provider ?? "") === event.calendarProvider));
    if (byProvider) return byProvider;
  }
  const incomingPeriod = canonicalFiscalPeriod(event.fiscalQuarter, event.fiscalPeriod);
  if (event.fiscalYear !== null && incomingPeriod !== null) {
    const byPeriod = rows.find((row) => String(row.symbol) === event.symbol
      && integerOrNull(row.fiscal_year) === event.fiscalYear
      && canonicalFiscalPeriod(integerOrNull(row.fiscal_quarter), text(row.fiscal_period)) === incomingPeriod);
    if (byPeriod) return byPeriod;
  }
  if (event.scheduledDate) {
    const byDate = rows.find((row) => String(row.symbol) === event.symbol && row.scheduled_date === event.scheduledDate);
    const sameFiscalIdentity = event.fiscalYear === null || incomingPeriod === null
      || integerOrNull(byDate?.fiscal_year) === null
      || canonicalFiscalPeriod(integerOrNull(byDate?.fiscal_quarter), text(byDate?.fiscal_period)) === incomingPeriod;
    if (byDate && sameFiscalIdentity) return byDate;
  }
  if (!event.scheduledDate) return null;
  const target = Date.parse(`${event.scheduledDate}T00:00:00.000Z`);
  const nearby = rows
    .filter((row) => String(row.symbol) === event.symbol && String(row.status) !== "cancelled"
      && row.fiscal_year == null && row.fiscal_quarter == null && row.fiscal_period == null
      && typeof row.scheduled_date === "string")
    .map((row) => ({ row, distance: Math.abs(Date.parse(`${row.scheduled_date as string}T00:00:00.000Z`) - target) }))
    .filter(({ distance }) => Number.isFinite(distance) && distance <= 14 * 24 * 60 * 60 * 1000)
    .sort((left, right) => left.distance - right.distance);
  return nearby.length === 1 ? nearby[0]!.row : null;
}

/**
 * Bulk write path used by Cron. D1 batch keeps a full calendar sync below the
 * Workers Free subrequest budget; identity matching happens against one
 * snapshot in memory, then the resulting statements are committed in chunks.
 */
export async function upsertEarningsEvents(db: Database, incoming: NormalizedEarningsEvent[]): Promise<EarningsEngineEvent[]> {
  if (incoming.length === 0) return [];
  const snapshot = await db.prepare("SELECT * FROM earnings_events").all<EarningsRow>();
  const rows = [...snapshot.results];
  const renames: D1PreparedStatement[] = [];
  const writes: D1PreparedStatement[] = [];
  const events: EarningsEngineEvent[] = [];

  for (const candidate of incoming) {
    const existing = findExistingInRows(rows, candidate);
    let targetId = candidate.id;
    if (existing?.id && String(existing.id) !== candidate.id) {
      const stableIncoming = candidate.fiscalYear !== null
        && canonicalFiscalPeriod(candidate.fiscalQuarter, candidate.fiscalPeriod) !== null;
      if (stableIncoming && !rows.some((row) => String(row.id) === candidate.id)) {
        renames.push(db.prepare("UPDATE earnings_events SET id = ? WHERE id = ?").bind(candidate.id, String(existing.id)));
        existing.id = candidate.id;
      } else if (!stableIncoming) {
        targetId = String(existing.id);
      }
    }
    const event = mergedEvent(existing, candidate, targetId);
    const row = rowFromEvent(event);
    const oldIndex = existing ? rows.indexOf(existing) : -1;
    if (oldIndex >= 0) rows[oldIndex] = row;
    else rows.push(row);
    writes.push(eventUpsertStatement(db, event));
    events.push(event);
  }

  const statements = [...renames, ...writes];
  if (db.batch) {
    try {
      for (let index = 0; index < statements.length; index += 100) {
        await db.batch(statements.slice(index, index + 100));
      }
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      // A concurrent Cron can win an identity between the snapshot and batch.
      // The single-row path re-reads the committed winner before retrying.
      return Promise.all(incoming.map((event) => upsertEarningsEvent(db, event)));
    }
  } else {
    for (const statement of statements) await statement.run();
  }
  return events;
}

export async function upsertEarningsEvent(db: Database, incoming: NormalizedEarningsEvent): Promise<EarningsEngineEvent> {
  const existing = await findExisting(db, incoming);
  let targetId = incoming.id;
  if (existing?.id && String(existing.id) !== incoming.id) {
    const oldEvent = rowToEarningsEvent(existing);
    const stableIncoming = incoming.fiscalYear !== null && canonicalFiscalPeriod(incoming.fiscalQuarter, incoming.fiscalPeriod) !== null;
    if (stableIncoming) {
      const conflict = await db.prepare("SELECT id FROM earnings_events WHERE id = ? LIMIT 1").bind(incoming.id).first<{ id: string }>();
      if (!conflict) await db.prepare("UPDATE earnings_events SET id = ? WHERE id = ?").bind(incoming.id, String(existing.id)).run();
    } else {
      targetId = oldEvent.id;
    }
  }

  const event = mergedEvent(existing, incoming, targetId);
  const write = async (value: NormalizedEarningsEvent): Promise<void> => {
    await eventUpsertStatement(db, value).run();
  };
  try {
    await write(event);
    return event;
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    // Daily sync and the 15-minute monitor can overlap. If a different
    // invocation won a provider/fiscal unique index between findExisting and
    // INSERT, merge against that committed row and retry on its stable id.
    const winner = await findExisting(db, incoming);
    if (!winner?.id) throw error;
    const merged = mergedEvent(winner, incoming, String(winner.id));
    await write(merged);
    return merged;
  }
}

export async function markPastScheduledEventsUnknown(db: Database, today: string, updatedAt: string): Promise<void> {
  await db.prepare(
    "UPDATE earnings_events SET status = 'unknown', scheduled = 0, reported = 0, unknown = 1, updated_at = ?, last_checked_at = ? WHERE scheduled_date IS NOT NULL AND scheduled_date < ? AND status = 'scheduled'",
  ).bind(updatedAt, updatedAt, today).run();
}

export interface OfficialMetricsWrite {
  eventId: string;
  reportedAt: string | null;
  reportedAtSource: "sec-filing" | null;
  /** SEC filing metadata resolved from the XBRL fact (optional, COALESCE-wrapped). */
  secFilingUrl?: string | null;
  secAccession?: string | null;
  secForm?: string | null;
  secFiledAt?: string | null;
  epsActualGaap: number | null;
  epsActualGaapSource: "sec-xbrl" | null;
  epsActualAdjusted: number | null;
  epsActualAdjustedSource: "finnhub-adjusted" | null;
  revenueActualOfficial: number | null;
  revenueActualSource: "sec-xbrl" | null;
  epsEstimateSource: "finnhub-consensus" | null;
  revenueEstimateSource: "finnhub-consensus" | null;
  dataQualityStatus: EarningsEngineEvent["dataQualityStatus"];
  fiscalPeriodEnd: string | null;
  updatedAt: string;
}

/**
 * Official-metrics write path used by the one-shot VPS backfill
 * (scripts/earnings-official-last-quarter-backfill.ts).
 *
 * Write precedence (documented, never silently mixed):
 *   1. Official SEC GAAP actuals (sec-xbrl) win over any provider value.
 *   2. Finnhub adjusted actuals stay in their own column; they are never
 *      copied into GAAP fields.
 *   3. Consensus estimates remain consensus; provenance is stamped.
 *   4. Legacy eps_actual / revenue_actual are never touched here — they keep
 *      their provider semantics for backward compatibility.
 *
 * The UPDATE only sets the official fields; it never rewrites legacy columns
 * and never clears an existing official value with null. Idempotent: callers
 * re-run with the same resolved values and nothing changes.
 */
export async function applyOfficialMetrics(db: Database, write: OfficialMetricsWrite): Promise<boolean> {
  const existing = await db.prepare("SELECT * FROM earnings_events WHERE id = ? LIMIT 1").bind(write.eventId).first<EarningsRow>();
  if (!existing) return false;
  const previous = rowToEarningsEvent(existing);
  // Canonical values and their provenance are never cleared with null: a null
  // write means "keep the existing value" (COALESCE on the write side). The
  // change test therefore only fires when the write carries a non-null value
  // that differs, keeping re-runs truly idempotent.
  const valueChanged = (previousValue: number | null, writtenValue: number | null): boolean =>
    writtenValue !== null && previousValue !== writtenValue;
  const sourceChanged = (previousValue: string | null, writtenValue: string | null): boolean =>
    writtenValue !== null && previousValue !== writtenValue;
  // The adjusted mirror is FILL-ONLY: the provider owns it once set. Filling a
  // null adjusted keeps Surprise/Result (computed from the same market basis)
  // consistent with what the UI displays; overwriting it could pair a shown
  // Adjusted actual with a Result computed from a different value.
  const adjustedFillChanged = (previous: number | null, written: number | null): boolean =>
    written !== null && previous === null;
  const adjustedSourceFillChanged = (previous: string | null, written: string | null): boolean =>
    written !== null && previous === null;
  const changed =
    valueChanged(previous.epsActualGaap, write.epsActualGaap)
    || sourceChanged(previous.epsActualGaapSource, write.epsActualGaapSource)
    || adjustedFillChanged(previous.epsActualAdjusted, write.epsActualAdjusted)
    || adjustedSourceFillChanged(previous.epsActualAdjustedSource, write.epsActualAdjustedSource)
    || valueChanged(previous.revenueActualOfficial, write.revenueActualOfficial)
    || sourceChanged(previous.revenueActualSource, write.revenueActualSource)
    || sourceChanged(previous.epsEstimateSource, write.epsEstimateSource)
    || sourceChanged(previous.revenueEstimateSource, write.revenueEstimateSource)
    || (write.reportedAt !== null && previous.reportedAt !== write.reportedAt)
    || (write.reportedAtSource !== null && previous.reportedAtSource !== write.reportedAtSource)
    || (write.secFilingUrl !== undefined && write.secFilingUrl !== null && previous.secFilingUrl !== write.secFilingUrl)
    || (write.secAccession !== undefined && write.secAccession !== null && previous.secAccession !== write.secAccession)
    || (write.secForm !== undefined && write.secForm !== null && previous.secForm !== write.secForm)
    || (write.secFiledAt !== undefined && write.secFiledAt !== null && previous.secFiledAt !== write.secFiledAt)
    || previous.dataQualityStatus !== write.dataQualityStatus
    || (write.fiscalPeriodEnd !== null && previous.fiscalPeriodEnd !== write.fiscalPeriodEnd);
  if (!changed) return false;
  await db.prepare(
    `UPDATE earnings_events SET
       eps_actual_gaap = COALESCE(?, eps_actual_gaap),
       eps_actual_gaap_source = COALESCE(?, eps_actual_gaap_source),
       -- Adjusted mirror is fill-only: the provider owns it once set. Filling a
       -- null adjusted keeps Surprise/Result consistent with the displayed value;
       -- overwriting it could pair a shown Adjusted actual with a Result computed
       -- from a different basis.
       eps_actual_adjusted = COALESCE(earnings_events.eps_actual_adjusted, ?),
       eps_actual_adjusted_source = COALESCE(earnings_events.eps_actual_adjusted_source, ?),
       revenue_actual_official = COALESCE(?, revenue_actual_official),
       revenue_actual_source = COALESCE(?, revenue_actual_source),
       eps_estimate_source = COALESCE(?, eps_estimate_source),
       revenue_estimate_source = COALESCE(?, revenue_estimate_source),
       reported_at = COALESCE(?, reported_at),
       reported_at_source = COALESCE(?, reported_at_source),
       fiscal_period_end = COALESCE(?, fiscal_period_end),
       sec_filing_url = COALESCE(?, sec_filing_url),
       sec_accession = COALESCE(?, sec_accession),
       sec_form = COALESCE(?, sec_form),
       sec_filed_at = COALESCE(?, sec_filed_at),
       data_quality_status = ?,
       updated_at = ?
     WHERE id = ?`,
  ).bind(
    write.epsActualGaap, write.epsActualGaapSource,
    write.epsActualAdjusted, write.epsActualAdjustedSource,
    write.revenueActualOfficial, write.revenueActualSource,
    write.epsEstimateSource, write.revenueEstimateSource,
    write.reportedAt, write.reportedAtSource,
    write.fiscalPeriodEnd ?? null,
    write.secFilingUrl ?? null,
    write.secAccession ?? null,
    write.secForm ?? null,
    write.secFiledAt ?? null,
    write.dataQualityStatus,
    write.updatedAt,
    write.eventId,
  ).run();
  return true;
}

export async function markUnseenScheduledEventsUnknown(
  db: Database,
  from: string,
  to: string,
  syncTimestamp: string,
  updatedAt: string,
): Promise<void> {
  await db.prepare(
    `UPDATE earnings_events
     SET status = 'unknown', scheduled = 0, reported = 0, unknown = 1, updated_at = ?, last_checked_at = ?
     WHERE status = 'scheduled' AND scheduled_date >= ? AND scheduled_date <= ?
       AND (last_checked_at IS NULL OR last_checked_at < ?)`,
  ).bind(updatedAt, updatedAt, from, to, syncTimestamp).run();
}

export interface EarningsQuery {
  from: string;
  to: string;
  symbol?: string;
  status?: "scheduled" | "reported" | "cancelled" | "unknown";
}

/**
 * Active-Core symbols that already hold a reported event inside the window.
 * Targeted historical recovery skips these: a D1 reported row is authoritative
 * proof the provider's recent history was already ingested.
 */
export async function readRecentReportedSymbols(db: Database, from: string, to: string): Promise<ReadonlySet<string>> {
  const result = await db.prepare(
    `SELECT DISTINCT e.symbol
     FROM earnings_events AS e
     JOIN earnings_universe AS u ON u.symbol = e.symbol AND ${ACTIVE_UNIVERSE_PREDICATE}
     WHERE e.status = 'reported' AND e.scheduled_date IS NOT NULL AND e.scheduled_date >= ? AND e.scheduled_date <= ?`,
  ).bind(from, to).all<{ symbol: string }>();
  return new Set(result.results.map((row) => row.symbol));
}

const RECOVERY_CHECKED_KEY_PREFIX = "earningsRecoveryChecked:";

export const recoveryCheckedMetaKey = (symbol: string): string => `${RECOVERY_CHECKED_KEY_PREFIX}${symbol}`;

/**
 * Symbols already probed by targeted recovery since `cutoff` (ISO). A probe
 * that returned no history must not block later symbols forever: the stamp
 * keeps it out of the candidate set until it expires, then it is retried.
 */
export async function readRecentlyCheckedRecoverySymbols(db: Database, cutoff: string): Promise<ReadonlySet<string>> {
  const result = await db.prepare(
    `SELECT key, value FROM app_meta WHERE key LIKE '${RECOVERY_CHECKED_KEY_PREFIX}%'`,
  ).all<{ key: string; value: string }>();
  const checked = new Set<string>();
  for (const row of result.results) {
    if (row.value >= cutoff) checked.add(row.key.slice(RECOVERY_CHECKED_KEY_PREFIX.length));
  }
  return checked;
}

export async function readEarningsEvents(db: Database, query: EarningsQuery): Promise<EarningsEngineEvent[]> {
  const conditions = ["e.scheduled_date IS NOT NULL", "e.scheduled_date >= ?", "e.scheduled_date <= ?"];
  const values: unknown[] = [query.from, query.to];
  if (query.symbol) {
    conditions.push("e.symbol = ?");
    values.push(query.symbol);
  }
  if (query.status) {
    conditions.push("e.status = ?");
    values.push(query.status);
  }
  const result = await db.prepare(
    `SELECT e.*, u.logo_url AS logo_url, u.industry AS industry, u.website_url AS website_url
     FROM earnings_events AS e
     JOIN earnings_universe AS u ON u.symbol = e.symbol AND ${ACTIVE_UNIVERSE_PREDICATE}
     WHERE ${conditions.join(" AND ")}
     ORDER BY e.scheduled_date DESC, e.symbol ASC, e.id ASC LIMIT 5000`,
  ).bind(...values).all<EarningsRow>();
  return result.results.map(rowToEarningsEvent);
}

export async function readEarningsMonitoringEvents(db: Database, today: string): Promise<EarningsEngineEvent[]> {
  const result = await db.prepare(
    `SELECT e.*, u.logo_url AS logo_url, u.industry AS industry, u.website_url AS website_url
     FROM earnings_events AS e
     JOIN earnings_universe AS u ON u.symbol = e.symbol AND ${ACTIVE_UNIVERSE_PREDICATE}
     WHERE e.scheduled_date = ?
       AND (e.status = 'scheduled' OR (e.status = 'reported' AND (e.eps_actual IS NULL OR e.revenue_actual IS NULL OR e.sec_filing_url IS NULL)))
     ORDER BY e.symbol ASC, e.id ASC LIMIT 500`,
  ).bind(today).all<EarningsRow>();
  return result.results.map(rowToEarningsEvent);
}

export async function readEarningsEventById(db: Database, id: string): Promise<EarningsEngineEvent | null> {
  const row = await db.prepare(
    `SELECT e.*, u.logo_url AS logo_url, u.industry AS industry, u.website_url AS website_url
     FROM earnings_events AS e
     JOIN earnings_universe AS u ON u.symbol = e.symbol AND ${ACTIVE_UNIVERSE_PREDICATE}
     WHERE e.id = ? LIMIT 1`,
  ).bind(id).first<EarningsRow>();
  return row ? rowToEarningsEvent(row) : null;
}

export type UniverseSource = "core" | "trending";

export interface EarningsUniverseMember {
  symbol: string;
  company: string;
  cik: string | null;
  exchange: string | null;
  investorRelationsUrl?: string | null;
  indexes: string[];
  // Finnhub Company Profile 2 enrichment (stored, never binary — only URLs).
  logoUrl?: string | null;
  industry?: string | null;
  websiteUrl?: string | null;
  updatedAt: string;
  metadataProvider?: string;
  metadataUpdatedAt?: string | null;
}

export interface TrackedUniverseRow {
  symbol: string;
  active: boolean;
  source: UniverseSource;
  universeVersion: number;
  addedAt: string | null;
  removedAt: string | null;
  updatedAt: string;
}

function assertUniverseSymbols(symbols: readonly string[]): void {
  if (symbols.length === 0) throw new Error("Core Universe cannot be empty");
  const seen = new Set<string>();
  for (const symbol of symbols) {
    if (symbol !== symbol.trim() || !/^[A-Z][A-Z0-9-]{0,11}$/.test(symbol)) {
      throw new Error(`Invalid Core Universe symbol: ${JSON.stringify(symbol)}`);
    }
    if (seen.has(symbol)) throw new Error(`Duplicate Core Universe symbol: ${symbol}`);
    seen.add(symbol);
  }
}

function coreLifecycleStatement(db: Database, symbol: string, version: number, updatedAt: string): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO earnings_universe
      (symbol, company, cik, exchange, investor_relations_url, index_memberships, metadata_provider, active, source, universe_version, added_at, removed_at, updated_at)
     VALUES (?, ?, NULL, NULL, NULL, '[]', 'core-universe', 1, 'core', ?, ?, NULL, ?)
     ON CONFLICT(symbol) DO UPDATE SET
       active = 1,
       source = 'core',
       universe_version = excluded.universe_version,
       added_at = COALESCE(earnings_universe.added_at, excluded.added_at),
       removed_at = NULL,
       updated_at = excluded.updated_at`,
  ).bind(symbol, symbol, version, updatedAt, updatedAt);
}

/**
 * Reconcile the checked-in Core baseline into the existing D1 universe table.
 * The operation only changes membership lifecycle rows; earnings_events are
 * never deleted, including for symbols that become inactive.
 */
export async function reconcileCoreUniverse(
  db: Database,
  symbols: readonly string[],
  version: number,
  updatedAt: string,
): Promise<void> {
  if (!Number.isInteger(version) || version < 1) throw new Error("Core Universe version must be a positive integer");
  assertUniverseSymbols(symbols);
  const placeholders = symbols.map(() => "?").join(", ");
  const deactivate = db.prepare(
    `UPDATE earnings_universe
     SET active = 0,
         universe_version = ?,
         removed_at = COALESCE(removed_at, ?),
         updated_at = ?
     WHERE source = 'core'
       AND symbol NOT IN (${placeholders})
       AND (active = 1 OR removed_at IS NULL)`,
  ).bind(version, updatedAt, updatedAt, ...symbols);
  const statements = [deactivate, ...symbols.map((symbol) => coreLifecycleStatement(db, symbol, version, updatedAt))];
  if (db.batch) {
    for (let index = 0; index < statements.length; index += 100) {
      await db.batch(statements.slice(index, index + 100));
    }
    return;
  }
  for (const statement of statements) await statement.run();
}

function universeMetadataStatement(db: Database, member: EarningsUniverseMember): D1PreparedStatement {
  return db.prepare(
    `UPDATE earnings_universe
     SET company = ?,
         cik = COALESCE(?, cik),
         exchange = COALESCE(?, exchange),
         investor_relations_url = COALESCE(?, investor_relations_url),
         index_memberships = ?,
         logo_url = COALESCE(?, logo_url),
         industry = COALESCE(?, industry),
         website_url = COALESCE(?, website_url),
         metadata_provider = COALESCE(?, metadata_provider),
         metadata_updated_at = COALESCE(?, metadata_updated_at),
         updated_at = ?
     WHERE symbol = ? AND active = 1 AND source = 'core'`,
  ).bind(
    member.company,
    member.cik,
    member.exchange,
    member.investorRelationsUrl ?? null,
    JSON.stringify(member.indexes),
    member.logoUrl ?? null,
    member.industry ?? null,
    member.websiteUrl ?? null,
    // Only stamp provenance when the caller explicitly provided one.
    // Core/SEC reconciliation without a provider must preserve Finnhub.
    member.metadataProvider ?? null,
    member.metadataUpdatedAt ?? null,
    member.updatedAt,
    member.symbol,
  );
}

export async function upsertUniverseMembers(db: Database, members: EarningsUniverseMember[]): Promise<void> {
  if (members.length === 0) return;
  const statements = members.map((member) => universeMetadataStatement(db, member));
  if (db.batch) {
    for (let index = 0; index < statements.length; index += 100) {
      await db.batch(statements.slice(index, index + 100));
    }
    return;
  }
  for (const statement of statements) await statement.run();
}

export async function upsertUniverseMember(db: Database, member: EarningsUniverseMember): Promise<void> {
  await upsertUniverseMembers(db, [member]);
}

/** Persist a Finnhub profile attempt timestamp (success or failure) for cooldown. */
export async function stampUniverseMetadataAttempt(
  db: Database,
  symbol: string,
  attemptedAt: string,
): Promise<void> {
  await db.prepare(
    `UPDATE earnings_universe
     SET metadata_attempted_at = ?
     WHERE symbol = ? AND active = 1 AND source = 'core'`,
  ).bind(attemptedAt, symbol).run();
}

export async function readUniverseMetadata(db: Database): Promise<Map<string, { company: string; cik: string | null; investorRelationsUrl: string | null }>> {
  // Include inactive rows so a re-added symbol keeps its previously enriched
  // metadata. Public reads use readActiveUniverseSymbols/active joins instead.
  const result = await db.prepare(
    "SELECT symbol, company, cik, investor_relations_url FROM earnings_universe",
  ).all<{ symbol: string; company: string; cik: string | null; investor_relations_url: string | null }>();
  return new Map(result.results.map((row) => [row.symbol, { company: row.company, cik: row.cik, investorRelationsUrl: row.investor_relations_url }]));
}

export async function readActiveUniverseSymbols(db: Database): Promise<ReadonlySet<string>> {
  const result = await db.prepare(
    "SELECT symbol FROM earnings_universe WHERE active = 1 AND source = 'core' ORDER BY symbol",
  ).all<{ symbol: string }>();
  return new Set(result.results.map((row) => row.symbol));
}

export interface UniverseMetadataCandidate {
  symbol: string;
  company: string;
  hasLogo: boolean;
  hasIndustry: boolean;
  metadataUpdatedAt: string | null;
  metadataAttemptedAt: string | null;
}

/**
 * Active Core members whose Finnhub profile metadata is missing or stale AND
 * whose last profile attempt is outside the cooldown window.
 *
 * `staleBefore` / `cooldownBefore` are ISO timestamps. Ordering prefers never-
 * attempted symbols, then oldest attempts, then missing metadata, then symbol
 * — so alphabetically-early failures cannot starve later Core members under
 * the maintenance cap of 2/run.
 */
export async function readUniverseMetadataCandidates(
  db: Database,
  staleBefore: string,
  cooldownBefore: string,
  limit: number,
): Promise<UniverseMetadataCandidate[]> {
  const result = await db.prepare(
    `SELECT symbol, company, logo_url, industry, metadata_updated_at, metadata_attempted_at
     FROM earnings_universe
     WHERE active = 1 AND source = 'core'
       AND (logo_url IS NULL OR industry IS NULL OR metadata_updated_at IS NULL OR metadata_updated_at < ?)
       AND (metadata_attempted_at IS NULL OR metadata_attempted_at < ?)
     ORDER BY (metadata_attempted_at IS NULL) DESC,
              metadata_attempted_at ASC,
              (metadata_updated_at IS NULL) DESC,
              symbol ASC
     LIMIT ?`,
  ).bind(staleBefore, cooldownBefore, limit).all<{
    symbol: string;
    company: string;
    logo_url: string | null;
    industry: string | null;
    metadata_updated_at: string | null;
    metadata_attempted_at: string | null;
  }>();
  return result.results.map((row) => ({
    symbol: row.symbol,
    company: row.company,
    hasLogo: row.logo_url != null,
    hasIndustry: row.industry != null,
    metadataUpdatedAt: row.metadata_updated_at,
    metadataAttemptedAt: row.metadata_attempted_at,
  }));
}

export async function readTrackedUniverse(db: Database): Promise<TrackedUniverseRow[]> {
  const result = await db.prepare(
    "SELECT symbol, active, source, universe_version, added_at, removed_at, updated_at FROM earnings_universe ORDER BY symbol",
  ).all<{
    symbol: string;
    active: number;
    source: UniverseSource;
    universe_version: number;
    added_at: string | null;
    removed_at: string | null;
    updated_at: string;
  }>();
  return result.results.map((row) => ({
    symbol: row.symbol,
    active: Number(row.active) === 1,
    source: row.source,
    universeVersion: Number(row.universe_version),
    addedAt: row.added_at,
    removedAt: row.removed_at,
    updatedAt: row.updated_at,
  }));
}

export async function setEarningsMeta(db: Database, key: string, value: string): Promise<void> {
  await db.prepare("INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(key, value).run();
}

export async function readEarningsMeta(db: Database, key: string): Promise<string | null> {
  const row = await db.prepare("SELECT value FROM app_meta WHERE key = ? LIMIT 1").bind(key).first<{ value: string | null }>();
  return row?.value ?? null;
}

export async function clearEarningsMeta(db: Database, key: string): Promise<void> {
  await db.prepare("DELETE FROM app_meta WHERE key = ?").bind(key).run();
}
