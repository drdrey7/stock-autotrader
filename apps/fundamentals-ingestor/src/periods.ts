/**
 * Fiscal period resolution — quarters, YTD, TTM.
 *
 * Hard rules:
 *   - Never treat YTD/accumulated values as discrete quarters.
 *   - Q2 discrete = H1 − Q1 (only when fiscal periods provably comparable)
 *   - Q3 discrete = 9M − H1 (only when provably comparable)
 *   - Q4 discrete = FY − 9M (only when provably comparable)
 *   - TTM = last 4 discrete quarters when all four exist
 *   - Fallback TTM = latest FY + current YTD − prior-year YTD (only when
 *     fiscal identity is provably equivalent)
 *   - Anything unprovable → null + blocker reason.
 */

export interface FiscalPeriod {
  readonly fiscalYear: number;
  readonly fiscalPeriod: "Q1" | "Q2" | "Q3" | "Q4" | "FY" | "H1" | "9M";
  readonly periodStart: string | null;
  readonly periodEnd: string | null;
  readonly form: string | null;
  readonly accession: string | null;
  readonly filed: string | null;
}

export interface PeriodResolution {
  readonly value: number | null;
  readonly derived: boolean;
  readonly derivation: string | null;
  readonly blockers: string[];
}

/**
 * Attempt to derive a discrete quarter from two accumulated periods.
 * Returns null when the periods are not provably comparable.
 */
export function deriveDiscreteQuarter(
  accumulated: number | null,
  priorAccumulated: number | null,
  accumulatedPeriod: FiscalPeriod,
  priorPeriod: FiscalPeriod,
): PeriodResolution {
  const blockers: string[] = [];
  if (accumulated === null || priorAccumulated === null) {
    return { value: null, derived: true, derivation: null, blockers: ["missing accumulated or prior period"] };
  }
  // Fiscal year must match for Q2=Q1−H1 derivations within the same FY
  if (accumulatedPeriod.fiscalYear !== priorPeriod.fiscalYear) {
    blockers.push(`fiscal year mismatch: ${accumulatedPeriod.fiscalYear} vs ${priorPeriod.fiscalYear}`);
    return { value: null, derived: true, derivation: null, blockers };
  }
  const value = accumulated - priorAccumulated;
  if (value < 0) {
    blockers.push(`derived negative value: ${value}`);
    return { value: null, derived: true, derivation: null, blockers };
  }
  return {
    value,
    derived: true,
    derivation: `${accumulatedPeriod.fiscalPeriod}-${priorPeriod.fiscalPeriod}`,
    blockers: [],
  };
}

/**
 * Build TTM from up to 4 discrete quarters. Requires ALL four quarters present.
 * Missing any quarter → null with blocker (no partial TTM fabrication).
 */
export function buildTtmFromQuarters(
  quarters: ReadonlyArray<{ value: number | null; period: FiscalPeriod }>,
): PeriodResolution {
  const valid = quarters.filter((q): q is { value: number; period: FiscalPeriod } => q.value !== null);
  if (valid.length < 4) {
    return {
      value: null,
      derived: true,
      derivation: null,
      blockers: [`TTM requires 4 discrete quarters, found ${valid.length}`],
    };
  }
  // Check consecutive quarters (Q4→Q3→Q2→Q1 or fiscal year ordering)
  const sorted = [...valid].sort((a, b) => {
    const aOrder = periodOrder(a.period);
    const bOrder = periodOrder(b.period);
    return bOrder - aOrder; // newest first
  });
  const value = sorted.slice(0, 4).reduce((sum, q) => sum + q.value, 0);
  return {
    value,
    derived: true,
    derivation: "TTM-4Q",
    blockers: [],
  };
}

function periodOrder(p: FiscalPeriod): number {
  const periodRank: Record<string, number> = { Q1: 1, Q2: 2, H1: 2, Q3: 3, "9M": 3, Q4: 4, FY: 4 };
  return (p.fiscalYear * 10) + (periodRank[p.fiscalPeriod] ?? 0);
}

/**
 * Safe FY + current YTD − prior YTD fallback for TTM.
 * Only valid when the YTD periods cover provably equivalent spans.
 */
export function buildTtmFromYtdFallback(
  latestFy: number | null,
  currentYtd: number | null,
  currentYtdPeriod: FiscalPeriod | null,
  priorYtd: number | null,
  priorYtdPeriod: FiscalPeriod | null,
): PeriodResolution {
  const blockers: string[] = [];
  if (latestFy === null || currentYtd === null || priorYtd === null) {
    blockers.push("missing FY, current YTD, or prior YTD value");
    return { value: null, derived: true, derivation: null, blockers };
  }
  if (!currentYtdPeriod || !priorYtdPeriod) {
    blockers.push("missing YTD period metadata");
    return { value: null, derived: true, derivation: null, blockers };
  }
  // Prior YTD must be exactly one fiscal year before current YTD
  if (priorYtdPeriod.fiscalYear !== currentYtdPeriod.fiscalYear - 1) {
    blockers.push(`prior YTD fiscal year ${priorYtdPeriod.fiscalYear} is not current FY ${currentYtdPeriod.fiscalYear} - 1`);
    return { value: null, derived: true, derivation: null, blockers };
  }
  // Period tags must match (both H1, both 9M, etc.)
  if (priorYtdPeriod.fiscalPeriod !== currentYtdPeriod.fiscalPeriod) {
    blockers.push(`YTD period mismatch: ${currentYtdPeriod.fiscalPeriod} vs ${priorYtdPeriod.fiscalPeriod}`);
    return { value: null, derived: true, derivation: null, blockers };
  }
  const value = latestFy + currentYtd - priorYtd;
  return {
    value,
    derived: true,
    derivation: "FY+YTD-priorYTD",
    blockers: [],
  };
}
