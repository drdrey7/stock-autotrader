import { describe, expect, it } from "vitest";
import {
  calculateMarketMetric,
  dataQualityLabel,
  eventWithViewMetadata,
  formatFilingDate,
  marketEarningsView,
  officialEarningsView,
  releaseTimestamp,
  sourceLabel,
} from "./data/earnings-view";

/**
 * Market vs Official separation at the read/view layer.
 *
 * Contracts proven here:
 *  1. A market Beat/Miss only ever combines Finnhub estimate with Finnhub actual.
 *  2. SEC GAAP actuals are NEVER folded into the market comparison.
 *  3/4. AAPL/AMD different-basis events keep adjusted (market) and GAAP (official) separate.
 *  7. A sec-filing reportedAt is never presented as an earnings-release timestamp.
 *  10. Missing SEC data is a clean N/A state (hasAny === false).
 *  13. Raw internal provenance tokens map to friendly user copy.
 *  14. The API contract round-trips both market and official fields and stays
 *      backwards compatible with payloads that predate PR #63.
 */

describe("marketEarningsView — Finnhub-only Beat/Miss", () => {
  it("combines Finnhub estimate with Finnhub adjusted actual (beat/miss/mixed)", () => {
    const miss = eventWithViewMetadata({
      symbol: "AAPL", company: "Apple", status: "reported",
      epsEstimate: 1.9271, epsActual: 1.91, epsActualAdjusted: 1.91, epsActualAdjustedSource: "finnhub-adjusted",
      epsSurprisePct: -0.89, epsResult: "Miss",
      revenueEstimate: 110_823_804_698, revenueActual: 109_417_000_000, revenueResult: "Miss",
      overallResult: "Miss",
    });
    const market = marketEarningsView(miss);
    expect(market.epsActual).toBe(1.91);
    expect(market.epsEstimate).toBe(1.9271);
    expect(market.epsResult).toBe("Miss");
    expect(market.comparable).toBe(true);
    expect(miss.result).toBe("Miss");

    const beat = eventWithViewMetadata({
      symbol: "AMD", company: "AMD", status: "reported",
      epsEstimate: 1.6313, epsActual: 1.66, epsActualAdjusted: 1.66, epsActualAdjustedSource: "finnhub-adjusted",
      epsSurprisePct: 1.76, epsResult: "Beat",
      revenueEstimate: 11_396_426_778, revenueActual: 11_536_000_000, revenueResult: "Beat",
      overallResult: "Beat",
    });
    expect(marketEarningsView(beat)).toMatchObject({ epsResult: "Beat", overallResult: "Beat", comparable: true });
  });

  it("prefers the explicit adjusted actual and keeps Result on the same basis", () => {
    const event = eventWithViewMetadata({
      symbol: "TST", status: "reported",
      epsEstimate: 1, epsActual: 0.9, epsActualAdjusted: 1.1, epsActualAdjustedSource: "finnhub-adjusted",
      epsResult: "Beat", revenueResult: "Not Available", overallResult: "Not Available",
    });
    const market = marketEarningsView(event);
    // Displayed Actual, Surprise and Result all derive from the adjusted pair —
    // the drawer can never show an Actual that contradicts its Result.
    expect(market.epsActual).toBe(1.1);
    expect(market.epsSurprisePct).toBeCloseTo(10, 6);
    expect(market.epsResult).toBe("Beat");
  });

  it("calculateMarketMetric derives Beat/Miss/Met strictly from the shown pair", () => {
    expect(calculateMarketMetric(1.1, 1)).toMatchObject({ actual: 1.1, estimate: 1, result: "Beat" });
    expect(calculateMarketMetric(1.1, 1).surprisePct).toBeCloseTo(10, 6);
    expect(calculateMarketMetric(0.9, 1).result).toBe("Miss");
    expect(calculateMarketMetric(1, 1)).toMatchObject({ result: "In Line", surprisePct: 0 });
    // Never a result from a missing pair, and never from GAAP actuals.
    expect(calculateMarketMetric(null, 1).result).toBe("Not Available");
    expect(calculateMarketMetric(1.1, null).result).toBe("Not Available");
    expect(calculateMarketMetric(Number.NaN, 1).result).toBe("Not Available");
  });

  it("NEVER folds SEC GAAP actuals into the market comparison", () => {
    // AAPL-shaped: Finnhub estimate + GAAP actual ONLY (no Finnhub market actual).
    const gaapOnly = eventWithViewMetadata({
      symbol: "AAPL", company: "Apple", status: "reported",
      epsEstimate: 1.9271, epsActual: null, epsActualAdjusted: null,
      epsActualGaap: 2.02, epsActualGaapSource: "sec-xbrl",
      epsResult: "Not Available", revenueResult: "Not Available", overallResult: "Not Available",
    });
    const market = marketEarningsView(gaapOnly);
    // The market actual slot must stay empty: the SEC GAAP value is never
    // presented as the Finnhub market actual.
    expect(market.epsActual).toBeNull();
    expect(market.epsResult).toBe("Not Available");
    expect(market.overallResult).toBe("Not Available");
    expect(market.comparable).toBe(false);
    // The GAAP value does live in the official view.
    expect(officialEarningsView(gaapOnly).epsGaap).toBe(2.02);
  });
});

