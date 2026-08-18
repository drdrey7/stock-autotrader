import type {
  EarningsDataQualityStatus,
  EarningsEngineEvent,
  EarningsMetricSource,
  EarningsOverallResult,
} from "@stock-autotrader/contracts";
export { formatShareValue, formatCompactMoney, formatPercent } from "../../lib/format";

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
    // https-only: an http: link rendered on this HTTPS page would be a
    // mixed-content downgrade. Upstream sources (SEC, Finnhub) are
    // https-only in practice, so this never rejects real data.
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function todayKey(now = Date.now()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(now));
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
    reportedAtSource: stringValue(input.reportedAtSource) as EarningsEngineEvent["reportedAtSource"],
    epsActualGaap: finiteNumber(input.epsActualGaap),
    epsActualGaapSource: stringValue(input.epsActualGaapSource) as EarningsEngineEvent["epsActualGaapSource"],
    epsActualAdjusted: finiteNumber(input.epsActualAdjusted),
    epsActualAdjustedSource: stringValue(input.epsActualAdjustedSource) as EarningsEngineEvent["epsActualAdjustedSource"],
    revenueActualOfficial: finiteNumber(input.revenueActualOfficial),
    revenueActualSource: stringValue(input.revenueActualSource) as EarningsEngineEvent["revenueActualSource"],
    epsEstimateSource: stringValue(input.epsEstimateSource) as EarningsEngineEvent["epsEstimateSource"],
    revenueEstimateSource: stringValue(input.revenueEstimateSource) as EarningsEngineEvent["revenueEstimateSource"],
    dataQualityStatus: stringValue(input.dataQualityStatus) as EarningsEngineEvent["dataQualityStatus"],
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
    logoUrl: stringValue(input.logoUrl),
    industry: stringValue(input.industry),
    websiteUrl: stringValue(input.websiteUrl),
  };
  return { ...event, color: tickerColour(event.symbol), result: displayResult(event) };
}

export function resultClass(value: string): string {
  if (value === "Beat") return "beat";
  if (value === "Miss") return "miss";
  if (value === "Mixed" || value === "In Line" || value === "Met") return "mixed";
  return "pending";
}

/** BMO/AMC/TBD → human-readable trading-session label for the detail drawer. */
export function displayTiming(timing: EarningsCompany["timing"]): string {
  if (timing === "BMO") return "Before Open";
  if (timing === "AMC") return "After Close";
  return "TBD";
}

/** "Q3 2026" from engine fiscal fields; "N/A" when nothing is known. */
export function fiscalPeriodLabel(
  fiscalYear: number | null,
  fiscalQuarter: number | null,
  fiscalPeriod: string | null,
): string {
  const period = fiscalPeriod?.trim() || (fiscalQuarter !== null ? `Q${fiscalQuarter}` : null);
  if (!period && fiscalYear === null) return "N/A";
  return [period, fiscalYear].filter((value) => value !== null && value !== "").join(" ") || "N/A";
}

/**
 * MARKET view — every number here is Finnhub/market-consensus only. The actuals
 * prefer the explicit adjusted (non-GAAP) column and fall back to the legacy
 * provider actual; the SEC GAAP values are NEVER folded in. Surprise and
 * Result are recomputed here from the exact pair that is displayed, so the
 * drawer can never show an Actual that contradicts its own Surprise/Result
 * (mirrors the worker's calculateMetric rule).
 */
export interface MarketEarningsView {
  epsEstimate: number | null;
  epsActual: number | null;
  epsSurprisePct: number | null;
  epsResult: string;
  revenueEstimate: number | null;
  revenueActual: number | null;
  revenueSurprisePct: number | null;
  revenueResult: string;
  overallResult: string;
  /** A market comparison is possible for EPS or revenue (both estimate + actual present). */
  comparable: boolean;
}

export interface MarketMetricView {
  actual: number | null;
  estimate: number | null;
  surprisePct: number | null;
  result: string;
}

/**
 * Canonical market Beat/Miss computation: surprise and result are derived from
 * the SAME actual/estimate pair that the UI displays. When either value is
 * missing the result is N/A — a market result is NEVER derived from SEC GAAP
 * actuals. Formula matches the worker's calculateMetric:
 *   surprisePct = (actual - estimate) / |estimate| * 100
 *   result      = actual > estimate ? Beat : actual < estimate ? Miss : Met
 */
export function calculateMarketMetric(actual: number | null, estimate: number | null): MarketMetricView {
  if (
    actual === null || estimate === null
    || !Number.isFinite(actual) || !Number.isFinite(estimate)
  ) {
    return { actual, estimate, surprisePct: null, result: "Not Available" };
  }
  const surprisePct = estimate === 0 ? null : ((actual - estimate) / Math.abs(estimate)) * 100;
  const result = actual === estimate ? "In Line" : actual > estimate ? "Beat" : "Miss";
  return {
    actual,
    estimate,
    surprisePct: surprisePct !== null && Number.isFinite(surprisePct) ? surprisePct : null,
    result,
  };
}

