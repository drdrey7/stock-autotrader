import type { EarningsMetricResult, EarningsOverallResult, EarningsStatus } from "@stock-autotrader/contracts";
import type { EarningsCalendarObservation, EarningsConsensusObservation, EarningsDateRange, NormalizedEarningsEvent, OfficialFiling } from "./types";
import { normalizeSymbol } from "./universe";

// Kept as exported compatibility names for consumers of the PR12 contract.
// Finnhub values are classified deterministically: only exact equality is
// considered in line/Met; there is no percentage tolerance.
export const EPS_RESULT_TOLERANCE = 0;
export const REVENUE_RESULT_TOLERANCE = 0;
const DAY_MS = 24 * 60 * 60 * 1000;

const isFiniteNumber = (value: number | null | undefined): value is number =>
  value !== null && value !== undefined && Number.isFinite(value);

export function validDateKey(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

export function addDays(dateKey: string, days: number): string {
  if (!validDateKey(dateKey)) throw new Error(`invalid date key: ${dateKey}`);
  return new Date(Date.parse(`${dateKey}T12:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

export function newYorkDate(instant: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const value = (type: string) => parts.find((part) => part.type === type)?.value;
  const date = `${value("year")}-${value("month")}-${value("day")}`;
  if (!validDateKey(date)) throw new Error("unable to resolve New York date");
  return date;
}

export function rollingEarningsRange(today: string, days = 60): EarningsDateRange {
  if (!validDateKey(today) || !Number.isInteger(days) || days < 0) throw new Error("invalid earnings window");
  return { from: today, to: addDays(today, days) };
}

export function currentYearStart(today: string): string {
  if (!validDateKey(today)) throw new Error("invalid current year date");
  return `${today.slice(0, 4)}-01-01`;
}

export function startOfWeek(dateKey: string): string {
  if (!validDateKey(dateKey)) throw new Error("invalid week date");
  const date = new Date(`${dateKey}T12:00:00.000Z`);
  const day = date.getUTCDay();
  return addDays(dateKey, day === 0 ? 0 : 1 - day);
}

export function endOfWeek(dateKey: string): string {
  return addDays(startOfWeek(dateKey), 6);
}

export function calculateMetric(
  actual: number | null,
  estimate: number | null,
  _tolerance = EPS_RESULT_TOLERANCE,
): { surprise: number | null; surprisePct: number | null; result: EarningsMetricResult } {
  // Preserve the compatibility parameter while making the exact comparison
  // rule explicit for new Finnhub observations.
  void _tolerance;
  if (!isFiniteNumber(actual) || !isFiniteNumber(estimate)) {
    return { surprise: null, surprisePct: null, result: "Not Available" };
  }
  const surprise = actual - estimate;
  const surprisePct = estimate === 0 ? null : (surprise / Math.abs(estimate)) * 100;
  const result = surprise === 0 ? "In Line" : surprise > 0 ? "Beat" : "Miss";
  return {
    surprise,
    surprisePct: surprisePct !== null && Number.isFinite(surprisePct) ? surprisePct : null,
    result,
  };
}

export function calculateOverallResult(
  epsResult: EarningsMetricResult,
  revenueResult: EarningsMetricResult,
): EarningsOverallResult {
  if (epsResult === "Not Available" || revenueResult === "Not Available") return "Not Available";
  if (epsResult === revenueResult) return epsResult;
  return "Mixed";
}

export function classifyStatus(
  scheduledDate: string | null,
  today: string,
  hasActual: boolean,
  hasOfficialFiling: boolean,
  cancelled = false,
): EarningsStatus {
  if (cancelled) return "cancelled";
  if (hasActual || hasOfficialFiling) return "reported";
  if (!scheduledDate) return "unknown";
  if (scheduledDate >= today) return "scheduled";
  return "unknown";
}

export function canonicalFiscalPeriod(fiscalQuarter: number | null, fiscalPeriod: string | null): string | null {
  const normalized = fiscalPeriod?.trim().toUpperCase().replace(/\s+/g, " ") ?? null;
  if (fiscalQuarter !== null) return `Q${fiscalQuarter}`;
  if (normalized && /^Q[1-4]$/.test(normalized)) return normalized;
  return normalized;
}

export function buildEventId(
  symbol: string,
  fiscalYear: number | null,
  fiscalQuarter: number | null,
  scheduledDate: string | null,
  fiscalPeriod: string | null = null,
): string {
  const canonical = normalizeSymbol(symbol);
  const period = canonicalFiscalPeriod(fiscalQuarter, fiscalPeriod);
  if (fiscalYear !== null && period !== null) return `${canonical}-${fiscalYear}-${period}`;
  return `${canonical}-${scheduledDate ?? "unknown"}`;
}

export function mergeCalendarAndConsensus(
  calendar: EarningsCalendarObservation,
  consensus: EarningsConsensusObservation | null,
): EarningsCalendarObservation {
  if (!consensus) return calendar;
  return {
    ...calendar,
    fiscalYear: calendar.fiscalYear ?? consensus.fiscalYear,
    fiscalQuarter: calendar.fiscalQuarter ?? consensus.fiscalQuarter,
    fiscalPeriodEnd: calendar.fiscalPeriodEnd ?? consensus.fiscalPeriodEnd,
    epsEstimate: calendar.epsEstimate ?? consensus.epsEstimate,
    revenueEstimate: calendar.revenueEstimate ?? consensus.revenueEstimate,
    epsActual: calendar.epsActual ?? consensus.epsActual,
    revenueActual: calendar.revenueActual ?? consensus.revenueActual,
    providerEventId: calendar.providerEventId ?? consensus.providerEventId,
    providerUpdatedAt: calendar.providerUpdatedAt ?? consensus.providerUpdatedAt,
    cancelled: calendar.cancelled ?? consensus.cancelled,
  };
}

export function normalizeEvent(
  observation: EarningsCalendarObservation,
  today: string,
  collectedAt: string,
  metadata: { company?: string | null; cik?: string | null; investorRelationsUrl?: string | null } = {},
  official: OfficialFiling | null = null,
): NormalizedEarningsEvent {
  const symbol = normalizeSymbol(observation.symbol);
  const eps = calculateMetric(observation.epsActual, observation.epsEstimate, EPS_RESULT_TOLERANCE);
  const revenue = calculateMetric(observation.revenueActual, observation.revenueEstimate, REVENUE_RESULT_TOLERANCE);
  const hasActual = isFiniteNumber(observation.epsActual) || isFiniteNumber(observation.revenueActual);
  const effectiveOfficial = official ?? observation.officialFiling ?? null;
  const status = classifyStatus(observation.scheduledDate, today, hasActual, effectiveOfficial !== null, observation.cancelled === true);
  const reported = status === "reported";
  const fiscalPeriod = canonicalFiscalPeriod(observation.fiscalQuarter, observation.fiscalPeriod);
  const company = metadata.company?.trim() || observation.company?.trim() || symbol;
  return {
    id: buildEventId(symbol, observation.fiscalYear, observation.fiscalQuarter, observation.scheduledDate, fiscalPeriod),
    symbol,
    company,
    cik: metadata.cik ?? null,
    fiscalYear: observation.fiscalYear,
    fiscalQuarter: observation.fiscalQuarter,
    fiscalPeriod,
    fiscalPeriodEnd: observation.fiscalPeriodEnd,
    scheduledDate: observation.scheduledDate,
    scheduledTime: observation.scheduledTime,
    timing: observation.timing,
    status,
    scheduled: status === "scheduled",
    reported,
    cancelled: status === "cancelled",
    unknown: status === "unknown",
    epsEstimate: observation.epsEstimate,
    epsActual: observation.epsActual,
    epsSurprise: eps.surprise,
    epsSurprisePct: eps.surprisePct,
    epsResult: eps.result,
    revenueEstimate: observation.revenueEstimate,
    revenueActual: observation.revenueActual,
    revenueSurprise: revenue.surprise,
    revenueSurprisePct: revenue.surprisePct,
    revenueResult: revenue.result,
    overallResult: calculateOverallResult(eps.result, revenue.result),
    // A provider collection time is not a report timestamp. Only an SEC
    // acceptance timestamp is authoritative for reportedAt.
    reportedAt: effectiveOfficial?.filedAt ?? null,
    // The engine attaches the concrete adapter names after normalization.
    // Keeping this neutral prevents direct normalization from claiming FMP
    // provenance when production is Finnhub + SEC.
    calendarProvider: null,
    consensusProvider: null,
    providerEventId: observation.providerEventId,
    providerUpdatedAt: observation.providerUpdatedAt ?? collectedAt,
    officialReportUrl: observation.officialReportUrl ?? effectiveOfficial?.url ?? null,
    investorRelationsUrl: metadata.investorRelationsUrl ?? null,
    secFilingUrl: effectiveOfficial?.url ?? null,
    secAccession: effectiveOfficial?.accession ?? null,
    secForm: effectiveOfficial?.form ?? null,
    secFiledAt: effectiveOfficial?.filedAt ?? null,
    createdAt: collectedAt,
    updatedAt: collectedAt,
    lastCheckedAt: collectedAt,
  };
}

export function shouldPollEarnings(timing: "BMO" | "AMC" | "TBD", instant: Date): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? NaN);
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? NaN);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return false;
  const minutes = hour * 60 + minute;
  if (timing === "BMO") return minutes >= 7 * 60 && minutes <= 11 * 60 + 30;
  if (timing === "AMC") return minutes >= 15 * 60 + 30 && minutes <= 21 * 60;
  return minutes >= 7 * 60 && minutes <= 21 * 60;
}

export function isWithinInclusive(date: string | null, from: string, to: string): boolean {
  return date !== null && validDateKey(date) && date >= from && date <= to;
}
