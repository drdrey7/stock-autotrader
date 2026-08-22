/**
 * Unit tests for the fundamentals-ingestor.
 */

import { describe, expect, it } from "vitest";
import { CONCEPT_MAPPINGS, type CanonicalField } from "../src/concepts";
import { computeFreeCashFlow, computeFcfMarginPct, computeDebtToEquity, computeRoicPct, computeMarketCap, computePeTtm } from "../src/metrics";
import { deriveDiscreteQuarter, buildTtmFromQuarters, buildTtmFromYtdFallback, type FiscalPeriod } from "../src/periods";

describe("concepts", () => {
  it("has mappings for all canonical fields", () => {
    const fields = Object.keys(CONCEPT_MAPPINGS) as CanonicalField[];
    expect(fields.length).toBeGreaterThan(0);
    for (const field of fields) {
      expect(CONCEPT_MAPPINGS[field].length).toBeGreaterThan(0);
    }
  });

  it("prioritizes us-gaap before ifrs-full for revenue", () => {
    const mappings = CONCEPT_MAPPINGS.revenue;
    const usGaap = mappings.filter(m => m.taxonomy === "us-gaap");
    const ifrs = mappings.filter(m => m.taxonomy === "ifrs-full");
    expect(usGaap.length).toBeGreaterThan(0);
    expect(ifrs.length).toBeGreaterThan(0);
    expect(usGaap[0]!.priority).toBeLessThan(ifrs[0]!.priority);
  });

  it("includes diluted EPS with USD/shares unit", () => {
    const mappings = CONCEPT_MAPPINGS.diluted_eps;
    expect(mappings.some(m => m.unit === "USD/shares")).toBe(true);
  });
});

describe("metrics — computeFreeCashFlow", () => {
  it("computes FCF = OpCF - CapEx", () => {
    expect(computeFreeCashFlow(100, 20)).toBe(80);
  });

  it("flips negative CapEx to positive magnitude", () => {
    expect(computeFreeCashFlow(100, -20)).toBe(80);
  });

  it("returns null when OpCF is null", () => {
    expect(computeFreeCashFlow(null, 20)).toBeNull();
  });

  it("returns null when CapEx is null", () => {
    expect(computeFreeCashFlow(100, null)).toBeNull();
  });
});

describe("metrics — computeFcfMarginPct", () => {
  it("computes FCF margin as percentage", () => {
    expect(computeFcfMarginPct(80, 200)).toBe(40);
  });

  it("returns null when revenue is 0", () => {
    expect(computeFcfMarginPct(80, 0)).toBeNull();
  });
});

describe("metrics — computeDebtToEquity", () => {
  it("computes D/E ratio", () => {
    expect(computeDebtToEquity(100, 200)).toBe(0.5);
  });

  it("returns null when equity <= 0", () => {
    expect(computeDebtToEquity(100, 0)).toBeNull();
    expect(computeDebtToEquity(100, -50)).toBeNull();
  });
});

describe("metrics — computeRoicPct", () => {
  it("computes ROIC correctly", () => {
    const result = computeRoicPct({
      operatingIncome: 100, pretaxIncome: 120, incomeTax: 24,
      totalDebt: 50, shareholdersEquity: 200, cash: 30, shortTermInvestments: 10,
    });
    expect(result.roicPct).toBeCloseTo(38.1, 0);
    expect(result.blocker).toBeNull();
  });

  it("returns null when tax rate is out of range", () => {
    const result = computeRoicPct({
      operatingIncome: 100, pretaxIncome: 100, incomeTax: 150,
      totalDebt: 50, shareholdersEquity: 200, cash: 30, shortTermInvestments: 10,
    });
    expect(result.roicPct).toBeNull();
    expect(result.blocker).toContain("tax rate out of range");
  });

  it("returns null when invested capital <= 0", () => {
    const result = computeRoicPct({
      operatingIncome: 100, pretaxIncome: 120, incomeTax: 24,
      totalDebt: 0, shareholdersEquity: 10, cash: 100, shortTermInvestments: 0,
    });
    expect(result.roicPct).toBeNull();
    expect(result.blocker).toContain("invested capital <= 0");
  });
});

