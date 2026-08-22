import { describe, expect, it } from "vitest";
import { CONCEPT_MAPPINGS } from "../src/concepts";
import { extractFiscalIdentities } from "../src/identities";
import { resolveCanonicalField, normalizePeriod } from "../src/normalize";
import { resolveDurationFact, type ResolvedDurationFact } from "../src/duration-resolver";
import { resolveFact } from "../src/sec-client";
import { aggregateTtm } from "../src/ttm";
import type { CompanyFacts, FiscalIdentity, XbrlFactInstance } from "../../web/worker/earnings/sec-xbrl";
import type { NormalizedPeriod } from "../src/normalize";

function fact(overrides: Partial<XbrlFactInstance> & Pick<XbrlFactInstance, "concept" | "taxonomy" | "unit" | "val" | "fy" | "fp" | "end">): XbrlFactInstance {
  return {
    start: null,
    accn: "0000000000-26-000001",
    form: "10-Q",
    filed: "2026-08-01",
    ...overrides,
  };
}

function facts(instances: XbrlFactInstance[]): CompanyFacts {
  return { cik: "0000000000", facts: instances, warnings: [] };
}

function identity(fiscalYear: number, fiscalQuarter: number, fiscalPeriodEnd: string): FiscalIdentity {
  return {
    fiscalYear,
    fiscalQuarter,
    fiscalPeriod: `Q${fiscalQuarter}`,
    scheduledDate: null,
    fiscalPeriodEnd,
  };
}

function normalizedField(value: number | null, periodEnd: string): ResolvedDurationFact {
  return {
    value,
    concept: value === null ? null : "Revenue",
    unit: value === null ? null : "USD",
    accn: value === null ? null : "0000000000-26-000001",
    form: value === null ? null : "10-Q",
    filed: value === null ? null : "2026-08-01",
    periodEnd: value === null ? null : periodEnd,
    periodStart: null,
    fiscalYear: value === null ? null : 2026,
    fiscalPeriod: value === null ? null : "Q1",
    taxonomy: value === null ? null : "us-gaap",
    blockers: [],
    derived: false,
    derivation: null,
  };
}