describe("different-basis events keep adjusted and GAAP separate (AAPL / AMD)", () => {
  const aapl = eventWithViewMetadata({
    symbol: "AAPL", company: "Apple", status: "reported",
    epsEstimate: 1.9271, epsActual: 1.91, epsActualAdjusted: 1.91, epsActualAdjustedSource: "finnhub-adjusted",
    epsSurprisePct: -0.89, epsResult: "Miss",
    revenueEstimate: 110_823_804_698, revenueActual: 109_417_000_000, revenueResult: "Miss",
    overallResult: "Miss",
    epsActualGaap: 2.02, epsActualGaapSource: "sec-xbrl",
    revenueActualOfficial: 109_417_000_000, revenueActualSource: "sec-xbrl",
    dataQualityStatus: "different-basis",
    secForm: "10-Q", secFiledAt: "2026-07-31T00:00:00.000Z",
    secFilingUrl: "https://www.sec.gov/Archives/edgar/data/320193/000032019326000020/0000320193-26-000020-index.html",
  });
  const amd = eventWithViewMetadata({
    symbol: "AMD", company: "AMD", status: "reported",
    epsEstimate: 1.6313, epsActual: 1.66, epsActualAdjusted: 1.66, epsActualAdjustedSource: "finnhub-adjusted",
    epsSurprisePct: 1.76, epsResult: "Beat",
    revenueEstimate: 11_396_426_778, revenueActual: 11_536_000_000, revenueResult: "Beat",
    overallResult: "Beat",
    epsActualGaap: 1.38, epsActualGaapSource: "sec-xbrl",
    revenueActualOfficial: 11_536_000_000, revenueActualSource: "sec-xbrl",
    dataQualityStatus: "different-basis",
  });

  it("AAPL keeps market adjusted 1.91 and official GAAP 2.02 apart", () => {
    const market = marketEarningsView(aapl);
    const official = officialEarningsView(aapl);
    expect(market.epsActual).toBe(1.91);
    expect(official.epsGaap).toBe(2.02);
    // Never a market Beat/Miss derived from 2.02 against the Finnhub estimate.
    expect(market.epsResult).toBe("Miss");
    expect(dataQualityLabel(aapl.dataQualityStatus)).toBe("GAAP and adjusted results differ");
  });

  it("AMD keeps market adjusted 1.66 and official GAAP 1.38 apart with a market Beat", () => {
    const market = marketEarningsView(amd);
    const official = officialEarningsView(amd);
    expect(market.epsActual).toBe(1.66);
    expect(official.epsGaap).toBe(1.38);
    expect(market.epsResult).toBe("Beat");
  });
});

describe("releaseTimestamp — sec-filing is never an earnings-release time", () => {
  it("treats a sec-filing reportedAt as unknown", () => {
    const event = eventWithViewMetadata({
      symbol: "AAPL", status: "reported",
      reportedAt: "2026-07-31T00:00:00.000Z", reportedAtSource: "sec-filing",
    });
    expect(releaseTimestamp(event)).toBeNull();
  });

  it("returns an independently-known reportedAt", () => {
    const event = eventWithViewMetadata({
      symbol: "TST", status: "reported",
      reportedAt: "2026-08-05T12:00:00.000Z", reportedAtSource: null,
    });
    expect(releaseTimestamp(event)).toBe("2026-08-05T12:00:00.000Z");
  });

  it("returns null when there is no reportedAt at all", () => {
    expect(releaseTimestamp(eventWithViewMetadata({ symbol: "NVDA", status: "scheduled" }))).toBeNull();
  });
});

