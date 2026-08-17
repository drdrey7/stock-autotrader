import { describe, expect, it } from "vitest";
import {
  EPS_UNIT,
  REVENUE_UNIT,
  fetchTickerCikMap,
  parseCompanyFacts,
  resolveOfficialMetrics,
  selectOfficialMetric,
} from "./sec-xbrl";

/**
 * Fixture builder for one companyfacts payload. Values mirror the shapes seen
 * in production for US GAAP filers (10-Q/10-K flows with quarterly duration
 * facts, YTD and annual facts coexisting).
 */
interface FactInput {
  concept: string;
  unit?: string;
  start: string;
  end: string;
  val: number;
  fy: number;
  fp: string;
  form?: string;
  filed?: string;
  accn?: string;
}

function payload(cik: string, facts: FactInput[]): unknown {
  const byConcept = new Map<string, Record<string, Record<string, unknown>[]>>();
  for (const fact of facts) {
    const unit = fact.unit ?? EPS_UNIT;
    const conceptUnits = byConcept.get(fact.concept) ?? {};
    conceptUnits[unit] = conceptUnits[unit] ?? [];
    conceptUnits[unit]!.push({
      start: fact.start,
      end: fact.end,
      val: fact.val,
      fy: fact.fy,
      fp: fact.fp,
      form: fact.form ?? "10-Q",
      filed: fact.filed ?? `${fact.end.slice(0, 4)}-07-2${String(fact.fy % 10)}`,
      accn: fact.accn ?? `0000320193-26-0000${(fact.fy % 10) * 10 + 1}`,
      frame: `${fact.end.slice(0, 4)}${fact.fp}`,
    });
    byConcept.set(fact.concept, conceptUnits);
  }
  return {
    cik: Number(cik),
    entityName: "Fixture Corp",
    facts: {
      "us-gaap": Object.fromEntries(
        [...byConcept.entries()].map(([concept, units]) => [concept, { units }]),
      ),
    },
  };
}

/** AAPL-shaped facts: FY2026 Q3 (Jun 27 end), quarterly + YTD + annual facts all present. */
function appleQ3Facts(): FactInput[] {
  return [
    // Quarterly GAAP diluted EPS — the target fact.
    { concept: "EarningsPerShareDiluted", start: "2026-03-29", end: "2026-06-27", val: 1.63, fy: 2026, fp: "Q3", form: "10-Q" },
    // YTD (9-month) diluted EPS for the same quarter — must be rejected.
    { concept: "EarningsPerShareDiluted", start: "2025-09-28", end: "2026-06-27", val: 4.89, fy: 2026, fp: "Q3", form: "10-Q" },
    // Annual diluted EPS (12 months) — must be rejected.
    { concept: "EarningsPerShareDiluted", start: "2025-09-28", end: "2026-09-26", val: 6.5, fy: 2026, fp: "FY", form: "10-K" },
    // Raw revenue — quarterly (target) + YTD (rejected) + annual (rejected).
    { concept: "RevenueFromContractWithCustomerExcludingAssessedTax", start: "2026-03-29", end: "2026-06-27", val: 117_441_000_000, fy: 2026, fp: "Q3", form: "10-Q", unit: REVENUE_UNIT },
    { concept: "RevenueFromContractWithCustomerExcludingAssessedTax", start: "2025-09-28", end: "2026-06-27", val: 322_301_000_000, fy: 2026, fp: "Q3", form: "10-Q", unit: REVENUE_UNIT },
    { concept: "RevenueFromContractWithCustomerExcludingAssessedTax", start: "2025-09-28", end: "2026-09-26", val: 442_000_000_000, fy: 2026, fp: "FY", form: "10-K", unit: REVENUE_UNIT },
  ];
}

const identity = { fiscalYear: 2026, fiscalQuarter: 3, scheduledDate: "2026-07-30", fiscalPeriodEnd: "2026-06-27" };

