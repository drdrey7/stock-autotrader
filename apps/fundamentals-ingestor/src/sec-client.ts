/**
 * Generalised SEC fact selector — extends the existing selectOfficialMetric
 * to handle both duration AND instant facts.
 *
 * The existing selectOfficialMetric in sec-xbrl.ts is designed for duration
 * facts (revenue, EPS) and rejects instant facts (balance sheet). This module
 * adds a selector for instant facts and a unified resolveFact function that
 * picks the right selector based on the concept's duration type.
 */

import {
  fetchCompanyFacts,
  fetchTickerCikMap,
  parseCompanyFacts,
  selectOfficialMetric,
  secFilingUrl,
  SEC_DEFAULT_USER_AGENT,
  type CompanyFacts,
  type FiscalIdentity,
  type OfficialMetricSelection,
  type XbrlFactInstance,
} from "../../web/worker/earnings/sec-xbrl";
import type { ConceptMapping, Taxonomy } from "./concepts";

export interface SecFactMatch {
  readonly value: number | null;
  readonly concept: string | null;
  readonly unit: string | null;
  readonly accn: string | null;
  readonly form: string | null;
  readonly filed: string | null;
  readonly periodEnd: string | null;
  readonly periodStart: string | null;
  readonly fiscalYear: number | null;
  readonly fiscalPeriod: string | null;
  readonly taxonomy: Taxonomy | null;
  readonly blockers: string[];
}

/**
 * Select an instant fact (balance sheet item) for a given concept+unit.
 * No duration check — instant facts are point-in-time.
 *
 * Reuses the same validation logic as selectOfficialMetric but without
 * the quarterly duration window requirement.
 */
export function selectInstantFact(
  facts: CompanyFacts,
  mapping: ConceptMapping,
  identity: FiscalIdentity,
): SecFactMatch {
  if (identity.fiscalYear === null) {
    return {
      value: null, concept: null, unit: null, accn: null, form: null, filed: null,
      periodEnd: null, periodStart: null, fiscalYear: null, fiscalPeriod: null,
      taxonomy: mapping.taxonomy, blockers: ["event lacks a fiscal year identity"],
    };
  }

  const candidates = facts.facts.filter((fact) => fact.concept === mapping.concept);
  if (candidates.length === 0) {
    return nullMatch(mapping, [`no ${mapping.concept} facts in companyfacts`]);
  }

  // 1. unit
  const pool = candidates.filter((fact) => fact.unit === mapping.unit);
  if (pool.length === 0) {
    return nullMatch(mapping, [`no ${mapping.concept} facts with unit ${mapping.unit}`]);
  }

  // 2. fiscal identity — match by fiscal year (instant facts don't have quarters in the same way)
  // For instant facts, match by fiscal year and prefer the most recent period-end
  const withFiscal = pool.filter((fact) => fact.fy === identity.fiscalYear);
  if (withFiscal.length === 0) {
    // Try previous fiscal year as fallback
    const withPrevFiscal = pool.filter((fact) => fact.fy === identity.fiscalYear! - 1);
    if (withPrevFiscal.length === 0) {
      return nullMatch(mapping, [
        `no ${mapping.concept} facts matching fiscal year ${identity.fiscalYear} (facts span ${describeFiscalRange(pool)})`,
      ]);
    }
    // Use the most recent fact from prior fiscal year
    const sorted = [...withPrevFiscal].sort((a, b) => (b.end ?? "").localeCompare(a.end ?? ""));
    const winner = sorted[0]!;
    return {
      value: winner.val, concept: winner.concept, unit: winner.unit,
      accn: winner.accn, form: winner.form, filed: winner.filed,
      periodEnd: winner.end, periodStart: winner.start,
      fiscalYear: winner.fy, fiscalPeriod: winner.fp,
      taxonomy: mapping.taxonomy, blockers: [`resolved from prior fiscal year ${winner.fy}`],
    };
  }

  // 3. For instant facts, pick the one with the latest period-end date (most recent balance)
  const sorted = [...withFiscal].sort((a, b) => (b.end ?? "").localeCompare(a.end ?? ""));
  const winner = sorted[0]!;

  return {
    value: winner.val, concept: winner.concept, unit: winner.unit,
    accn: winner.accn, form: winner.form, filed: winner.filed,
    periodEnd: winner.end, periodStart: winner.start,
    fiscalYear: winner.fy, fiscalPeriod: winner.fp,
    taxonomy: mapping.taxonomy, blockers: [],
  };
}

function nullMatch(mapping: ConceptMapping, blockers: string[]): SecFactMatch {
  return {
    value: null, concept: null, unit: null, accn: null, form: null, filed: null,
    periodEnd: null, periodStart: null, fiscalYear: null, fiscalPeriod: null,
    taxonomy: mapping.taxonomy, blockers,
  };
}

function describeFiscalRange(pool: XbrlFactInstance[]): string {
  const tags = [...new Set(pool.map((fact) => `${fact.fy ?? "?"}:${fact.fp ?? "?"}`))].slice(0, 6);
  return tags.join(", ") || "unknown";
}

/**
 * Resolve a fact using the appropriate selector based on duration type.
 */
export function resolveFact(
  facts: CompanyFacts,
  mapping: ConceptMapping,
  identity: FiscalIdentity,
): SecFactMatch {
  if (mapping.duration === "instant") {
    return selectInstantFact(facts, mapping, identity);
  }
  // Duration facts use the existing official selector
  const result = selectOfficialMetric(facts, [mapping.concept], mapping.unit, identity);
  return {
    value: result.value,
    concept: result.concept,
    unit: result.unit,
    accn: result.accn,
    form: result.form,
    filed: result.filed,
    periodEnd: result.periodEnd,
    periodStart: result.periodStart,
    fiscalYear: result.fiscalYear,
    fiscalPeriod: result.fiscalPeriod,
    taxonomy: mapping.taxonomy,
    blockers: result.blockers,
  };
}

export {
  fetchCompanyFacts,
  fetchTickerCikMap,
  parseCompanyFacts,
  secFilingUrl,
  SEC_DEFAULT_USER_AGENT,
};

export type { CompanyFacts, FiscalIdentity, OfficialMetricSelection, XbrlFactInstance };
