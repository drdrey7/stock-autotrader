import type { CompanyFacts, FiscalIdentity } from "../../web/worker/earnings/sec-xbrl";

/** Extract unique fiscal quarters, treating an annual FY fact as Q4. */
export function extractFiscalIdentities(facts: CompanyFacts): FiscalIdentity[] {
  const byIdentity = new Map<string, { identity: FiscalIdentity; end: string; hasDuration: boolean }>();
  for (const fact of facts.facts) {
    if (fact.fy === null || fact.fp === null) continue;
    const fiscalQuarter = normalizedFiscalQuarter(fact.fp);
    if (fiscalQuarter === null || fact.end === null) continue;
    const key = `${fact.fy}-Q${fiscalQuarter}`;
    const previous = byIdentity.get(key);
    const hasDuration = fact.start !== null;
    if (previous && previous.hasDuration && !hasDuration) continue;
    if (previous && previous.hasDuration === hasDuration && previous.end >= fact.end) continue;
    byIdentity.set(key, {
      end: fact.end,
      hasDuration,
      identity: {
        fiscalYear: fact.fy,
        fiscalQuarter,
        fiscalPeriod: `Q${fiscalQuarter}`,
        scheduledDate: null,
        fiscalPeriodEnd: fact.end,
      },
    });
  }
  return [...byIdentity.values()]
    .map(({ identity }) => identity)
    .sort((a, b) => {
      if (a.fiscalYear !== b.fiscalYear) return (b.fiscalYear ?? 0) - (a.fiscalYear ?? 0);
      return (b.fiscalQuarter ?? 0) - (a.fiscalQuarter ?? 0);
    });
}

function normalizedFiscalQuarter(fp: string): number | null {
  const normalized = fp.toUpperCase();
  if (/^Q[1-4]$/.test(normalized)) return Number(normalized.slice(1));
  if (normalized === "H1") return 2;
  if (normalized === "9M") return 3;
  if (normalized === "FY") return 4;
  return null;
}
