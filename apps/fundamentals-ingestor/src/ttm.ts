/** True trailing-twelve-month aggregation for normalized SEC periods. */

import { CONCEPT_MAPPINGS, type CanonicalField } from "./concepts";
import { resolveAccumulatedFact, type AccumulatedPeriod } from "./sec-client";
import {
  buildTtmFromQuarters,
  buildTtmFromYtdFallback,
  type FiscalPeriod,
  type PeriodResolution,
} from "./periods";
import type { CompanyFacts } from "./sec-client";
import type { NormalizedPeriod } from "./normalize";

export const TTM_DURATION_FIELDS = [
  "revenue",
  "gross_profit",
  "operating_income",
  "pretax_income",
  "income_tax",
  "net_income",
  "diluted_eps",
  "operating_cash_flow",
  "capex",
  "depreciation_amortization",
] as const satisfies readonly CanonicalField[];

export type TtmDurationField = (typeof TTM_DURATION_FIELDS)[number];

export interface TtmAggregation {
  readonly values: Partial<Record<TtmDurationField, number | null>>;
  readonly derivations: Partial<Record<TtmDurationField, string | null>>;
  readonly blockers: string[];
}

interface AccumulatedSource {
  readonly value: number;
  readonly period: FiscalPeriod;
}

function periodFromNormalized(period: NormalizedPeriod): FiscalPeriod {
  const fiscalPeriod = period.fiscalPeriod as FiscalPeriod["fiscalPeriod"];
  return {
    fiscalYear: period.fiscalYear,
    fiscalPeriod,
    periodStart: period.periodStart,
    periodEnd: period.periodEnd,
    form: period.form,
    accession: period.accession,
    filed: period.filingDate,
  };
}

function quarterOf(period: string): number | null {
  return /^Q[1-4]$/.test(period) ? Number(period.slice(1)) : null;
}

function accumulatedPeriodForQuarter(quarter: number): AccumulatedPeriod {
  if (quarter === 1) return "Q1";
  if (quarter === 2) return "H1";
  return "9M";
}

function resolveAccumulatedField(
  facts: CompanyFacts,
  field: TtmDurationField,
  fiscalYear: number,
  period: AccumulatedPeriod,
  periodEnd: string | null,
): AccumulatedSource | null {
  const mappings = CONCEPT_MAPPINGS[field].filter((mapping) => mapping.duration === "duration");
  const taxonomyOrder = ["us-gaap", "ifrs-full", "dei"];
  for (const taxonomy of taxonomyOrder) {
    for (const mapping of mappings.filter((candidate) => candidate.taxonomy === taxonomy)) {
      const match = resolveAccumulatedFact(facts, mapping, fiscalYear, period, periodEnd);
      if (match.value === null) continue;
      const sourcePeriod = period;
      return {
        value: match.value,
        period: {
          fiscalYear,
          fiscalPeriod: sourcePeriod,
          periodStart: match.periodStart,
          periodEnd: match.periodEnd,
          form: match.form,
          accession: match.accn,
          filed: match.filed,
        },
      };
    }
  }
  return null;
}

function fallbackTtm(
  facts: CompanyFacts,
  periods: readonly NormalizedPeriod[],
  field: TtmDurationField,
): PeriodResolution {
  const latest = periods[0];
  if (!latest) {
    return { value: null, derived: true, derivation: null, blockers: ["no normalized periods"] };
  }
  const quarter = quarterOf(latest.fiscalPeriod);
  if (quarter === null || latest.fiscalYear <= 0) {
    return { value: null, derived: true, derivation: null, blockers: ["latest period has no quarter identity"] };
  }

  if (quarter === 4) {
    const annual = resolveAccumulatedField(facts, field, latest.fiscalYear, "FY", latest.periodEnd);
    return annual
      ? { value: annual.value, derived: true, derivation: "FY", blockers: [] }
      : { value: null, derived: true, derivation: null, blockers: ["latest FY value unavailable"] };
  }

  const ytdPeriod = accumulatedPeriodForQuarter(quarter);
  const currentYtd = resolveAccumulatedField(facts, field, latest.fiscalYear, ytdPeriod, latest.periodEnd);
  const priorPeriod = periods.find((period) => period.fiscalYear === latest.fiscalYear - 1
    && period.fiscalPeriod === `Q${quarter}`);
  const priorFyPeriod = periods.find((period) => period.fiscalYear === latest.fiscalYear - 1
    && period.fiscalPeriod === "Q4");
  const priorYtd = resolveAccumulatedField(
    facts,
    field,
    latest.fiscalYear - 1,
    ytdPeriod,
    priorPeriod?.periodEnd ?? null,
  );
  const latestFy = resolveAccumulatedField(
    facts,
    field,
    latest.fiscalYear - 1,
    "FY",
    priorFyPeriod?.periodEnd ?? null,
  );
  const result = buildTtmFromYtdFallback(
    latestFy?.value ?? null,
    currentYtd?.value ?? null,
    currentYtd?.period ?? null,
    priorYtd?.value ?? null,
    priorYtd?.period ?? null,
  );
  return result;
}

/**
 * Aggregate each duration field from the newest four consecutive quarters,
 * with an explicit FY + current YTD - prior YTD fallback. A single newest
 * quarter is never written into a *_ttm column.
 */
export function aggregateTtm(
  facts: CompanyFacts,
  periods: readonly NormalizedPeriod[],
): TtmAggregation {
  const values: Partial<Record<TtmDurationField, number | null>> = {};
  const derivations: Partial<Record<TtmDurationField, string | null>> = {};
  const blockers: string[] = [];

  for (const field of TTM_DURATION_FIELDS) {
    const resolvedFields = periods
      .map((period) => period.fields[field])
      .filter((candidate): candidate is NonNullable<typeof candidate> => candidate != null && candidate.value !== null);
    const units = new Set(resolvedFields.map((candidate) => candidate.unit));
    const taxonomies = new Set(resolvedFields.map((candidate) => candidate.taxonomy));
    if (units.size > 1 || taxonomies.size > 1 || units.has(null) || taxonomies.has(null)) {
      values[field] = null;
      derivations[field] = null;
      blockers.push(`TTM ${field}: source unit/taxonomy changes across quarters`);
      continue;
    }
    const quarters = periods.map((period) => ({
      value: period.fields[field]?.value ?? null,
      period: periodFromNormalized(period),
    }));
    const fourQuarter = buildTtmFromQuarters(quarters);
    const resolution = fourQuarter.value === null ? fallbackTtm(facts, periods, field) : fourQuarter;
    values[field] = resolution.value;
    derivations[field] = resolution.derivation;
    if (resolution.value === null) {
      blockers.push(`TTM ${field}: ${resolution.blockers.join(", ")}`);
    }
  }

  return { values, derivations, blockers };
}
