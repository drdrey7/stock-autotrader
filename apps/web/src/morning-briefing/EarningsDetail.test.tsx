import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import EarningsDetail from "./EarningsDetail";
import { eventWithViewMetadata, type EarningsCompany } from "./data/earnings-view";

/** Render the drawer with a minimal reported event plus arbitrary overrides. */
function renderDetail(partial: Record<string, unknown>): ReturnType<typeof render> {
  const item = eventWithViewMetadata({
    symbol: "TST",
    company: "Test Co",
    timing: "AMC",
    status: "reported",
    ...partial,
  }) as EarningsCompany;
  return render(<EarningsDetail item={item} onClose={vi.fn()} />);
}

const marketSection = () => document.querySelector<HTMLElement>('.earnings-subsection[aria-label="Market earnings"]');
const officialSection = () => document.querySelector<HTMLElement>('.earnings-subsection[aria-label="Official SEC data"]');
const text = (element: Element | null): string => element?.textContent ?? "";

afterEach(() => {
  cleanup();
});

describe("EarningsDetail — AAPL different-basis (regression case)", () => {
  it("renders Market adjusted and Official GAAP as separate, non-mixed values", () => {
    renderDetail({
      symbol: "AAPL", company: "Apple", status: "reported",
      fiscalYear: 2026, fiscalQuarter: 3, fiscalPeriod: "Q3",
      scheduledDate: "2026-07-30", timing: "AMC",
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

    const dialog = screen.getByRole("dialog", { name: "Earnings Detail" });
    expect(dialog).toHaveTextContent("Market Earnings");
    expect(dialog).toHaveTextContent("Official SEC Data");

    const market = marketSection()!;
    const official = officialSection()!;
    // Market section: adjusted basis, compact money, no GAAP leakage.
    expect(market).toHaveTextContent("Adjusted EPS Actual");
    expect(market).toHaveTextContent("$1.91");
    // Compact money: revenue estimate/actual never render as giant integers.
    expect(market).toHaveTextContent("$110.8B");
    expect(market).toHaveTextContent("$109.4B");
    expect(market).not.toHaveTextContent("110,823,804,698");
    expect(market).not.toHaveTextContent("2.02");
    // Official section: GAAP value only here.
    expect(official).toHaveTextContent("GAAP EPS");
    expect(official).toHaveTextContent("$2.02");
    expect(official).not.toHaveTextContent("$1.91");
    // Friendly quality note instead of the raw 'different-basis' token.
    expect(dialog).toHaveTextContent("GAAP and adjusted results differ");
    expect(text(dialog)).not.toContain("different-basis");
  });

  it("renders the SEC filing date and the View SEC Filing link in the official section", () => {
    renderDetail({
      symbol: "AAPL", status: "reported",
      secForm: "10-Q", secFiledAt: "2026-07-31T00:00:00.000Z",
      secFilingUrl: "https://www.sec.gov/Archives/edgar/data/320193/000032019326000020/0000320193-26-000020-index.html",
    });
    const official = officialSection()!;
    expect(official).toHaveTextContent("SEC Filed");
    expect(official).toHaveTextContent("Jul 31, 2026");
    expect(official).toHaveTextContent("10-Q");
    const link = screen.getByRole("link", { name: /View SEC Filing/ });
    expect(link).toHaveAttribute("href", "https://www.sec.gov/Archives/edgar/data/320193/000032019326000020/0000320193-26-000020-index.html");
    expect(link).toHaveAttribute("target", "_blank");
  });
});

describe("EarningsDetail — AMD / COIN / NVDA regression cases", () => {
  it("AMD renders the adjusted market basis apart from the GAAP basis", () => {
    renderDetail({
      symbol: "AMD", company: "AMD", status: "reported",
      fiscalYear: 2026, fiscalQuarter: 2, fiscalPeriod: "Q2",
      epsEstimate: 1.6313, epsActual: 1.66, epsActualAdjusted: 1.66, epsActualAdjustedSource: "finnhub-adjusted",
      epsSurprisePct: 1.76, epsResult: "Beat",
      revenueEstimate: 11_396_426_778, revenueActual: 11_536_000_000, revenueResult: "Beat",
      overallResult: "Beat",
      epsActualGaap: 1.38, epsActualGaapSource: "sec-xbrl",
      revenueActualOfficial: 11_536_000_000, revenueActualSource: "sec-xbrl",
      dataQualityStatus: "different-basis",
    });
    const market = marketSection()!;
    const official = officialSection()!;
    expect(market).toHaveTextContent("$1.66");
    expect(market).toHaveTextContent("+1.76%");
    expect(official).toHaveTextContent("$1.38");
    expect(official).not.toHaveTextContent("$1.66");
    expect(market).toHaveTextContent("Beat");
  });

  it("COIN renders negative EPS with the correct sign and stays Finnhub-based", () => {
    renderDetail({
      symbol: "COIN", company: "Coinbase", status: "reported",
      fiscalYear: 2026, fiscalQuarter: 2, fiscalPeriod: "Q2",
      epsEstimate: -0.1735, epsActual: -1.17, epsActualAdjusted: -1.17, epsActualAdjustedSource: "finnhub-adjusted",
      epsSurprisePct: -574.35, epsResult: "Miss",
      revenueEstimate: 1_337_471_491, revenueActual: 1_220_068_000, revenueResult: "Miss",
      overallResult: "Miss",
      epsActualGaap: -1.36, epsActualGaapSource: "sec-xbrl",
      revenueActualOfficial: 1_220_068_000, revenueActualSource: "sec-xbrl",
      dataQualityStatus: "different-basis",
    });
    const market = marketSection()!;
    const official = officialSection()!;
    // Negative EPS formatting: sign before the currency symbol.
    expect(market).toHaveTextContent("-$1.17");
    expect(market).toHaveTextContent("-574.35%");
    expect(official).toHaveTextContent("-$1.36");
    // Market result is the Finnhub Miss; GAAP is reference-only.
    expect(market).toHaveTextContent("Miss");
    expect(market).toHaveTextContent("$1.34B");
    expect(market).toHaveTextContent("$1.22B");
    expect(market).not.toHaveTextContent("1,337,471,491");
  });

  it("NVDA upcoming renders no actual, no surprise, no fake Beat/Miss, no fake SEC data", () => {
    renderDetail({
      symbol: "NVDA", company: "NVIDIA", status: "scheduled",
      fiscalYear: 2027, fiscalQuarter: 2, fiscalPeriod: "Q2",
      scheduledDate: "2026-08-26", timing: "AMC",
      epsEstimate: 2.1283, epsActual: null, epsSurprisePct: null, epsResult: "Not Available",
      revenueEstimate: 93_634_391_959, revenueActual: null, revenueSurprisePct: null, revenueResult: "Not Available",
      overallResult: "Not Available",
      epsActualGaap: null, revenueActualOfficial: null,
      secFilingUrl: null, secForm: null, secFiledAt: null,
    });
    const dialog = screen.getByRole("dialog", { name: "Earnings Detail" });
    // Header badge says Upcoming — no fabricated result.
    expect(dialog.querySelector(".drawer-company .result")?.textContent).toBe("Upcoming");
    // The estimate is visible; actual/surprise/result are honest N/A.
    const market = marketSection()!;
    expect(market).toHaveTextContent("$2.13");
    expect(market).toHaveTextContent("$93.63B");
    expect(market.querySelectorAll(".metric-row strong").length).toBeGreaterThan(0);
    expect(market).not.toHaveTextContent("93,634,391,959");
    // The ONLY result badge is Upcoming — nothing is fabricated as Beat/Miss.
    const resultBadges = [...dialog.querySelectorAll(".result")].map((el) => el.textContent);
    expect(resultBadges).toEqual(["Upcoming"]);
    expect(market).toHaveTextContent("ResultN/A");
    // Official section renders a clean N/A state and no SEC link.
    const official = officialSection()!;
    expect(official).toHaveTextContent("N/A");
    expect(screen.queryByRole("link", { name: /View SEC Filing/ })).toBeNull();
  });
});

describe("EarningsDetail — provenance and N/A behavior", () => {
  it("does not display a sec-filing reportedAt as an earnings-release timestamp", () => {
    renderDetail({
      symbol: "AAPL", status: "reported",
      // Exactly the legacy data state: reportedAt populated from the SEC filing.
      reportedAt: "2026-07-31T00:00:00.000Z", reportedAtSource: "sec-filing",
    });
    const drawer = screen.getByRole("dialog", { name: "Earnings Detail" });
    const metadata = drawer.querySelector(".drawer-metadata")!;
    expect(metadata.textContent).toMatch(/Reported at\s*N\/A/);
  });

  it("keeps N/A rows aligned and hides links when SEC data is missing", () => {
    renderDetail({ symbol: "NVDA", status: "scheduled", overallResult: "Not Available" });
    const official = officialSection()!;
    // Every official row renders N/A in its value slot (no layout jump).
    expect(official).toHaveTextContent("N/A");
    expect(screen.queryByRole("link", { name: /View SEC Filing/ })).toBeNull();
    expect(screen.queryByRole("link", { name: /Official Earnings Report/ })).toBeNull();
    expect(screen.queryByRole("link", { name: /Investor Relations/ })).toBeNull();
  });

  it("shows the real release time only when independently known", () => {
    renderDetail({
      symbol: "TST", status: "reported",
      reportedAt: "2026-08-05T12:30:00.000Z", reportedAtSource: null,
    });
    const drawer = screen.getByRole("dialog", { name: "Earnings Detail" });
    const metadata = drawer.querySelector(".drawer-metadata")!;
    expect(metadata.textContent).toContain("Reported at");
    expect(metadata.textContent).not.toMatch(/Reported at\s*N\/A/);
  });
});