describe("parseCompanyFacts", () => {
  it("flattens us-gaap facts with units, fiscal period and filing metadata", () => {
    const parsed = parseCompanyFacts(payload("320193", appleQ3Facts()));
    expect(parsed.cik).toBe("0000320193");
    expect(parsed.facts).toHaveLength(6);
    const quarterly = parsed.facts.find((fact) => fact.end === "2026-06-27" && fact.val === 1.63);
    expect(quarterly).toMatchObject({ concept: "EarningsPerShareDiluted", unit: EPS_UNIT, fp: "Q3", fy: 2026, form: "10-Q" });
  });

  it("rejects malformed payloads without throwing", () => {
    expect(parseCompanyFacts(null).warnings.length).toBeGreaterThan(0);
    expect(parseCompanyFacts({}).warnings.length).toBeGreaterThan(0);
    expect(parseCompanyFacts({ facts: { "dei": {} } }).warnings.length).toBeGreaterThan(0);
  });
});

describe("selectOfficialMetric — EPS diluted (GAAP)", () => {
  it("picks the quarterly diluted EPS and rejects YTD and annual facts", () => {
    const parsed = parseCompanyFacts(payload("320193", appleQ3Facts()));
    const selection = selectOfficialMetric(parsed, ["EarningsPerShareDiluted"], EPS_UNIT, identity);
    expect(selection).toMatchObject({ value: 1.63, concept: "EarningsPerShareDiluted", periodEnd: "2026-06-27", fiscalPeriod: "Q3", confidence: "high" });
    expect(selection.blockers).toEqual([]);
  });

  it("rejects a fact for the wrong fiscal quarter", () => {
    const parsed = parseCompanyFacts(payload("320193", [
      { concept: "EarningsPerShareDiluted", start: "2025-12-28", end: "2026-03-28", val: 1.81, fy: 2026, fp: "Q2", form: "10-Q" },
    ]));
    const selection = selectOfficialMetric(parsed, ["EarningsPerShareDiluted"], EPS_UNIT, identity);
    expect(selection.value).toBeNull();
    expect(selection.blockers.join(" ")).toMatch(/fiscal identity/);
  });

  it("rejects an annual-only EPS fact (no quarterly standalone exists)", () => {
    const parsed = parseCompanyFacts(payload("320193", [
      { concept: "EarningsPerShareDiluted", start: "2025-09-28", end: "2026-09-26", val: 6.5, fy: 2026, fp: "FY", form: "10-K" },
    ]));
    const selection = selectOfficialMetric(parsed, ["EarningsPerShareDiluted"], EPS_UNIT, identity);
    expect(selection.value).toBeNull();
    // The FY fact never passes the quarterly filters — either blocker is fine.
    expect(selection.blockers.join(" ")).toMatch(/fiscal identity|non-quarterly/);
  });

  it("rejects a wrong-unit fact (basic-share count in shares unit)", () => {
    const parsed = parseCompanyFacts(payload("320193", [
      { concept: "EarningsPerShareDiluted", start: "2026-03-29", end: "2026-06-27", val: 1.63, fy: 2026, fp: "Q3", unit: "shares", form: "10-Q" },
    ]));
    const selection = selectOfficialMetric(parsed, ["EarningsPerShareDiluted"], EPS_UNIT, identity);
    expect(selection.value).toBeNull();
    expect(selection.blockers.join(" ")).toMatch(/unit USD\/shares/);
  });

  it("rejects a continuing-operations-only concept when the required concept is absent", () => {
    const parsed = parseCompanyFacts(payload("320193", [
      { concept: "EarningsPerShareDiluted", start: "2026-03-29", end: "2026-06-27", val: 1.6, fy: 2026, fp: "Q3", form: "10-Q" },
    ]));
    // Resolution only accepts the explicit explicit list; a derivative concept
    // listed under a different name is NOT silently substituted.
    const selection = selectOfficialMetric(parsed, ["EarningsPerShareDiluted"], EPS_UNIT, identity);
    expect(selection.value).toBe(1.6);
    const strict = selectOfficialMetric(parsed, ["ContinuingOperationsEarningsPerShareDiluted"], EPS_UNIT, identity);
    expect(strict.value).toBeNull();
    expect(strict.blockers.join(" ")).toMatch(/no ContinuingOperationsEarningsPerShareDiluted facts/);
  });

  it("dedupes a duplicate context preferring the amendment when values agree", () => {
    const parsed = parseCompanyFacts(payload("320193", [
      { concept: "EarningsPerShareDiluted", start: "2026-03-29", end: "2026-06-27", val: 1.63, fy: 2026, fp: "Q3", form: "10-Q", accn: "0000320193-26-000101", filed: "2026-07-29" },
      { concept: "EarningsPerShareDiluted", start: "2026-03-29", end: "2026-06-27", val: 1.63, fy: 2026, fp: "Q3", form: "10-Q/A", accn: "0000320193-26-000102", filed: "2026-08-10" },
    ]));
    const selection = selectOfficialMetric(parsed, ["EarningsPerShareDiluted"], EPS_UNIT, identity);
    expect(selection.value).toBe(1.63);
    // Amendment is the operative filing for the period; identical value → high confidence.
    expect(selection.accn).toBe("0000320193-26-000102");
    expect(selection.form).toBe("10-Q/A");
    expect(selection.confidence).toBe("high");
  });

  it("prefers a restated amendment value over the superseded original (B1 regression)", () => {
    const parsed = parseCompanyFacts(payload("320193", [
      { concept: "EarningsPerShareDiluted", start: "2026-03-29", end: "2026-06-27", val: 1.63, fy: 2026, fp: "Q3", form: "10-Q", accn: "0000320193-26-000101", filed: "2026-07-29" },
      { concept: "EarningsPerShareDiluted", start: "2026-03-29", end: "2026-06-27", val: 1.45, fy: 2026, fp: "Q3", form: "10-Q/A", accn: "0000320193-26-000103", filed: "2026-08-10" },
    ]));
    const selection = selectOfficialMetric(parsed, ["EarningsPerShareDiluted"], EPS_UNIT, identity);
    // The restated value supersedes the original — it must NEVER write 1.63.
    expect(selection.value).toBe(1.45);
    expect(selection.form).toBe("10-Q/A");
    expect(selection.confidence).toBe("medium");
    expect(selection.blockers.join(" ")).toMatch(/amended\/restated/);
  });

  it("flags conflicting values for the same period instead of picking one", () => {
    const parsed = parseCompanyFacts(payload("320193", [
      { concept: "EarningsPerShareDiluted", start: "2026-03-29", end: "2026-06-27", val: 1.63, fy: 2026, fp: "Q3", form: "10-Q", accn: "0000320193-26-000101", filed: "2026-07-29" },
      { concept: "EarningsPerShareDiluted", start: "2026-03-29", end: "2026-06-27", val: 1.62, fy: 2026, fp: "Q3", form: "10-Q", accn: "0000320193-26-000102", filed: "2026-08-02" },
    ]));
    const selection = selectOfficialMetric(parsed, ["EarningsPerShareDiluted"], EPS_UNIT, identity);
    expect(selection.value).toBeNull();
    expect(selection.blockers.join(" ")).toMatch(/conflicting/);
  });

  it("accepts an 8-K exhibit fact as a medium-confidence last resort for Q4", () => {
    const parsed = parseCompanyFacts(payload("320193", [
      { concept: "EarningsPerShareDiluted", start: "2026-06-28", end: "2026-09-26", val: 2.1, fy: 2026, fp: "Q4", form: "8-K", filed: "2026-10-30" },
    ]));
    const selection = selectOfficialMetric(parsed, ["EarningsPerShareDiluted"], EPS_UNIT, { fiscalYear: 2026, fiscalQuarter: 4, scheduledDate: "2026-10-30", fiscalPeriodEnd: "2026-09-26" });
    expect(selection.value).toBe(2.1);
    expect(selection.confidence).toBe("medium");
  });
});

