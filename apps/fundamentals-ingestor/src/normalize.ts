/**
 * Normalization — resolve canonical fields from a parsed CompanyFacts payload.
 *
 * Uses resolveDurationFact for duration concepts (can derive discrete quarters)
 * and resolveFact for instant concepts (balance sheet).
 */

import { CONCEPT_MAPPINGS, type CanonicalField, type ConceptMapping } from "./concepts";
import { resolveFact } from "./sec-client";
import { resolveDurationFact } from "./duration-resolver";
import type { CompanyFacts, FiscalIdentity } from "./sec-client";

export interface NormalizedField {
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
  readonly taxonomy: string | null;
  readonly blockers: string[];
  readonly derived: boolean;
  readonly derivation?: string | null;
}

export interface NormalizedPeriod {
  readonly symbol: string;
  readonly fiscalYear: number;
  readonly fiscalPeriod: string;
  readonly periodStart: string | null;
  readonly periodEnd: string | null;
  readonly filingDate: string | null;
  readonly form: string | null;
  readonly accession: string | null;
  readonly taxonomy: string | null;
  readonly currency: string;
  readonly fields: Partial<Record<CanonicalField, NormalizedField>>;
  readonly missingFields: CanonicalField[];
  readonly blockers: string[];
}

/**
 * Resolve one canonical field for a given fiscal identity.
 * Uses the appropriate resolver based on duration type.
 */
export function resolveCanonicalField(
  facts: CompanyFacts,
  field: CanonicalField,
  identity: FiscalIdentity,
): NormalizedField {
  const mappings = CONCEPT_MAPPINGS[field];
  if (!mappings || mappings.length === 0) {
    return nullField(["no concept mapping defined for field"]);
  }

  // Group mappings by taxonomy, preserving priority order within each
  const byTaxonomy = new Map<string, ConceptMapping[]>();
  for (const mapping of mappings) {
    const list = byTaxonomy.get(mapping.taxonomy) ?? [];
    list.push(mapping);
    byTaxonomy.set(mapping.taxonomy, list);
  }

  // Taxonomy priority: us-gaap first, then ifrs-full, then dei
  const taxonomyOrder = ["us-gaap", "ifrs-full", "dei"];
  const allBlockers: string[] = [];

  for (const taxonomy of taxonomyOrder) {
    const taxonomyMappings = byTaxonomy.get(taxonomy);
    if (!taxonomyMappings) continue;

    for (const mapping of taxonomyMappings) {
      // Use duration resolver for duration facts, instant resolver for instant facts
      const match = mapping.duration === "duration"
        ? resolveDurationFact(facts, mapping, identity)
        : resolveFact(facts, mapping, identity);

      if (match.value !== null) {
        return {
          value: match.value,
          concept: match.concept,
          unit: match.unit,
          accn: match.accn,
          form: match.form,
          filed: match.filed,
          periodEnd: match.periodEnd,
          periodStart: match.periodStart,
          fiscalYear: match.fiscalYear,
          fiscalPeriod: match.fiscalPeriod,
          taxonomy: match.taxonomy,
          blockers: match.blockers,
          derived: (match as any).derived ?? false,
          derivation: (match as any).derivation ?? null,
        };
      }
      allBlockers.push(...match.blockers);
    }
  }

  return nullField(allBlockers.length > 0 ? allBlockers : [`no matching fact for field ${field}`]);
}

function nullField(blockers: string[]): NormalizedField {
  return {
    value: null, concept: null, unit: null, accn: null, form: null, filed: null,
    periodEnd: null, periodStart: null, fiscalYear: null, fiscalPeriod: null,
    taxonomy: null, blockers, derived: false, derivation: null,
  };
}

/**
 * Normalize all canonical fields for a single fiscal period.
 */
export function normalizePeriod(
  symbol: string,
  facts: CompanyFacts,
  identity: FiscalIdentity,
  options: { currency?: string } = {},
): NormalizedPeriod {
  const fields: Partial<Record<CanonicalField, NormalizedField>> = {};
  const missingFields: CanonicalField[] = [];
  const allBlockers: string[] = [];
  const resolvedFieldOrder = Object.keys(CONCEPT_MAPPINGS) as CanonicalField[];

  for (const field of resolvedFieldOrder) {
    const result = resolveCanonicalField(facts, field, identity);
    fields[field] = result;
    if (result.value === null) {
      missingFields.push(field);
    }
    allBlockers.push(...result.blockers);
  }

  // Extract period metadata from the first resolved field
  const firstResolved = Object.values(fields).find((f) => f?.value !== null);
  const filingDate = firstResolved?.filed ?? null;
  const form = firstResolved?.form ?? null;
  const accession = firstResolved?.accn ?? null;
  const taxonomy = firstResolved?.taxonomy ?? null;
  const periodEnd = firstResolved?.periodEnd ?? null;
  const periodStart = firstResolved?.periodStart ?? null;

  return {
    symbol,
    fiscalYear: identity.fiscalYear ?? 0,
    fiscalPeriod: identity.fiscalQuarter ? `Q${identity.fiscalQuarter}` : "FY",
    periodStart, periodEnd, filingDate, form, accession, taxonomy,
    currency: options.currency ?? "USD",
    fields, missingFields, blockers: allBlockers,
  };
}
