/**
 * Official-metric audit/decision engine shared by the one-shot VPS backfill and
 * its test suite.
 *
 * The pipeline NEVER hard-codes tickers and NEVER guesses: every decision is
 * derived from the D1 event + SEC XBRL resolution + explicit tolerances. A
 * canonical official value is only produced when the SEC resolver returned a
 * validated fact; anything else stays null with a diagnostic reason.
 */

import type {
  EarningsDataQualityStatus,
  EarningsStatus,
} from "@stock-autotrader/contracts";
import type {
  OfficialMetricSelection,
  ResolvedOfficialMetrics,
} from "./sec-xbrl";
import type { OfficialMetricsWrite } from "./storage-core";

export const SOURCE_SEC_XBRL = "sec-xbrl";
export const SOURCE_SEC_FILING = "sec-filing";
export const SOURCE_FINNHUB_CONSENSUS = "finnhub-consensus";
export const SOURCE_FINNHUB_ADJUSTED = "finnhub-adjusted";

/** EPS match tolerance in USD per share (adjusted vs GAAP rounding noise). */
export const EPS_MATCH_TOLERANCE = 0.02;
/** Revenue match tolerance as a relative fraction (1%). */
export const REVENUE_MATCH_TOLERANCE_REL = 0.01;
/**
 * Definitional consistency band for official GAAP revenue vs the provider
 * revenue line. GAAP vs provider revenue never legitimately differ by more
 * than a small amount (both are "total revenue"); a ratio outside this band
 * means the XBRL concept is a DIFFERENT revenue definition (e.g. SoFi's
 * RevenueFromContractWithCustomerExcludingAssessedTax ≈ 1/8 of its total net
 * revenue). Such a value is NOT canonical quarterly revenue — it stays null
 * with a diagnostic. Uniform rule, never a ticker-specific fix.
 */
export const REVENUE_DEFINITION_MIN_RATIO = 0.4;
export const REVENUE_DEFINITION_MAX_RATIO = 2.5;

export function revenueDefinitionalOutOfBand(provider: number | null, official: number | null): boolean {
  if (provider === null || provider === undefined || official === null || official === undefined) return false;
  const ratio = official / provider;
  return ratio > REVENUE_DEFINITION_MAX_RATIO || ratio < REVENUE_DEFINITION_MIN_RATIO;
}

export interface AuditInput {
  symbol: string;
  company: string | null;
  cik: string | null;
  eventId: string;
  scheduledDate: string | null;
  fiscalYear: number | null;
  fiscalQuarter: number | null;
  fiscalPeriodEnd: string | null;
  status: EarningsStatus;
  /** Legacy provider (Finnhub calendar) actuals — adjusted/non-GAAP basis. */
  providerEpsActual: number | null;
  providerRevenueActual: number | null;
  epsEstimate: number | null;
  revenueEstimate: number | null;
  /** SEC XBRL resolution; null when companyfacts could not be fetched/parsed. */
  official: ResolvedOfficialMetrics | null;
  /** SEC filing metadata already resolved by the worker (submissions path). */
  filing: {
    url: string | null;
    accession: string | null;
    form: string | null;
    filedAt: string | null;
  } | null;
}

export interface MetricComparison {
  provider: number | null;
  official: number | null;
  diff: number | null;
  /** Relative diff vs official (null when official is 0). */
  diffPct: number | null;
  /** True when both values exist and differ beyond the tolerance. */
  basisMismatch: boolean;
  comparable: boolean;
}

export interface AuditRow {
  symbol: string;
  company: string | null;
  cik: string | null;
  eventId: string;
  eventDate: string | null;
  fiscalQuarter: number | null;
  fiscalYear: number | null;
  finnhub: {
    epsEstimate: number | null;
    epsActual: number | null;
    revenueEstimate: number | null;
    revenueActual: number | null;
  };
  sec: {
    matchedFiling: string | null;
    form: string | null;
    accession: string | null;
    filedAt: string | null;
    gaapDilutedEps: number | null;
    gaapEpsConfidence: OfficialMetricSelection["confidence"] | null;
    gaapQuarterlyRevenue: number | null;
    gaapRevenueConfidence: OfficialMetricSelection["confidence"] | null;
    periodEnd: string | null;
    epsBlockers: string[];
    revenueBlockers: string[];
  };
  comparison: {
    eps: MetricComparison;
    revenue: MetricComparison;
    metricBasisMismatch: boolean;
  };
  confidence: "high" | "medium" | "low";
  decision: EarningsDataQualityStatus;
  reasons: string[];
  /** What --apply would write; null when nothing should be written. */
  write: OfficialMetricsWrite | null;
}

function compareMetric(
  provider: number | null,
  official: number | null,
  tolerance: number,
  relative: boolean,
): MetricComparison {
  if (provider === null || official === null) {
    return {
      provider,
      official,
      diff: null,
      diffPct: null,
      basisMismatch: false,
      comparable: provider !== null && official !== null,
    };
  }
  const diff = provider - official;
  const diffPct = official === 0 ? null : diff / Math.abs(official);
  const epsilon = relative ? Math.abs(official) * tolerance : tolerance;
  const mismatch = Math.abs(diff) > epsilon;
  return { provider, official, diff, diffPct, basisMismatch: mismatch, comparable: true };
}