describe("official view and filing dates", () => {
  it("reports hasAny=false (clean N/A) when no SEC data is present", () => {
    const event = eventWithViewMetadata({
      symbol: "NVDA", status: "scheduled",
      epsActualGaap: null, revenueActualOfficial: null, secFilingUrl: null, secForm: null, secFiledAt: null,
    });
    const official = officialEarningsView(event);
    expect(official.hasAny).toBe(false);
    expect(official.epsGaap).toBeNull();
    expect(official.secFilingUrl).toBeNull();
  });

  it("formats the SEC acceptance date for the official section", () => {
    expect(formatFilingDate("2026-07-31T00:00:00.000Z")).toBe("Jul 31, 2026");
    expect(formatFilingDate("2026-08-05T00:00:00.000Z")).toBe("Aug 5, 2026");
    expect(formatFilingDate(null)).toBeNull();
    expect(formatFilingDate("garbage")).toBeNull();
  });
});

describe("source provenance labels", () => {
  it("maps raw internal tokens to friendly user copy", () => {
    expect(sourceLabel("sec-xbrl")).toBe("SEC / Official");
    expect(sourceLabel("sec-filing")).toBe("SEC / Filing");
    expect(sourceLabel("finnhub-consensus")).toBe("Finnhub / Market");
    expect(sourceLabel("finnhub-adjusted")).toBe("Finnhub / Market");
    expect(sourceLabel(null)).toBe("N/A");
  });

  it("never surfaces raw internal tokens as user-facing label", () => {
    // Every quality verdict maps through dataQualityLabel to friendly copy,
    // never falling back to the raw token.
    const qualityTokens = ["match", "different-basis", "conflict", "official-only", "finnhub-only", "unresolved"] as const;
    for (const token of qualityTokens) {
      const label = dataQualityLabel(token as never);
      expect(label).not.toBeNull();
      expect(label).not.toBe(token);
    }
    // Every provenance source maps through sourceLabel to friendly copy.
    const sourceTokens = ["sec-xbrl", "sec-filing", "finnhub-consensus", "finnhub-adjusted"] as const;
    for (const token of sourceTokens) {
      const label = sourceLabel(token as never);
      expect(label).not.toBe(token);
    }
  });

  it("maps every data-quality verdict to friendly copy", () => {
    expect(dataQualityLabel("match")).toBe("Market and official results are consistent");
    expect(dataQualityLabel("different-basis")).toBe("GAAP and adjusted results differ");
    expect(dataQualityLabel("conflict")).toBe("Provider and SEC data could not be aligned");
    expect(dataQualityLabel("official-only")).toBe("Only official SEC data is available");
    expect(dataQualityLabel("finnhub-only")).toBe("Only market data is available");
    expect(dataQualityLabel("unresolved")).toBe("Data quality could not be fully resolved");
    expect(dataQualityLabel(null)).toBeNull();
  });
});

describe("API contract round-trip", () => {
  it("preserves both market and official fields through the view model", () => {
    const event = eventWithViewMetadata({
      symbol: "AAPL", company: "Apple", status: "reported",
      epsEstimate: 1.9271, epsActual: 1.91, epsActualAdjusted: 1.91, epsActualAdjustedSource: "finnhub-adjusted",
      epsActualGaap: 2.02, epsActualGaapSource: "sec-xbrl",
      revenueActualOfficial: 109_417_000_000, revenueActualSource: "sec-xbrl",
      secFilingUrl: "https://www.sec.gov/Archives/edgar/data/320193/000032019326000020/0000320193-26-000020-index.html",
      secForm: "10-Q", secFiledAt: "2026-07-31T00:00:00.000Z",
      dataQualityStatus: "different-basis",
    });
    expect(event.epsEstimate).toBe(1.9271);
    expect(event.epsActual).toBe(1.91);
    expect(event.epsActualGaap).toBe(2.02);
    expect(event.secForm).toBe("10-Q");
    expect(event.secFiledAt).toBe("2026-07-31T00:00:00.000Z");
    expect(event.dataQualityStatus).toBe("different-basis");
  });

  it("parses a legacy pre-#63 payload (missing new fields) without crashing", () => {
    const event = eventWithViewMetadata({
      id: "MSFT-2026-Q1", symbol: "MSFT", company: "Microsoft", status: "reported",
      scheduledDate: "2026-08-12", epsEstimate: 3, epsActual: 3.3, revenueActual: 110,
      overallResult: "Mixed",
    });
    expect(event.epsActualGaap).toBeNull();
    expect(event.secFilingUrl).toBeNull();
    expect(event.reportedAtSource).toBeNull();
    const market = marketEarningsView(event);
    const official = officialEarningsView(event);
    expect(market.epsActual).toBe(3.3);
    expect(official.hasAny).toBe(false);
  });
});
