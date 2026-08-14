import type {
  EarningsEngineEvent,
  EarningsOverallResult,
} from "@stock-autotrader/contracts";

export type EarningsDisplayResult = "Beat" | "Met" | "Miss" | "Mixed" | "Upcoming" | "N/A";
export type EarningsCompany = EarningsEngineEvent & {
  color: string;
  result: EarningsDisplayResult;
};

type EarningsInput = Partial<EarningsEngineEvent> & {
  date?: string;
};

const COLORS = ["#176b47", "#4385f5", "#a8730b", "#7c3aed", "#1675d1", "#dc3f48", "#0f766e"];

export function tickerColour(ticker: string): string {
  let hash = 0;
  for (const character of ticker) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return COLORS[hash % COLORS.length] ?? COLORS[0]!;
}

export function displayResult(event: Pick<EarningsEngineEvent, "status" | "overallResult">): EarningsDisplayResult {
  if (event.overallResult === "Beat" || event.overallResult === "Miss" || event.overallResult === "Mixed") return event.overallResult;
  if (event.overallResult === "In Line") return "Met";
  return event.status === "scheduled" ? "Upcoming" : "N/A";
}

export function displayMetricResult(value: string): string {
  if (value === "In Line") return "Met";
  if (value === "Not Available") return "N/A";
  return value;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
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

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function todayKey(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function normalizedStatus(value: unknown, scheduledDate: string | null): EarningsEngineEvent["status"] {
  if (value === "scheduled" || value === "reported" || value === "cancelled" || value === "unknown") return value;
  return scheduledDate && scheduledDate >= todayKey() ? "scheduled" : "unknown";
}

function normalizedTiming(value: unknown): EarningsEngineEvent["timing"] {
  return value === "BMO" || value === "AMC" ? value : "TBD";
}

function normalizedMetricResult(value: unknown): EarningsEngineEvent["epsResult"] {
  return value === "Beat" || value === "In Line" || value === "Miss" ? value : "Not Available";
}

function normalizedOverallResult(value: unknown): EarningsOverallResult {
  return value === "Beat" || value === "In Line" || value === "Miss" || value === "Mixed" ? value : "Not Available";
}

/**
 * The API contract is the only production source. The partial input handling
 * keeps older consumers/tests from crashing while they roll onto that
 * contract; missing financial fields remain null and render as N/A.
 */
export function eventWithViewMetadata(input: EarningsInput): EarningsCompany {
  const symbol = stringValue(input.symbol) ?? "";
  const scheduledDate = stringValue(input.scheduledDate) ?? stringValue(input.date);
  const status = normalizedStatus(input.status, scheduledDate);
  const event: EarningsEngineEvent = {
    id: stringValue(input.id) ?? `${symbol}-${scheduledDate ?? "unknown"}`,
    symbol,
    company: (stringValue(input.company) ?? symbol) || "N/A",
    cik: stringValue(input.cik),
    fiscalYear: typeof input.fiscalYear === "number" ? input.fiscalYear : null,
    fiscalQuarter: typeof input.fiscalQuarter === "number" ? input.fiscalQuarter : null,
    fiscalPeriod: stringValue(input.fiscalPeriod),
    fiscalPeriodEnd: stringValue(input.fiscalPeriodEnd),
    scheduledDate,
    scheduledTime: stringValue(input.scheduledTime),
    timing: normalizedTiming(input.timing),
    status,
    scheduled: input.scheduled ?? status === "scheduled",
    reported: input.reported ?? status === "reported",
    cancelled: input.cancelled ?? status === "cancelled",
    unknown: input.unknown ?? status === "unknown",
    epsEstimate: finiteNumber(input.epsEstimate),
    epsActual: finiteNumber(input.epsActual),
    epsSurprise: finiteNumber(input.epsSurprise),
    epsSurprisePct: finiteNumber(input.epsSurprisePct),
    epsResult: normalizedMetricResult(input.epsResult),
    revenueEstimate: finiteNumber(input.revenueEstimate),
    revenueActual: finiteNumber(input.revenueActual),
    revenueSurprise: finiteNumber(input.revenueSurprise),
    revenueSurprisePct: finiteNumber(input.revenueSurprisePct),
    revenueResult: normalizedMetricResult(input.revenueResult),
    overallResult: normalizedOverallResult(input.overallResult),
    reportedAt: stringValue(input.reportedAt),
    calendarProvider: stringValue(input.calendarProvider),
    consensusProvider: stringValue(input.consensusProvider),
    providerEventId: stringValue(input.providerEventId),
    providerUpdatedAt: stringValue(input.providerUpdatedAt),
    officialReportUrl: httpUrlValue(input.officialReportUrl),
    investorRelationsUrl: httpUrlValue(input.investorRelationsUrl),
    secFilingUrl: httpUrlValue(input.secFilingUrl),
    secAccession: stringValue(input.secAccession),
    secForm: stringValue(input.secForm),
    secFiledAt: stringValue(input.secFiledAt),
    createdAt: stringValue(input.createdAt) ?? "1970-01-01T00:00:00.000Z",
    updatedAt: stringValue(input.updatedAt) ?? "1970-01-01T00:00:00.000Z",
    lastCheckedAt: stringValue(input.lastCheckedAt),
  };
  return { ...event, color: tickerColour(event.symbol), result: displayResult(event) };
}

export function formatMetric(value: number | null, prefix = ""): string {
  if (value === null || !Number.isFinite(value)) return "N/A";
  return `${prefix}${value.toLocaleString("en-US", { maximumFractionDigits: 4 })}`;
}

export function formatPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "N/A";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

export function resultClass(value: string): string {
  if (value === "Beat") return "beat";
  if (value === "Miss") return "miss";
  if (value === "Mixed" || value === "In Line" || value === "Met") return "mixed";
  return "pending";
}
