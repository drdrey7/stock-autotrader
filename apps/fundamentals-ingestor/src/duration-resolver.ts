/**
 * Duration fact resolver with discrete-quarter derivation.
 *
 * For duration facts (revenue, income, cash flow), tries:
 *   1. Direct resolution via existing selector (works for discrete-quarter reporters)
 *   2. Discrete-quarter derivation when only cumulative facts exist:
 *      - Q2 = H1 − Q1
 *      - Q3 = 9M − H1
 *      - Q4 = FY − 9M
 */

import {
  fetchCompanyFacts,
  fetchTickerCikMap,
  SEC_DEFAULT_USER_AGENT,
  type CompanyFacts,
  type FiscalIdentity,
  type XbrlFactInstance,
} from "../../web/worker/earnings/sec-xbrl";
import { resolveFact } from "./sec-client";
import type { ConceptMapping } from "./concepts";

const DAY_MS = 24 * 60 * 60 * 1000;

function daysBetween(start: string | null, end: string | null): number {
  if (!start || !end) return NaN;
  const from = Date.parse(`${start}T00:00:00.000Z`);
  const to = Date.parse(`${end}T00:00:00.000Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return NaN;
  return (to - from) / DAY_MS;
}

export interface ResolvedDurationFact {
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

/**
 * Resolve a duration fact for a specific fiscal quarter.
 */
export function resolveDurationFact(
  facts: CompanyFacts,
  mapping: ConceptMapping,
  identity: FiscalIdentity,
): ResolvedDurationFact {
  // Step 1: Try direct resolution (handles discrete-quarter reporters)
  const direct = resolveFact(facts, mapping, identity);
  if (direct.value !== null) {
    return { ...direct, derived: false, derivation: null };
  }

  // Step 2: Try discrete-quarter derivation for cumulative reporters
  if (identity.fiscalQuarter === null || identity.fiscalYear === null) {
    return { ...direct, derived: false, derivation: null };
  }

  // Get all raw facts for this concept+unit+fy
  const allFacts: XbrlFactInstance[] = (facts.facts as XbrlFactInstance[]).filter(
    (f) => f.concept === mapping.concept && f.unit === mapping.unit && f.fy === identity.fiscalYear
  );

  if (allFacts.length === 0) {
    return { ...direct, derived: false, derivation: null };
  }

  // Group by fiscal period tag
  const byPeriod = new Map<string, XbrlFactInstance[]>();
  for (const f of allFacts) {
    if (f.fp) {
      const list = byPeriod.get(f.fp) || [];
      list.push(f);
      byPeriod.set(f.fp, list);
    }
  }

  const quarter = identity.fiscalQuarter;

  // Helper: get the most recent fact from a period bucket
  const getLatest = (fp: string): XbrlFactInstance | null => {
    const bucket = byPeriod.get(fp);
    if (!bucket || bucket.length === 0) return null;
    return bucket.sort((a, b) => (b.filed ?? "").localeCompare(a.filed ?? ""))[0] ?? null;
  };

  if (quarter === 2) {
    // Q2 = H1 − Q1
    const h1 = getLatest("H1") || getLatest("Q2");
    const q1 = getLatest("Q1");
    if (h1 && q1 && h1.val !== null && q1.val !== null) {
      const h1Days = daysBetween(h1.start, h1.end);
      const q1Days = daysBetween(q1.start, q1.end);
      if (h1Days > 120 && q1Days <= 120) {
        const q2Val = h1.val - q1.val;
        return {
          value: q2Val, concept: h1.concept, unit: h1.unit,
          accn: h1.accn, form: h1.form, filed: h1.filed,
          periodEnd: h1.end, periodStart: q1.end,
          fiscalYear: h1.fy, fiscalPeriod: "Q2",
          taxonomy: mapping.taxonomy,
          blockers: ["derived: Q2 = H1 − Q1"],
          derived: true, derivation: "H1−Q1",
        };
      }
    }
  }

  if (quarter === 3) {
    // Q3 = 9M − H1
    const nineM = getLatest("9M") || getLatest("Q3");
    const h1 = getLatest("H1") || getLatest("Q2");
    if (nineM && h1 && nineM.val !== null && h1.val !== null) {
      const nineMDays = daysBetween(nineM.start, nineM.end);
      const h1Days = daysBetween(h1.start, h1.end);
      if (nineMDays > 180 && h1Days > 120) {
        const q3Val = nineM.val - h1.val;
        return {
          value: q3Val, concept: nineM.concept, unit: nineM.unit,
          accn: nineM.accn, form: nineM.form, filed: nineM.filed,
          periodEnd: nineM.end, periodStart: h1.end,
          fiscalYear: nineM.fy, fiscalPeriod: "Q3",
          taxonomy: mapping.taxonomy,
          blockers: ["derived: Q3 = 9M − H1"],
          derived: true, derivation: "9M−H1",
        };
      }
    }
  }

  if (quarter === 4) {
    // Q4 = FY − 9M
    const fy = getLatest("FY");
    const nineM = getLatest("9M") || getLatest("Q3");
    if (fy && nineM && fy.val !== null && nineM.val !== null) {
      const fyDays = daysBetween(fy.start, fy.end);
      const nineMDays = daysBetween(nineM.start, nineM.end);
      if (fyDays > 300 && nineMDays > 180) {
        const q4Val = fy.val - nineM.val;
        return {
          value: q4Val, concept: fy.concept, unit: fy.unit,
          accn: fy.accn, form: fy.form, filed: fy.filed,
          periodEnd: fy.end, periodStart: nineM.end,
          fiscalYear: fy.fy, fiscalPeriod: "Q4",
          taxonomy: mapping.taxonomy,
          blockers: ["derived: Q4 = FY − 9M"],
          derived: true, derivation: "FY−9M",
        };
      }
    }
  }

  return { ...direct, derived: false, derivation: null };
}

export { fetchCompanyFacts, fetchTickerCikMap, SEC_DEFAULT_USER_AGENT };
export type { CompanyFacts, FiscalIdentity };
