import { describe, expect, it, vi } from "vitest";
import { periodToRow, upsertPeriod, type Database } from "../src/storage";
import type { NormalizedPeriod } from "../src/normalize";

function period(): NormalizedPeriod {
  return {
    symbol: "ADBE",
    fiscalYear: 2026,
    fiscalPeriod: "Q2",
    periodStart: "2026-03-01",
    periodEnd: "2026-05-31",
    filingDate: "2026-06-15",
    form: "10-Q",
    accession: "0000000000-26-000001",
    taxonomy: "us-gaap",
    currency: "USD",
    fields: {
      revenue: {
        value: 100,
        concept: "RevenueFromContractWithCustomerExcludingAssessedTax",
        unit: "USD",
        accn: "0000000000-26-000001",
        form: "10-Q",
        filed: "2026-06-15",
        periodEnd: "2026-05-31",
        periodStart: "2026-03-01",
        fiscalYear: 2026,
        fiscalPeriod: "Q2",
        taxonomy: "us-gaap",
        blockers: ["derived: Q2 = H1 − Q1"],
        derived: true,
        derivation: "H1−Q1",
      },
    },
    missingFields: [],
    blockers: [],
  };
}

describe("fundamentals storage", () => {
  it("persists derived-field provenance instead of relabeling it direct", () => {
    const row = periodToRow(period(), {
      freeCashFlow: null,
      fcfMarginPct: null,
      debtToEquity: null,
      roicPct: null,
    }, "2026-08-22T00:00:00.000Z");
    const provenance = JSON.parse(row.provenance_json) as Record<string, Record<string, unknown>>;
    expect(provenance.revenue).toMatchObject({ derived: true, derivation: "H1−Q1", unit: "USD" });
  });

  it("updates period metadata and currency on a restatement upsert", async () => {
    const statement = {
      bind: vi.fn().mockReturnThis(),
      run: vi.fn().mockResolvedValue({ success: true }),
    };
    const prepare = vi.fn().mockReturnValue(statement);
    const db = { prepare } as unknown as Database;
    await upsertPeriod(db, periodToRow(period(), {
      freeCashFlow: null,
      fcfMarginPct: null,
      debtToEquity: null,
      roicPct: null,
    }, "2026-08-22T00:00:00.000Z"));
    expect(String(prepare.mock.calls[0]?.[0])).toContain("period_start = excluded.period_start");
    expect(String(prepare.mock.calls[0]?.[0])).toContain("period_end = excluded.period_end");
    expect(String(prepare.mock.calls[0]?.[0])).toContain("currency = excluded.currency");
  });
});