describe("selectOfficialMetric — revenue (GAAP quarterly, never YTD)", () => {
  it("returns the quarterly GAAP revenue and ignores YTD/annual rows", () => {
    const parsed = parseCompanyFacts(payload("320193", appleQ3Facts()));
    const selection = selectOfficialMetric(parsed, ["RevenueFromContractWithCustomerExcludingAssessedTax"], REVENUE_UNIT, identity);
    expect(selection.value).toBe(117_441_000_000);
    expect(selection.periodEnd).toBe("2026-06-27");
    expect(selection.confidence).toBe("high");
  });

  it("falls back through the revenue concept chain when the preferred concept is absent", () => {
    const facts: FactInput[] = [
      { concept: "RevenueFromContractWithCustomerIncludingAssessedTax", start: "2026-03-29", end: "2026-06-27", val: 117_500_000_000, fy: 2026, fp: "Q3", form: "10-Q", unit: REVENUE_UNIT },
    ];
    const parsed = parseCompanyFacts(payload("320193", facts));
    const selection = selectOfficialMetric(parsed, [
      "RevenueFromContractWithCustomerExcludingAssessedTax",
      "RevenueFromContractWithCustomerIncludingAssessedTax",
      "Revenues",
    ], REVENUE_UNIT, identity);
    expect(selection.value).toBe(117_500_000_000);
    expect(selection.concept).toBe("RevenueFromContractWithCustomerIncludingAssessedTax");
  });

  it("never substitutes a YTD revenue when the quarterly value is missing", () => {
    const parsed = parseCompanyFacts(payload("320193", [
      { concept: "RevenueFromContractWithCustomerExcludingAssessedTax", start: "2025-09-28", end: "2026-06-27", val: 322_301_000_000, fy: 2026, fp: "Q3", form: "10-Q", unit: REVENUE_UNIT },
    ]));
    const selection = selectOfficialMetric(parsed, ["RevenueFromContractWithCustomerExcludingAssessedTax"], REVENUE_UNIT, identity);
    expect(selection.value).toBeNull();
    expect(selection.blockers.join(" ")).toMatch(/non-quarterly/);
  });
});

