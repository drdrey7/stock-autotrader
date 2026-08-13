import type { EarningsEngineEvent } from "@stock-autotrader/contracts";
import { calculateMetric, calculateOverallResult, canonicalFiscalPeriod } from "./logic";
import type { NormalizedEarningsEvent } from "./types";

type Database = Pick<D1Database, "prepare"> & Partial<Pick<D1Database, "batch">>;

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
  const preservedReported = reportedAlready
    ? {
        status: old.status,
        scheduled: old.scheduled,
        reported: old.reported,
        cancelled: old.cancelled,
        unknown: old.unknown,
        reportedAt: old.reportedAt,
      }
    : {};
  const epsEstimate = providerOlder ? old.epsEstimate : incoming.epsEstimate ?? old.epsEstimate;
  const epsActual = providerOlder ? old.epsActual : incoming.epsActual ?? old.epsActual;
  const revenueEstimate = providerOlder ? old.revenueEstimate : incoming.revenueEstimate ?? old.revenueEstimate;
  const revenueActual = providerOlder ? old.revenueActual : incoming.revenueActual ?? old.revenueActual;
  const eps = calculateMetric(epsActual, epsEstimate);
  const revenue = calculateMetric(revenueActual, revenueEstimate);
  return {
    ...old,
    ...incoming,
    ...providerValues,
    ...preservedReported,
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
  "revenue_surprise", "revenue_surprise_pct", "revenue_result", "overall_result", "reported_at", "calendar_provider",
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
    event.overallResult, event.reportedAt, event.calendarProvider, event.consensusProvider, event.providerEventId,
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

export async function readEarningsEvents(db: Database, query: EarningsQuery): Promise<EarningsEngineEvent[]> {
  const conditions = ["scheduled_date IS NOT NULL", "scheduled_date >= ?", "scheduled_date <= ?"];
  const values: unknown[] = [query.from, query.to];
  if (query.symbol) {
    conditions.push("symbol = ?");
    values.push(query.symbol);
  }
  if (query.status) {
    conditions.push("status = ?");
    values.push(query.status);
  }
  const result = await db.prepare(
    `SELECT * FROM earnings_events WHERE ${conditions.join(" AND ")} ORDER BY scheduled_date DESC, symbol ASC, id ASC LIMIT 5000`,
  ).bind(...values).all<EarningsRow>();
  return result.results.map(rowToEarningsEvent);
}

export async function readEarningsMonitoringEvents(db: Database, today: string): Promise<EarningsEngineEvent[]> {
  const result = await db.prepare(
    `SELECT * FROM earnings_events
     WHERE scheduled_date = ?
       AND (status = 'scheduled' OR (status = 'reported' AND (eps_actual IS NULL OR revenue_actual IS NULL OR sec_filing_url IS NULL)))
     ORDER BY symbol ASC, id ASC LIMIT 500`,
  ).bind(today).all<EarningsRow>();
  return result.results.map(rowToEarningsEvent);
}

export async function readEarningsEventById(db: Database, id: string): Promise<EarningsEngineEvent | null> {
  const row = await db.prepare("SELECT * FROM earnings_events WHERE id = ? LIMIT 1").bind(id).first<EarningsRow>();
  return row ? rowToEarningsEvent(row) : null;
}

export interface EarningsUniverseMember {
  symbol: string;
  company: string;
  cik: string | null;
  exchange: string | null;
  investorRelationsUrl?: string | null;
  indexes: string[];
  updatedAt: string;
}

function universeStatement(db: Database, member: EarningsUniverseMember): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO earnings_universe (symbol, company, cik, exchange, investor_relations_url, index_memberships, metadata_provider, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(symbol) DO UPDATE SET company = excluded.company, cik = COALESCE(excluded.cik, earnings_universe.cik), exchange = COALESCE(excluded.exchange, earnings_universe.exchange), investor_relations_url = COALESCE(excluded.investor_relations_url, earnings_universe.investor_relations_url), index_memberships = excluded.index_memberships, metadata_provider = excluded.metadata_provider, updated_at = excluded.updated_at`,
  ).bind(member.symbol, member.company, member.cik, member.exchange, member.investorRelationsUrl ?? null, JSON.stringify(member.indexes), "sec-edgar", member.updatedAt);
}

export async function upsertUniverseMembers(db: Database, members: EarningsUniverseMember[]): Promise<void> {
  const statements = members.map((member) => universeStatement(db, member));
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

export async function readUniverseMetadata(db: Database): Promise<Map<string, { company: string; cik: string | null; investorRelationsUrl: string | null }>> {
  const result = await db.prepare("SELECT symbol, company, cik, investor_relations_url FROM earnings_universe").all<{ symbol: string; company: string; cik: string | null; investor_relations_url: string | null }>();
  return new Map(result.results.map((row) => [row.symbol, { company: row.company, cik: row.cik, investorRelationsUrl: row.investor_relations_url }]));
}

export async function setEarningsMeta(db: Database, key: string, value: string): Promise<void> {
  await db.prepare("INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(key, value).run();
}
