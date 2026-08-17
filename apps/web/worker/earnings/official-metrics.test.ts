import { describe, expect, it } from "vitest";
import type { ResolvedOfficialMetrics } from "./sec-xbrl";
import {
  buildAuditRow,
  EPS_MATCH_TOLERANCE,
  REVENUE_MATCH_TOLERANCE_REL,
  SOURCE_FINNHUB_ADJUSTED,
  SOURCE_SEC_XBRL,
} from "./official-metrics";
import type { AuditInput } from "./official-metrics";

const official = (overrides: Partial<ResolvedOfficialMetrics> = {}): ResolvedOfficialMetrics => ({
  eps: {
    value: 1.91,
    concept: "EarningsPerShareDiluted",
    unit: "USD/shares",
    accn: "0000320193-26-000101",
    form: "10-Q",
    filed: "2026-07-29",
    periodEnd: "2026-06-27",
    periodStart: "2026-03-29",
    fiscalYear: 2026,
    fiscalPeriod: "Q3",
    confidence: "high",
    blockers: [],
  },
  revenue: {
    value: 117_441_000_000,
    concept: "RevenueFromContractWithCustomerExcludingAssessedTax",
    unit: "USD",
    accn: "0000320193-26-000101",
    form: "10-Q",
    filed: "2026-07-29",
    periodEnd: "2026-06-27",
    periodStart: "2026-03-29",
    fiscalYear: 2026,
    fiscalPeriod: "Q3",
    confidence: "high",
    blockers: [],
  },
  periodEnd: "2026-06-27",
  source: "sec-xbrl",
  ...overrides,
});

const input = (overrides: Partial<AuditInput> = {}): AuditInput => ({
  symbol: "AAPL",
  company: "Apple Inc.",
  cik: "0000320193",
  eventId: "AAPL-2026-Q3",
  scheduledDate: "2026-07-30",
  fiscalYear: 2026,
  fiscalQuarter: 3,
  fiscalPeriodEnd: "2026-06-27",
  status: "reported",
  providerEpsActual: 1.91,
  // Provider (adjusted) revenue equals the official GAAP revenue so the
  // default fixture is a clean MATCH; DIFFERENT_BASIS tests override one side.
  providerRevenueActual: 117_441_000_000,
  epsEstimate: 1.9271,
  revenueEstimate: 110_823_804_698,
  official: official(),
  filing: {
    url: "https://www.sec.gov/Archives/edgar/data/320193/000032019326000101/0000320193-26-000101-index.html",
    accession: "0000320193-26-000101",
    form: "10-Q",
    filedAt: "2026-07-29T13:00:00.000Z",
  },
  ...overrides,
});

const updatedAt = "2026-08-17T06:00:00.000Z";