describe("SEC fundamentals resolution regressions", () => {
  it("maps annual FY facts to a Q4 identity", () => {
    const identities = extractFiscalIdentities(facts([
      fact({ concept: "Revenue", taxonomy: "ifrs-full", unit: "EUR", val: 100, fy: 2026, fp: "FY", start: "2026-01-01", end: "2026-12-31", form: "20-F" }),
      fact({ concept: "EntityCommonStockSharesOutstanding", taxonomy: "dei", unit: "shares", val: 10, fy: 2026, fp: "FY", end: "2027-01-15", form: "20-F" }),
      fact({ concept: "Revenue", taxonomy: "ifrs-full", unit: "EUR", val: 70, fy: 2026, fp: "Q3", end: "2026-09-30", form: "6-K" }),
    ]));
    expect(identities[0]).toMatchObject({ fiscalYear: 2026, fiscalQuarter: 4, fiscalPeriod: "Q4", fiscalPeriodEnd: "2026-12-31" });
  });

  it("prefers a duration period end over a later point-in-time metadata date", () => {
    const identities = extractFiscalIdentities(facts([
      fact({ concept: "EntityCommonStockSharesOutstanding", taxonomy: "dei", unit: "shares", val: 10, fy: 2026, fp: "Q2", end: "2026-06-11" }),
      fact({ concept: "Revenue", taxonomy: "us-gaap", unit: "USD", val: 100, fy: 2026, fp: "Q2", start: "2026-02-28", end: "2026-05-29" }),
    ]));
    expect(identities[0]?.fiscalPeriodEnd).toBe("2026-05-29");
  });

  it("keeps instant balances on the requested period end", () => {
    const mapping = CONCEPT_MAPPINGS.total_assets[0]!;
    const result = resolveFact(facts([
      fact({ concept: "Assets", taxonomy: "us-gaap", unit: "USD", val: 100, fy: 2026, fp: "Q1", end: "2026-03-31" }),
      fact({ concept: "Assets", taxonomy: "us-gaap", unit: "USD", val: 300, fy: 2026, fp: "Q3", end: "2026-09-30" }),
    ]), mapping, identity(2026, 1, "2026-03-31"));
    expect(result.value).toBe(100);
  });

  it("isolates IFRS facts from a US-GAAP mapping and preserves the reporting currency", () => {
    const parsed = facts([
      fact({ concept: "Assets", taxonomy: "ifrs-full", unit: "EUR", val: 900, fy: 2026, fp: "Q1", end: "2026-03-31", form: "6-K" }),
    ]);
    const result = resolveCanonicalField(parsed, "total_assets", identity(2026, 1, "2026-03-31"));
    const period = normalizePeriod("ASML", parsed, identity(2026, 1, "2026-03-31"));
    expect(result).toMatchObject({ value: 900, taxonomy: "ifrs-full", unit: "EUR" });
    expect(period.currency).toBe("EUR");
  });

  it("accepts a foreign reporting currency on a US-GAAP taxonomy without changing taxonomy", () => {
    const parsed = facts([
      fact({ concept: "Assets", taxonomy: "us-gaap", unit: "EUR", val: 900, fy: 2026, fp: "Q1", end: "2026-03-31", form: "20-F" }),
    ]);
    const result = resolveCanonicalField(parsed, "total_assets", identity(2026, 1, "2026-03-31"));
    expect(result).toMatchObject({ value: 900, taxonomy: "us-gaap", unit: "EUR" });
  });

  it("accepts foreign filing forms and per-share currencies", () => {
    const result = resolveCanonicalField(facts([
      fact({ concept: "Revenue", taxonomy: "ifrs-full", unit: "DKK", val: 500, fy: 2026, fp: "Q1", start: "2026-01-01", end: "2026-03-31", form: "6-K" }),
      fact({ concept: "DilutedEarningsLossPerShare", taxonomy: "ifrs-full", unit: "DKK/shares", val: 2.5, fy: 2026, fp: "Q1", end: "2026-03-31", form: "20-F" }),
    ]), "revenue", identity(2026, 1, "2026-03-31"));
    expect(result).toMatchObject({ value: 500, unit: "DKK", taxonomy: "ifrs-full" });
  });

  it("preserves negative cumulative-quarter derivations", () => {
    const mapping = CONCEPT_MAPPINGS.operating_income[0]!;
    const result = resolveDurationFact(facts([
      fact({ concept: mapping.concept, taxonomy: "us-gaap", unit: "USD", val: 100, fy: 2026, fp: "Q1", end: "2026-03-31", start: "2026-01-01" }),
      fact({ concept: mapping.concept, taxonomy: "us-gaap", unit: "USD", val: 40, fy: 2026, fp: "Q2", end: "2026-06-30", start: "2026-01-01" }),
    ]), mapping, identity(2026, 2, "2026-06-30"));
    expect(result).toMatchObject({ value: -60, derived: true, derivation: "H1−Q1" });
  });

  it("derives Q4 from FY minus 9M", () => {
    const mapping = CONCEPT_MAPPINGS.revenue[0]!;
    const result = resolveDurationFact(facts([
      fact({ concept: mapping.concept, taxonomy: "us-gaap", unit: "USD", val: 300, fy: 2026, fp: "Q3", end: "2026-09-30", start: "2026-01-01" }),
      fact({ concept: mapping.concept, taxonomy: "us-gaap", unit: "USD", val: 450, fy: 2026, fp: "FY", end: "2026-12-31", start: "2026-01-01", form: "10-K" }),
    ]), mapping, identity(2026, 4, "2026-12-31"));
    expect(result).toMatchObject({ value: 150, derived: true, derivation: "FY−9M", fiscalPeriod: "Q4" });
  });

  it("prefers an instant amendment and rejects conflicting non-amendments", () => {
    const mapping = CONCEPT_MAPPINGS.cash[0]!;
    const amended = resolveFact(facts([
      fact({ concept: mapping.concept, taxonomy: "us-gaap", unit: "USD", val: 100, fy: 2026, fp: "Q2", end: "2026-06-30", filed: "2026-07-30" }),
      fact({ concept: mapping.concept, taxonomy: "us-gaap", unit: "USD", val: 110, fy: 2026, fp: "Q2", end: "2026-06-30", form: "10-Q/A", filed: "2026-08-10" }),
    ]), mapping, identity(2026, 2, "2026-06-30"));
    expect(amended.value).toBe(110);
    const conflicting = resolveFact(facts([
      fact({ concept: mapping.concept, taxonomy: "us-gaap", unit: "USD", val: 100, fy: 2026, fp: "Q2", end: "2026-06-30", filed: "2026-07-30" }),
      fact({ concept: mapping.concept, taxonomy: "us-gaap", unit: "USD", val: 110, fy: 2026, fp: "Q2", end: "2026-06-30", filed: "2026-08-10" }),
    ]), mapping, identity(2026, 2, "2026-06-30"));
    expect(conflicting.value).toBeNull();
  });

  it("keeps debt, liabilities, and point-in-time shares semantically separate", () => {
    expect(CONCEPT_MAPPINGS.total_debt[0]).toMatchObject({ concept: "DebtLongtermAndShorttermCombinedAmount" });
    const parsed = facts([
      fact({ concept: "LiabilitiesAndStockholdersEquity", taxonomy: "us-gaap", unit: "USD", val: 900, fy: 2026, fp: "Q1", end: "2026-03-31" }),
      fact({ concept: "WeightedAverageNumberOfSharesOutstandingBasic", taxonomy: "us-gaap", unit: "shares", val: 100, fy: 2026, fp: "Q1", end: "2026-03-31", start: "2026-01-01" }),
    ]);
    expect(resolveCanonicalField(parsed, "total_liabilities", identity(2026, 1, "2026-03-31")).value).toBeNull();
    expect(resolveCanonicalField(parsed, "shares_outstanding", identity(2026, 1, "2026-03-31")).value).toBeNull();
  });
});