type MarketEventFields = Pick<EarningsEngineEvent,
  | "epsEstimate" | "epsActual" | "epsActualAdjusted"
  | "revenueEstimate" | "revenueActual">;

export function marketEarningsView(event: MarketEventFields): MarketEarningsView {
  const epsActual = event.epsActualAdjusted ?? event.epsActual;
  const revenueActual = event.revenueActual;
  const eps = calculateMarketMetric(epsActual, event.epsEstimate);
  const revenue = calculateMarketMetric(revenueActual, event.revenueEstimate);
  const overallResult = eps.result === "Not Available" || revenue.result === "Not Available"
    ? "Not Available"
    : eps.result === revenue.result
      ? eps.result
      : "Mixed";
  return {
    epsEstimate: eps.estimate,
    epsActual: eps.actual,
    epsSurprisePct: eps.surprisePct,
    epsResult: eps.result,
    revenueEstimate: revenue.estimate,
    revenueActual: revenue.actual,
    revenueSurprisePct: revenue.surprisePct,
    revenueResult: revenue.result,
    overallResult,
    comparable: (event.epsEstimate !== null && epsActual !== null)
      || (event.revenueEstimate !== null && revenueActual !== null),
  };
}

/**
 * OFFICIAL view — SEC/EDGAR GAAP accounting figures and filing metadata only.
 * These are informational reference data and must never feed a market
 * Beat/Miss computation (see marketEarningsView above).
 */
export interface OfficialEarningsView {
  epsGaap: number | null;
  revenueGaap: number | null;
  secAccession: string | null;
  secForm: string | null;
  secFiledAt: string | null;
  secFilingUrl: string | null;
  /** True when any SEC field was resolved (so the UI can render a real section). */
  hasAny: boolean;
}

type OfficialEventFields = Pick<EarningsEngineEvent,
  | "epsActualGaap" | "revenueActualOfficial"
  | "secAccession" | "secForm" | "secFiledAt" | "secFilingUrl">;

export function officialEarningsView(event: OfficialEventFields): OfficialEarningsView {
  return {
    epsGaap: event.epsActualGaap,
    revenueGaap: event.revenueActualOfficial,
    secAccession: event.secAccession,
    secForm: event.secForm,
    secFiledAt: event.secFiledAt,
    secFilingUrl: event.secFilingUrl,
    hasAny: event.epsActualGaap !== null
      || event.revenueActualOfficial !== null
      || event.secFilingUrl !== null
      || event.secForm !== null
      || event.secFiledAt !== null,
  };
}

/**
 * The actual earnings-release timestamp, but ONLY when independently known.
 * A reportedAt whose provenance is `sec-filing` is the SEC filing acceptance
 * time — not the release time — and is deliberately treated as unknown here so
 * the UI never presents it as "Reported at" (earnings release).
 */
export function releaseTimestamp(
  event: Pick<EarningsEngineEvent, "reportedAt" | "reportedAtSource">,
): string | null {
  if (!event.reportedAt || event.reportedAtSource === "sec-filing") return null;
  return event.reportedAt;
}

/** Raw `data_quality_status` verdicts mapped to user-friendly copy (never raw internal strings). */
const DATA_QUALITY_LABELS: Record<string, string> = {
  "match": "Market and official results are consistent",
  "different-basis": "GAAP and adjusted results differ",
  "conflict": "Provider and SEC data could not be aligned",
  "official-only": "Only official SEC data is available",
  "finnhub-only": "Only market data is available",
  "unresolved": "Data quality could not be fully resolved",
};

export function dataQualityLabel(status: EarningsDataQualityStatus | null): string | null {
  if (!status) return null;
  return DATA_QUALITY_LABELS[status] ?? null;
}

/** Provider provenance strings → friendly source labels (never ugly raw tokens). */
const SOURCE_LABELS: Record<string, string> = {
  "sec-xbrl": "SEC / Official",
  "sec-filing": "SEC / Filing",
  "finnhub-consensus": "Finnhub / Market",
  "finnhub-adjusted": "Finnhub / Market",
};

export function sourceLabel(source: EarningsMetricSource | null): string {
  if (!source) return "N/A";
  return SOURCE_LABELS[source] ?? source;
}

/**
 * Date-only rendering of a SEC acceptance/filing ISO timestamp. Time is
 * deliberately dropped: filing datetimes are acceptance-system values whose
 * timezone component adds noise, and the label is "SEC filed", not a release
 * instant. Rendering in UTC keeps the calendar date identical everywhere.
 */
export function formatFilingDate(iso: string | null): string | null {
  if (!iso || !Number.isFinite(new Date(iso).getTime())) return null;
  return new Intl.DateTimeFormat("en", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(iso));
}