describe("buildAuditRow — decision matrix", () => {
  it("decides MATCH when provider actuals equal official GAAP within tolerance", () => {
    const row = buildAuditRow(input(), updatedAt);
    expect(row.decision).toBe("match");
    expect(row.confidence).toBe("high");
    expect(row.comparison.eps.basisMismatch).toBe(false);
    expect(row.comparison.revenue.basisMismatch).toBe(false);
    expect(row.write?.epsActualGaap).toBe(1.91);
    expect(row.write?.epsActualGaapSource).toBe(SOURCE_SEC_XBRL);
    expect(row.write?.epsActualAdjusted).toBe(1.91);
    expect(row.write?.epsActualAdjustedSource).toBe(SOURCE_FINNHUB_ADJUSTED);
    expect(row.write?.revenueActualOfficial).toBe(117_441_000_000);
    expect(row.write?.revenueActualSource).toBe(SOURCE_SEC_XBRL);
  });

  it("decides DIFFERENT_BASIS when the provider adjusted EPS differs from GAAP (AAPL fixture)", () => {
    // AAPL: Finnhub actual (adjusted) 1.91 vs official GAAP diluted 1.63.
    const gaap = official({ eps: { ...official().eps, value: 1.63 } });
    const aaplRow = buildAuditRow(input({ official: gaap }), updatedAt);
    expect(aaplRow.decision).toBe("different-basis");
    expect(aaplRow.comparison.eps.diff).toBeCloseTo(0.28, 4);
    expect(aaplRow.write?.epsActualGaap).toBe(1.63);
    // Both bases stay separate — never collapsed into one ambiguous number.
    expect(aaplRow.write?.epsActualAdjusted).toBe(1.91);
    expect(aaplRow.write?.epsActualGaap).not.toBe(aaplRow.write?.epsActualAdjusted);
  });

  it("decides DIFFERENT_BASIS from the revenue side only (AMD-shaped fixture)", () => {
    const row = buildAuditRow(input({
      symbol: "AMD",
      company: "Advanced Micro Devices Inc",
      eventId: "AMD-2026-Q2",
      scheduledDate: "2026-08-04",
      fiscalYear: 2026,
      fiscalQuarter: 2,
      providerEpsActual: 1.66,
      providerRevenueActual: 11_536_000_000,
      epsEstimate: 1.6313,
      revenueEstimate: 11_396_426_778,
      official: official({
        eps: { ...official().eps, value: 1.62, periodEnd: "2026-06-27", fiscalPeriod: "Q2" },
        revenue: { ...official().revenue, value: 11_290_000_000, periodEnd: "2026-06-27", fiscalPeriod: "Q2" },
        periodEnd: "2026-06-27",
      }),
    }), updatedAt);
    expect(row.decision).toBe("different-basis");
  });

  it("decides OFFICIAL_ONLY when no provider actual exists but official GAAP resolved", () => {
    const row = buildAuditRow(input({ providerEpsActual: null, providerRevenueActual: null }), updatedAt);
    expect(row.decision).toBe("official-only");
    expect(row.write?.epsActualGaap).toBe(1.91);
    expect(row.write?.epsActualAdjusted).toBeNull();
  });

  it("decides FINNHUB_ONLY when SEC is unresolved but provider actuals exist (COIN-shaped fixture)", () => {
    const row = buildAuditRow(input({
      symbol: "COIN",
      company: "Coinbase Global Inc",
      eventId: "COIN-2026-Q2",
      scheduledDate: "2026-07-30",
      fiscalYear: 2026,
      fiscalQuarter: 2,
      providerEpsActual: -1.17,
      providerRevenueActual: 1_220_068_000,
      epsEstimate: -0.1735,
      revenueEstimate: 1_337_471_491,
      official: null,
    }), updatedAt);
    expect(row.decision).toBe("finnhub-only");
    expect(row.write?.epsActualGaap).toBeNull();
    expect(row.write?.epsActualAdjusted).toBe(-1.17);
    expect(row.write?.dataQualityStatus).toBe("finnhub-only");
  });

  it("decides PENDING for NVDA (upcoming event) and never fabricates actuals", () => {
    const row = buildAuditRow(input({
      symbol: "NVDA",
      company: "NVIDIA Corp",
      eventId: "NVDA-2027-Q2",
      scheduledDate: "2026-08-26",
      fiscalYear: 2027,
      fiscalQuarter: 2,
      status: "scheduled",
      providerEpsActual: null,
      providerRevenueActual: null,
      epsEstimate: 2.1283,
      revenueEstimate: 93_634_391_959,
      official: null,
    }), updatedAt);
    expect(row.decision).toBe("pending");
    expect(row.write).toBeNull();
    expect(row.reasons.join(" ")).toMatch(/upcoming/);
    // The audit target is the latest REPORTED event; a scheduled event is
    // never a write target, so NVDA stays clean.
    expect(row.sec.gaapDilutedEps).toBeNull();
  });

  it("decides UNRESOLVED when neither provider actuals nor official facts exist", () => {
    const row = buildAuditRow(input({
      status: "reported",
      providerEpsActual: null,
      providerRevenueActual: null,
      official: null,
    }), updatedAt);
    expect(row.decision).toBe("unresolved");
    expect(row.write).toBeNull();
  });

  it("surfaces CONFLICT when SEC facts disagree with the event fiscal identity", () => {
    const conflicting = official({
      eps: { ...official().eps, value: null, confidence: "low", blockers: ["no facts matching fiscal identity 2026 Q3 (facts span 2026:Q2)"] },
      revenue: { ...official().revenue, value: null, confidence: "low", blockers: ["no facts matching fiscal identity 2026 Q3 (facts span 2026:Q2)"] },
    });
    const row = buildAuditRow(input({ official: conflicting }), updatedAt);
    expect(row.decision).toBe("conflict");
    expect(row.write?.dataQualityStatus).toBe("conflict");
    // Never write a guessed GAAP value into a conflict.
    expect(row.write?.epsActualGaap).toBeNull();
  });

  it("does not downgrade a resolved decision when the same event is re-audited", () => {
    const first = buildAuditRow(input({ official: official({ eps: { ...official().eps, value: 1.63 } }) }), updatedAt);
    expect(first.decision).toBe("different-basis");
    // Re-running with identical input stays identical (idempotent by design).
    const second = buildAuditRow(input({ official: official({ eps: { ...official().eps, value: 1.63 } }) }), updatedAt);
    expect(second.decision).toBe(first.decision);
    expect(second.write).toEqual(first.write);
  });

  it("keeps legacy eps_actual/revenue_actual out of the official write payload", () => {
    const row = buildAuditRow(input(), updatedAt);
    expect(row.write).not.toHaveProperty("epsActual");
    expect(row.write).not.toHaveProperty("revenueActual");
  });
});