describe("true TTM aggregation", () => {
  function period(fiscalYear: number, fiscalPeriod: string, value: number, end: string): NormalizedPeriod {
    return {
      symbol: "ADBE",
      fiscalYear,
      fiscalPeriod,
      periodStart: null,
      periodEnd: end,
      filingDate: "2026-08-01",
      form: "10-Q",
      accession: "0000000000-26-000001",
      taxonomy: "us-gaap",
      currency: "USD",
      fields: {
        revenue: normalizedField(value, end),
      },
      missingFields: [],
      blockers: [],
    } as unknown as NormalizedPeriod;
  }

  it("sums the newest four consecutive quarters instead of copying Q1", () => {
    const result = aggregateTtm(facts([]), [
      period(2026, "Q1", 50, "2026-03-31"),
      period(2025, "Q4", 40, "2025-12-31"),
      period(2025, "Q3", 30, "2025-09-30"),
      period(2025, "Q2", 20, "2025-06-30"),
      period(2025, "Q1", 10, "2025-03-31"),
    ]);
    expect(result.values.revenue).toBe(140);
    expect(result.derivations.revenue).toBe("TTM-4Q");
    expect(result.blockers.some((blocker) => blocker.startsWith("TTM revenue:"))).toBe(false);
  });

  it("uses FY + current YTD - prior YTD when four discrete quarters are unavailable", () => {
    const revenue = CONCEPT_MAPPINGS.revenue[0]!;
    const result = aggregateTtm(facts([
      fact({ concept: revenue.concept, taxonomy: "us-gaap", unit: "USD", val: 300, fy: 2026, fp: "H1", start: "2026-01-01", end: "2026-06-30" }),
      fact({ concept: revenue.concept, taxonomy: "us-gaap", unit: "USD", val: 250, fy: 2025, fp: "H1", start: "2025-01-01", end: "2025-06-30" }),
      fact({ concept: revenue.concept, taxonomy: "us-gaap", unit: "USD", val: 1000, fy: 2025, fp: "FY", start: "2025-01-01", end: "2025-12-31", form: "10-K" }),
    ]), [period(2026, "Q2", 300, "2026-06-30")]);

    expect(result.values.revenue).toBe(1050);
    expect(result.derivations.revenue).toBe("FY+YTD-priorYTD");
    expect(result.blockers.some((blocker) => blocker.startsWith("TTM revenue:"))).toBe(false);
  });
});