describe("resolveOfficialMetrics", () => {
  it("resolves both EPS and revenue with a shared period end", () => {
    const parsed = parseCompanyFacts(payload("320193", appleQ3Facts()));
    const resolved = resolveOfficialMetrics(parsed, identity);
    expect(resolved.eps.value).toBe(1.63);
    expect(resolved.revenue.value).toBe(117_441_000_000);
    expect(resolved.periodEnd).toBe("2026-06-27");
    expect(resolved.source).toBe("sec-xbrl");
  });

  it("leaves nullable official metrics unresolved for a foreign/no-quarterly issuer", () => {
    // Foreign issuers file 20-F annuals; quarterly GAAP facts are absent.
    const parsed = parseCompanyFacts(payload("1234567", [
      { concept: "EarningsPerShareDiluted", start: "2026-01-01", end: "2026-12-31", val: 2.5, fy: 2026, fp: "FY", form: "20-F" },
      { concept: "RevenueFromContractWithCustomerExcludingAssessedTax", start: "2026-01-01", end: "2026-12-31", val: 50_000_000_000, fy: 2026, fp: "FY", form: "20-F", unit: REVENUE_UNIT },
    ]));
    const resolved = resolveOfficialMetrics(parsed, identity);
    expect(resolved.eps.value).toBeNull();
    expect(resolved.revenue.value).toBeNull();
  });
});

describe("fetchTickerCikMap", () => {
  it("maps ticker -> zero-padded CIK from the SEC exchange file", async () => {
    const response = new Response(JSON.stringify({
      fields: ["cik", "name", "ticker", "exchange"],
      data: [
        [320193, "Apple Inc.", "AAPL", "NASDAQ"],
        [1045810, "NVIDIA CORP", "NVDA", "NASDAQ"],
      ],
    }), { status: 200, headers: { "content-type": "application/json" } });
    const map = await fetchTickerCikMap({ fetcher: async () => response });
    expect(map.get("AAPL")).toBe("0000320193");
    expect(map.get("NVDA")).toBe("0001045810");
    expect(map.has("NOPE")).toBe(false);
  });

  it("throws on a malformed tickers payload", async () => {
    const response = new Response(JSON.stringify({ data: [[1, "X"]] }), { status: 200 });
    await expect(fetchTickerCikMap({ fetcher: async () => response })).rejects.toThrow(/malformed/);
  });
});