const confidenceRank: Record<OfficialMetricSelection["confidence"], number> = { high: 2, medium: 1, low: 0 };

export function minConfidence(...values: (OfficialMetricSelection["confidence"] | null)[]): "high" | "medium" | "low" {
  const ranks = values
    .filter((value): value is OfficialMetricSelection["confidence"] => value !== null)
    .map((value) => confidenceRank[value]);
  if (ranks.length === 0) return "low";
  const minimum = Math.min(...ranks);
  return minimum === 2 ? "high" : minimum === 1 ? "medium" : "low";
}

const statusText = (status: EarningsStatus): string => status;

/**
 * Decide the audit verdict for one latest-reported-quarter event.
 *
 * Decisions (vocabulary matches the D1 data_quality_status column):
 *   match          provider actual ≈ official GAAP actual (within tolerance)
 *   different-basis provider actual exists and official GAAP exists but they
 *                  differ beyond tolerance (adjusted vs GAAP — expected and
 *                  surfaced, never collapsed)
 *   conflict       provider and SEC disagree on fiscal identity/context
 *   official-only  only the SEC GAAP value is known
 *   finnhub-only   only the provider value is known (SEC unresolved)
 *   unresolved     neither side confidently resolved
 *   pending        event is not reported yet (e.g. NVDA upcoming) — no writes
 */
