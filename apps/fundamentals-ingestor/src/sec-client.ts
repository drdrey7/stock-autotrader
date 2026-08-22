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
  acceptedFormsForTaxonomy,
  normalizedForm,
  secFilingUrl,
  SEC_DEFAULT_USER_AGENT,
  type CompanyFacts,
  type FiscalIdentity,
  type OfficialMetricSelection,
  type XbrlFactInstance,
} from "../../web/worker/earnings/sec-xbrl";
import { unitMatchesMapping, type ConceptMapping, type Taxonomy } from "./concepts";

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

  const candidates = facts.facts.filter((fact) => fact.concept === mapping.concept
    && fact.taxonomy === mapping.taxonomy);
  if (candidates.length === 0) {
    return nullMatch(mapping, [`no ${mapping.concept} facts in companyfacts`]);
  }

  // 1. unit
  const pool = candidates.filter((fact) => unitMatchesMapping(mapping, fact.unit));
  if (pool.length === 0) {
    return nullMatch(mapping, [`no ${mapping.concept} facts with unit ${mapping.unit}`]);
  }

  // 2. Match the requested fiscal identity and exact period context. Choosing
  // the latest balance in a fiscal year would attach a later Q3/FY balance to
  // an older Q1 period row.
  const withFiscal = pool.filter((fact) => fact.fy === identity.fiscalYear || fact.fy === null);
  if (withFiscal.length === 0) {
    return nullMatch(mapping, [
      `no ${mapping.concept} facts matching fiscal year ${identity.fiscalYear} (facts span ${describeFiscalRange(pool)})`,
    ]);
  }

  const periodCandidates = identity.fiscalPeriodEnd
    ? withFiscal.filter((fact) => fact.end === identity.fiscalPeriodEnd)
    : withFiscal.filter((fact) => fact.fp === (identity.fiscalQuarter === 4 ? "FY" : `Q${identity.fiscalQuarter}`));
  if (periodCandidates.length === 0) {
    return nullMatch(mapping, [
      `no ${mapping.concept} facts matching period end ${identity.fiscalPeriodEnd ?? `Q${identity.fiscalQuarter}`}`,
    ]);
  }

  // 3. Forms are explicit for both domestic and foreign issuers.
  const acceptedForms = new Set(acceptedFormsForTaxonomy(mapping.taxonomy).map((form) => normalizedForm(form)));
  const withForm = periodCandidates.filter((fact) => {
    const form = normalizedForm(fact.form);
    return form !== null && acceptedForms.has(form);
  });
  if (withForm.length === 0) {
    return nullMatch(mapping, [`${mapping.concept} facts have no accepted filing form`]);
  }

  // 4. A conflicting same-period set is unresolved unless an amendment
  // provides the operative restatement.
  const isAmendment = (fact: XbrlFactInstance): boolean => fact.form?.toUpperCase().endsWith("/A") ?? false;
  const nonAmendmentValues = new Set(withForm.filter((fact) => !isAmendment(fact)).map((fact) => fact.val));
  if (nonAmendmentValues.size > 1 && !withForm.some(isAmendment)) {
    return nullMatch(mapping, [`conflicting ${mapping.concept} values for period end ${identity.fiscalPeriodEnd}`]);
  }
  const amendments = withForm.filter(isAmendment);
  const candidatesToRank = amendments.length > 0 ? amendments : withForm;
  const sorted = [...candidatesToRank].sort((a, b) => {
    const filed = (b.filed ?? "").localeCompare(a.filed ?? "");
    return filed !== 0 ? filed : (b.accn ?? "").localeCompare(a.accn ?? "");
  });
  const winner = sorted[0]!;
  const restated = isAmendment(winner) && nonAmendmentValues.size > 0;

  return {
    value: winner.val, concept: winner.concept, unit: winner.unit,
    accn: winner.accn, form: winner.form, filed: winner.filed,
    periodEnd: winner.end, periodStart: winner.start,
    fiscalYear: winner.fy, fiscalPeriod: winner.fp,
    taxonomy: mapping.taxonomy,
    blockers: restated ? [`resolved from amended/restated filing (${winner.form})`] : [],
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
  return durationSelectionToMatch(selectOfficialMetric(
    facts,
    [mapping.concept],
    mapping.unit,
    identity,
    {
      taxonomy: mapping.taxonomy,
      acceptedForms: acceptedFormsForTaxonomy(mapping.taxonomy),
      unitMatches: (unit) => unitMatchesMapping(mapping, unit),
    },
  ), mapping);
}

export type AccumulatedPeriod = "Q1" | "H1" | "9M" | "FY";

/** Resolve a cumulative duration for an honest FY+YTD TTM fallback. */
export function resolveAccumulatedFact(
  facts: CompanyFacts,
  mapping: ConceptMapping,
  fiscalYear: number,
  period: AccumulatedPeriod,
  periodEnd: string | null,
): SecFactMatch {
  const fiscalQuarter = period === "Q1" ? 1 : period === "H1" ? 2 : period === "9M" ? 3 : 4;
  const acceptedFiscalPeriods = period === "Q1"
    ? ["Q1"]
    : period === "H1"
      ? ["H1", "Q2"]
      : period === "9M"
        ? ["9M", "Q3"]
        : ["FY", "Q4"];
  return durationSelectionToMatch(selectOfficialMetric(
    facts,
    [mapping.concept],
    mapping.unit,
    { fiscalYear, fiscalQuarter, fiscalPeriod: period, scheduledDate: null, fiscalPeriodEnd: periodEnd },
    {
      taxonomy: mapping.taxonomy,
      acceptedForms: acceptedFormsForTaxonomy(mapping.taxonomy),
      unitMatches: (unit) => unitMatchesMapping(mapping, unit),
      durationKind: "accumulated",
      acceptedFiscalPeriods,
    },
  ), mapping);
}

function durationSelectionToMatch(
  result: OfficialMetricSelection,
  mapping: ConceptMapping,
): SecFactMatch {
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