describe("revenue definition guard (SOFI-shaped fixture)", () => {
  it("surfaces a definitional revenue mismatch and leaves revenueActualOfficial null", () => {
    // SoFi: the XBRL "revenue from contracts with customers" (153.6M) is a
    // small slice of total net revenue (1.2B). The fact is real but is NOT
    // quarterly total revenue — it must not be stamped as canonical.
    const row = buildAuditRow(input({
      symbol: "SOFI",
      company: "SoFi Technologies Inc",
      eventId: "SOFI-2026-Q2",
      scheduledDate: "2026-07-29",
      fiscalYear: 2026,
      fiscalQuarter: 2,
      providerRevenueActual: 1_205_550_000,
      revenueEstimate: 1_337_471_491,
      official: official({
        eps: { ...official().eps, value: 0.12, periodEnd: "2026-06-30", fiscalPeriod: "Q2" },
        revenue: { ...official().revenue, value: 153_577_000, periodEnd: "2026-06-30", fiscalPeriod: "Q2" },
        periodEnd: "2026-06-30",
      }),
    }), updatedAt);
    expect(row.decision).toBe("different-basis");
    expect(row.reasons.join(" ")).toMatch(/revenue concept does not match provider total revenue/);
    // The EPS GAAP value is still valid and written; revenue official is NOT.
    expect(row.write?.epsActualGaap).toBe(0.12);
    expect(row.write?.revenueActualOfficial).toBeNull();
    expect(row.write?.revenueActualSource).toBeNull();
  });

  it("keeps official revenue within the definitional band (META-shaped fixture)", () => {
    const row = buildAuditRow(input({
      symbol: "META",
      company: "Meta Platforms Inc",
      eventId: "META-2026-Q2",
      scheduledDate: "2026-07-29",
      fiscalYear: 2026,
      fiscalQuarter: 2,
      providerEpsActual: 6.18,
      providerRevenueActual: 60_801_000_000,
      revenueEstimate: 60_000_000_000,
      official: official({
        eps: { ...official().eps, value: 6.18, periodEnd: "2026-06-30", fiscalPeriod: "Q2" },
        revenue: { ...official().revenue, value: 60_801_000_000, periodEnd: "2026-06-30", fiscalPeriod: "Q2" },
        periodEnd: "2026-06-30",
      }),
    }), updatedAt);
    expect(row.decision).toBe("match");
    expect(row.write?.revenueActualOfficial).toBe(60_801_000_000);
  });
});

describe("tolerances", () => {
  it("uses a 2-cent EPS band and a 1% revenue band", () => {
    expect(EPS_MATCH_TOLERANCE).toBe(0.02);
    expect(REVENUE_MATCH_TOLERANCE_REL).toBe(0.01);
    const epsFacts = {
      ...official().eps,
      value: 1.925,
    };
    const revenueFacts = {
      ...official().revenue,
      value: 117_441_000_000,
    };
    const row = buildAuditRow(input({
      providerEpsActual: 1.93, // +0.005 within the 2c band
      providerRevenueActual: 118_610_000_000, // +0.996% within the 1% band
      official: official({ eps: epsFacts, revenue: revenueFacts }),
    }), updatedAt);
    expect(row.decision).toBe("match");

    const miss = buildAuditRow(input({
      providerEpsActual: 1.96, // +0.035 → beyond the 2c band
      providerRevenueActual: 124_000_000_000, // +5.6% → beyond the 1% band
      official: official({ eps: epsFacts, revenue: revenueFacts }),
    }), updatedAt);
    expect(miss.decision).toBe("different-basis");
  });
});

describe("audit pipeline is data-driven (no ticker hardcoding)", () => {
  it("produces the same decision for differently-named symbols with identical shapes", () => {
    const options = (symbol: string): Partial<AuditInput> => ({
      symbol,
      company: `${symbol} Inc`,
      eventId: `${symbol}-2026-Q3`,
      providerEpsActual: 1.91,
      official: official({ eps: { ...official().eps, value: 1.63 } }),
    });
    const aapl = buildAuditRow(input(options("AAPL")), updatedAt);
    const xyz = buildAuditRow(input(options("XYZ")), updatedAt);
    expect(aapl.decision).toBe("different-basis");
    expect(xyz.decision).toBe("different-basis");
    expect(aapl.write?.epsActualGaap).toBe(xyz.write?.epsActualGaap);
  });
});