export function buildAuditRow(input: AuditInput, updatedAt: string): AuditRow {
  const reasons: string[] = [];
  const epsValue = input.official?.eps.value ?? null;
  const epsConfidence = input.official?.eps.confidence ?? null;
  const revenueValue = input.official?.revenue.value ?? null;
  const revenueConfidence = input.official?.revenue.confidence ?? null;
  const periodEnd = input.official?.periodEnd ?? null;

  const eps = compareMetric(input.providerEpsActual, epsValue, EPS_MATCH_TOLERANCE, false);
  const revenue = compareMetric(input.providerRevenueActual, revenueValue, REVENUE_MATCH_TOLERANCE_REL, true);
  const confidence = minConfidence(epsConfidence, revenueConfidence);
  const metricBasisMismatch = eps.basisMismatch || revenue.basisMismatch;
  // Official revenue whose concept does not match the provider's total revenue
  // line is surfaced but never stamped as canonical (see
  // revenueDefinitionalOutOfBand). This mirrors the real SoFi case where the
  // XBRL "revenue from contracts with customers" is a small slice of total net
  // revenue — writing it as "official revenue" would be misleading.
  const revenueDefinitionMismatch = revenueDefinitionalOutOfBand(input.providerRevenueActual, revenueValue);

  // Filing metadata shown in the audit (worker-resolved when available).
  const filing = input.official
    ? {
        matchedFiling: input.filing?.url ?? null,
        form: input.official.eps.form ?? input.filing?.form ?? null,
        accession: input.official.eps.accn ?? input.filing?.accession ?? null,
        // Prefer the explicit worker-resolved SEC acceptance timestamp; fall
        // back to the filing date carried by the resolved XBRL fact.
        filedAt: input.filing?.filedAt ?? (input.official.eps.filed ? `${input.official.eps.filed}T00:00:00.000Z` : null),
      }
    : { matchedFiling: input.filing?.url ?? null, form: input.filing?.form ?? null, accession: input.filing?.accession ?? null, filedAt: input.filing?.filedAt ?? null };

  let decision: EarningsDataQualityStatus;
  if (input.status !== "reported") {
    if (input.status === "scheduled") {
      decision = "pending";
      reasons.push("event is upcoming; no actuals may be written (no fake actuals)");
    } else {
      decision = "unresolved";
      reasons.push(`event status is ${statusText(input.status)}; no actuals audited`);
    }
  } else if (input.official === null) {
    decision = input.providerEpsActual !== null || input.providerRevenueActual !== null ? "finnhub-only" : "unresolved";
    reasons.push("SEC companyfacts unavailable; only provider values known");
  } else if (epsValue === null && revenueValue === null) {
    decision = input.providerEpsActual !== null || input.providerRevenueActual !== null ? "finnhub-only" : "unresolved";
    reasons.push(...input.official.eps.blockers, ...input.official.revenue.blockers);
  } else if ((input.providerEpsActual === null && input.providerRevenueActual === null)
    || (eps.comparable === false && revenue.comparable === false && (epsValue !== null || revenueValue !== null))) {
    decision = "official-only";
    reasons.push("no provider actual; official SEC GAAP value resolved");
  } else if (metricBasisMismatch) {
    decision = "different-basis";
    if (eps.basisMismatch && eps.comparable) {
      reasons.push(`EPS differs: provider ${formatNumber(eps.provider)} vs GAAP ${formatNumber(eps.official)} (diff ${formatNumber(eps.diff)})`);
    }
    if (revenue.basisMismatch && revenue.comparable && !revenueDefinitionMismatch) {
      reasons.push(`Revenue differs: provider ${formatRevenue(revenue.provider)} vs GAAP ${formatRevenue(revenue.official)}`);
    }
    if (revenueDefinitionMismatch) {
      reasons.push(`official revenue concept does not match provider total revenue (${formatRevenue(revenue.official)} vs ${formatRevenue(revenue.provider)}); canonical official revenue left null`);
    }
  } else if (eps.comparable || revenue.comparable) {
    decision = "match";
    reasons.push("provider actual matches official GAAP within tolerance");
  } else {
    decision = "unresolved";
    reasons.push("incomplete comparison; cannot decide");
  }

  // Conflict detection: SEC resolver found facts only for a DIFFERENT fiscal
  // identity than the event claims (blocker mentions the fiscal mismatch).
  const fiscalConflict = (input.official && (epsValue === null || revenueValue === null))
    && [...input.official.eps.blockers, ...input.official.revenue.blockers]
      .some((blocker) => /fiscal identity|non-quarterly|conflicting/.test(blocker));
  if (input.status === "reported" && fiscalConflict) {
    decision = "conflict";
    reasons.push("SEC facts disagree with the provider fiscal identity/context");
  }

  // Build the write payload. GAAP values are written ONLY when the resolver
  // returned a validated fact (never low-confidence, never guessed) AND — for
  // revenue — the concept matches the provider's total revenue line. A
  // `conflict` verdict means provider and SEC disagree on fiscal identity or
  // context, so NO GAAP actual is written (conflicts are surfaced, never
  // paired with a canonical value). The provider adjusted actual is mirrored
  // explicitly so the adjusted column is not silently empty for legacy events.
  const conflictDecision = decision === "conflict";
  const gaapEpsWritable = epsValue !== null && epsConfidence !== null && epsConfidence !== "low"
    && !conflictDecision;
  const gaapRevenueWritable = revenueValue !== null && revenueConfidence !== null && revenueConfidence !== "low"
    && !revenueDefinitionMismatch && !conflictDecision;
  const hasWritable = gaapEpsWritable || gaapRevenueWritable
    || input.providerEpsActual !== null || input.providerRevenueActual !== null
    || decision === "different-basis" || decision === "conflict";

  let write: OfficialMetricsWrite | null = null;
  if (input.status === "reported" && hasWritable) {
    // SEC acceptance timestamp is authoritative whenever a filing is resolved.
    const reportedTimestamp = filing.filedAt;
    write = {
      eventId: input.eventId,
      reportedAt: reportedTimestamp,
      reportedAtSource: reportedTimestamp ? "sec-filing" : null,
      epsActualGaap: gaapEpsWritable ? epsValue : null,
      epsActualGaapSource: gaapEpsWritable ? SOURCE_SEC_XBRL : null,
      epsActualAdjusted: input.providerEpsActual,
      epsActualAdjustedSource: input.providerEpsActual !== null ? SOURCE_FINNHUB_ADJUSTED : null,
      revenueActualOfficial: gaapRevenueWritable ? revenueValue : null,
      revenueActualSource: gaapRevenueWritable ? SOURCE_SEC_XBRL : null,
      epsEstimateSource: input.epsEstimate !== null ? SOURCE_FINNHUB_CONSENSUS : null,
      revenueEstimateSource: input.revenueEstimate !== null ? SOURCE_FINNHUB_CONSENSUS : null,
      dataQualityStatus: decision,
      fiscalPeriodEnd: input.fiscalPeriodEnd ?? periodEnd,
      updatedAt,
    };
  }

  return {
    symbol: input.symbol,
    company: input.company,
    cik: input.cik,
    eventId: input.eventId,
    eventDate: input.scheduledDate,
    fiscalQuarter: input.fiscalQuarter,
    fiscalYear: input.fiscalYear,
    finnhub: {
      epsEstimate: input.epsEstimate,
      epsActual: input.providerEpsActual,
      revenueEstimate: input.revenueEstimate,
      revenueActual: input.providerRevenueActual,
    },
    sec: {
      matchedFiling: filing.matchedFiling,
      form: filing.form,
      accession: filing.accession,
      filedAt: filing.filedAt,
      gaapDilutedEps: epsValue,
      gaapEpsConfidence: epsConfidence,
      gaapQuarterlyRevenue: revenueValue,
      gaapRevenueConfidence: revenueConfidence,
      periodEnd,
      epsBlockers: input.official?.eps.blockers ?? ["companyfacts unavailable"],
      revenueBlockers: input.official?.revenue.blockers ?? ["companyfacts unavailable"],
    },
    comparison: { eps, revenue, metricBasisMismatch },
    confidence,
    decision,
    reasons,
    write,
  };
}

function formatNumber(value: number | null): string {
  return value === null ? "n/a" : value.toFixed(4);
}

function formatRevenue(value: number | null): string {
  if (value === null) return "n/a";
  const billions = value / 1_000_000_000;
  return billions >= 1 ? `${billions.toFixed(2)}B` : `${(value / 1_000_000).toFixed(1)}M`;
}