describe("metrics — computeMarketCap", () => {
  it("computes market cap", () => {
    expect(computeMarketCap(150, 1e9)).toBe(150e9);
  });

  it("returns null when price <= 0", () => {
    expect(computeMarketCap(0, 1e9)).toBeNull();
  });
});

describe("metrics — computePeTtm", () => {
  it("computes P/E TTM", () => {
    expect(computePeTtm(150, 5)).toBe(30);
  });

  it("returns null when EPS <= 0", () => {
    expect(computePeTtm(150, 0)).toBeNull();
    expect(computePeTtm(150, -2)).toBeNull();
  });
});

describe("periods — deriveDiscreteQuarter", () => {
  const mk = (fy: number, fp: FiscalPeriod["fiscalPeriod"]): FiscalPeriod => ({
    fiscalYear: fy, fiscalPeriod: fp, periodStart: null, periodEnd: null, form: null, accession: null, filed: null,
  });

  it("derives Q2 = H1 - Q1", () => {
    const result = deriveDiscreteQuarter(200, 80, mk(2025, "H1"), mk(2025, "Q1"));
    expect(result.value).toBe(120);
    expect(result.derived).toBe(true);
    expect(result.derivation).toBe("H1-Q1");
  });

  it("returns null when fiscal years mismatch", () => {
    const result = deriveDiscreteQuarter(200, 80, mk(2025, "H1"), mk(2024, "Q1"));
    expect(result.value).toBeNull();
    expect(result.blockers[0]).toContain("fiscal year mismatch");
  });

  it("returns null when derived value is negative", () => {
    const result = deriveDiscreteQuarter(80, 200, mk(2025, "H1"), mk(2025, "Q1"));
    expect(result.value).toBeNull();
    expect(result.blockers[0]).toContain("negative");
  });
});

describe("periods — buildTtmFromQuarters", () => {
  const mk = (fy: number, fp: FiscalPeriod["fiscalPeriod"]): FiscalPeriod => ({
    fiscalYear: fy, fiscalPeriod: fp, periodStart: null, periodEnd: null, form: null, accession: null, filed: null,
  });

  it("builds TTM from 4 quarters", () => {
    const quarters = [
      { value: 100, period: mk(2025, "Q4") },
      { value: 90, period: mk(2025, "Q3") },
      { value: 80, period: mk(2025, "Q2") },
      { value: 70, period: mk(2025, "Q1") },
    ];
    const result = buildTtmFromQuarters(quarters);
    expect(result.value).toBe(340);
    expect(result.derivation).toBe("TTM-4Q");
  });

  it("returns null when fewer than 4 quarters", () => {
    const quarters = [
      { value: 100, period: mk(2025, "Q4") },
      { value: 90, period: mk(2025, "Q3") },
    ];
    const result = buildTtmFromQuarters(quarters);
    expect(result.value).toBeNull();
    expect(result.blockers[0]).toContain("4 discrete quarters");
  });
});

describe("periods — buildTtmFromYtdFallback", () => {
  const mk = (fy: number, fp: FiscalPeriod["fiscalPeriod"]): FiscalPeriod => ({
    fiscalYear: fy, fiscalPeriod: fp, periodStart: null, periodEnd: null, form: null, accession: null, filed: null,
  });

  it("computes TTM = FY + current YTD - prior YTD", () => {
    const result = buildTtmFromYtdFallback(400, 110, mk(2025, "H1"), 90, mk(2024, "H1"));
    expect(result.value).toBe(420);
    expect(result.derivation).toBe("FY+YTD-priorYTD");
  });

  it("returns null when prior YTD fiscal year is not current - 1", () => {
    const result = buildTtmFromYtdFallback(400, 110, mk(2025, "H1"), 90, mk(2023, "H1"));
    expect(result.value).toBeNull();
    expect(result.blockers[0]).toContain("fiscal year");
  });

  it("returns null when YTD periods mismatch", () => {
    const result = buildTtmFromYtdFallback(400, 110, mk(2025, "H1"), 90, mk(2024, "9M"));
    expect(result.value).toBeNull();
    expect(result.blockers[0]).toContain("YTD period mismatch");
  });
});
