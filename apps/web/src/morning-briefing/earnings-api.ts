import type { EarningsApiResponse, EarningsEngineEvent } from "@stock-autotrader/contracts";
import { dateFromKey, dateKeyFromDate } from "./shared";
import { eventWithViewMetadata, type EarningsCompany } from "./data/earnings-view";
import { mondayBasedWeekday } from "../lib/calendar";

/** Inclusive past window for "Past Earnings — Last 30 days" (today + 29 prior days). */
export const EARNINGS_CLIENT_PAST_DAYS = 30;
/** Forward window for summary NEXT 30 DAYS (inclusive of today). */
export const EARNINGS_CLIENT_SUMMARY_FORWARD_DAYS = 30;

export type EarningsDateRange = { from: string; to: string };
export type CalendarPeriod = { year: number; month: number };

export function marketTodayKey(now = Date.now()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(now));
}

/**
 * Pure calendar-day arithmetic on an America/New_York market date key.
 * dateFromKey builds noon local components for Y-M-D so DST midnight edges
 * cannot shift the day; dateKeyFromDate reads those same components back.
 */
export function shiftMarketDateKey(key: string, deltaDays: number): string {
  const date = dateFromKey(key);
  date.setDate(date.getDate() + deltaDays);
  return dateKeyFromDate(date);
}

export function monthCacheKey(period: CalendarPeriod): string {
  return `${period.year}-${String(period.month + 1).padStart(2, "0")}`;
}

/** First and last calendar day of the selected month (handles Feb/leap years). */
export function monthDateRange(period: CalendarPeriod): EarningsDateRange {
  const month = period.month + 1;
  const from = `${period.year}-${String(month).padStart(2, "0")}-01`;
  const lastDay = new Date(period.year, period.month + 1, 0).getDate();
  const to = `${period.year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
  return { from, to };
}

/** Rolling Past Earnings window ending on market today (crosses Dec→Jan). */
export function pastEarningsRange(today = marketTodayKey()): EarningsDateRange {
  return {
    from: shiftMarketDateKey(today, -(EARNINGS_CLIENT_PAST_DAYS - 1)),
    to: today,
  };
}

/**
 * Current-window range for TODAY / THIS WEEK / NEXT 30 DAYS.
 * Monday-start week through marketToday+30 — independent of calendar month.
 */
export function summaryEarningsRange(today = marketTodayKey()): EarningsDateRange {
  const { weekStart } = mondayWeekBounds(today);
  return {
    from: weekStart,
    to: shiftMarketDateKey(today, EARNINGS_CLIENT_SUMMARY_FORWARD_DAYS),
  };
}

/** Monday-start / Sunday-end bounds for the week containing market today. */
export function mondayWeekBounds(today = marketTodayKey()): { weekStart: string; weekEnd: string } {
  const todayDate = dateFromKey(today);
  const weekStartDate = new Date(todayDate);
  weekStartDate.setDate(todayDate.getDate() - mondayBasedWeekday(todayDate));
  const weekEndDate = new Date(weekStartDate);
  weekEndDate.setDate(weekStartDate.getDate() + 6);
  return {
    weekStart: dateKeyFromDate(weekStartDate),
    weekEnd: dateKeyFromDate(weekEndDate),
  };
}

export function earningsApiPath(range: EarningsDateRange): string {
  return `/api/earnings?from=${range.from}&to=${range.to}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDateKey(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day!));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month! - 1 && date.getUTCDate() === day;
}

const EARNINGS_STRING_FIELDS = [
  "id", "symbol", "company", "cik", "date", "scheduledDate", "scheduledTime",
  "fiscalPeriod", "fiscalPeriodEnd", "reportedAt", "reportedAtSource",
  "epsActualGaapSource", "epsActualAdjustedSource", "revenueActualSource",
  "epsEstimateSource", "revenueEstimateSource", "dataQualityStatus",
  "calendarProvider", "consensusProvider",
  "providerEventId", "providerUpdatedAt", "officialReportUrl", "investorRelationsUrl",
  "secFilingUrl", "secAccession", "secForm", "secFiledAt", "createdAt", "updatedAt", "lastCheckedAt",
  "logoUrl", "industry", "websiteUrl",
] as const;

const EARNINGS_NUMBER_FIELDS = [
  "fiscalYear", "fiscalQuarter", "epsEstimate", "epsActual", "epsSurprise", "epsSurprisePct",
  "revenueEstimate", "revenueActual", "revenueSurprise", "revenueSurprisePct",
  "epsActualGaap", "epsActualAdjusted", "revenueActualOfficial",
] as const;

const EARNINGS_BOOLEAN_FIELDS = ["scheduled", "reported", "cancelled", "unknown"] as const;

function invalidEarningsEventField(event: Record<string, unknown>): string | null {
  if (typeof event.symbol !== "string" || event.symbol.trim().length === 0) return "symbol";
  for (const field of EARNINGS_STRING_FIELDS) {
    if (field in event && event[field] !== null && typeof event[field] !== "string") return field;
  }
  for (const field of EARNINGS_NUMBER_FIELDS) {
    if (field in event && event[field] !== null && (typeof event[field] !== "number" || !Number.isFinite(event[field]))) return field;
  }
  for (const field of EARNINGS_BOOLEAN_FIELDS) {
    if (field in event && event[field] !== null && typeof event[field] !== "boolean") return field;
  }
  if (event.date !== undefined && event.date !== null && !isDateKey(event.date)) return "date";
  if (event.scheduledDate !== undefined && event.scheduledDate !== null && !isDateKey(event.scheduledDate)) return "scheduledDate";
  if (event.status !== undefined && event.status !== null && !["scheduled", "reported", "cancelled", "unknown"].includes(String(event.status))) return "status";
  if (event.timing !== undefined && event.timing !== null && !["BMO", "AMC", "TBD"].includes(String(event.timing))) return "timing";
  if (event.epsResult !== undefined && event.epsResult !== null && !["Beat", "In Line", "Miss", "Not Available"].includes(String(event.epsResult))) return "epsResult";
  if (event.revenueResult !== undefined && event.revenueResult !== null && !["Beat", "In Line", "Miss", "Not Available"].includes(String(event.revenueResult))) return "revenueResult";
  if (event.overallResult !== undefined && event.overallResult !== null && !["Beat", "In Line", "Miss", "Mixed", "Not Available"].includes(String(event.overallResult))) return "overallResult";
  return null;
}

/**
 * Parse /api/earnings payload. Empty event lists are valid (available=true).
 * Malformed payloads return null (available=false).
 */
export function earningsFromApi(payload: unknown): EarningsCompany[] | null {
  const events = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload.events)
      ? payload.events
      : null;

  if (!events) return null;
  if (events.length === 0) return [];

  const valid: EarningsCompany[] = [];
  for (const event of events) {
    if (!isRecord(event)) {
      console.warn("earnings: rejected non-object event", event);
      continue;
    }
    const invalidField = invalidEarningsEventField(event);
    if (invalidField !== null) {
      console.warn("earnings: rejected malformed event", { symbol: event.symbol, field: invalidField, event });
      continue;
    }
    try {
      valid.push(eventWithViewMetadata(event as Partial<EarningsEngineEvent>));
    } catch (error) {
      console.warn("earnings: rejected event that failed to map", { symbol: event.symbol, error });
    }
  }

  // All rows rejected → treat as unavailable rather than a silent empty month.
  return valid.length > 0 || events.length === 0 ? valid : null;
}

export function readApiSummary(payload: unknown): { today: number; thisWeek: number; next30Days: number } | null {
  if (!isRecord(payload) || !isRecord(payload.summary)) return null;
  const today = payload.summary.today;
  const thisWeek = payload.summary.thisWeek;
  const next30Days = payload.summary.next30Days;
  if (![today, thisWeek, next30Days].every((value) => typeof value === "number" && Number.isFinite(value))) {
    return null;
  }
  return {
    today: today as number,
    thisWeek: thisWeek as number,
    next30Days: next30Days as number,
  };
}

export type { EarningsApiResponse, EarningsCompany };
