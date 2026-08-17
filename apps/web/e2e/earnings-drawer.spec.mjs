// Earnings detail drawer — Market vs Official separation, compact money and
// mobile overflow. Runs with route-mocked /api/earnings (real API is
// unreachable in local E2E), so it also pins the drawer rendering contract in
// isolation: GAAP values only in the official section, no giant raw integers,
// no horizontal overflow at phone widths.

import { expect, test } from "@playwright/test";

test.skip(({ isMobile }) => isMobile, "Drawer matrix runs on the desktop project");

const DATE = { year: 2026, month: "08" };

const EVENTS = [
  // AAPL regression: Finnhub adjusted 1.91 vs SEC GAAP 2.02 (different basis).
  {
    id: "AAPL-2026-Q3", symbol: "AAPL", company: "Apple", cik: "0000320193",
    fiscalYear: 2026, fiscalQuarter: 3, fiscalPeriod: "Q3", fiscalPeriodEnd: "2026-06-27",
    scheduledDate: `${DATE.year}-${DATE.month}-05`, scheduledTime: "16:00:00", timing: "AMC", status: "reported",
    scheduled: false, reported: true, cancelled: false, unknown: false,
    epsEstimate: 1.9271, epsActual: 1.91, epsSurprise: -0.0171, epsSurprisePct: -0.89, epsResult: "Miss",
    revenueEstimate: 110_823_804_698, revenueActual: 109_417_000_000, revenueResult: "Miss",
    overallResult: "Miss",
    epsActualGaap: 2.02, epsActualGaapSource: "sec-xbrl",
    epsActualAdjusted: 1.91, epsActualAdjustedSource: "finnhub-adjusted",
    revenueActualOfficial: 109_417_000_000, revenueActualSource: "sec-xbrl",
    epsEstimateSource: "finnhub-consensus", revenueEstimateSource: "finnhub-consensus",
    dataQualityStatus: "different-basis",
    calendarProvider: "finnhub-earnings-calendar", consensusProvider: "finnhub-earnings-calendar",
    providerEventId: "finnhub:AAPL:2026:3", providerUpdatedAt: "2026-07-31T00:00:00.000Z",
    secAccession: "0000320193-26-000020", secForm: "10-Q",
    secFiledAt: "2026-07-31T00:00:00.000Z",
    secFilingUrl: "https://www.sec.gov/Archives/edgar/data/320193/000032019326000020/0000320193-26-000020-index.html",
    createdAt: "2026-07-31T00:00:00.000Z", updatedAt: "2026-07-31T00:00:00.000Z", lastCheckedAt: "2026-07-31T00:00:00.000Z",
    logoUrl: null, industry: null, websiteUrl: null,
  },
  // NVDA upcoming: estimate visible, nothing fabricated.
  {
    id: "NVDA-2027-Q2", symbol: "NVDA", company: "NVIDIA", cik: null,
    fiscalYear: 2027, fiscalQuarter: 2, fiscalPeriod: "Q2", fiscalPeriodEnd: null,
    scheduledDate: `${DATE.year}-${DATE.month}-06`, scheduledTime: null, timing: "AMC", status: "scheduled",
    scheduled: true, reported: false, cancelled: false, unknown: false,
    epsEstimate: 2.1283, epsActual: null, epsSurprise: null, epsSurprisePct: null, epsResult: "Not Available",
    revenueEstimate: 93_634_391_959, revenueActual: null, revenueResult: "Not Available",
    overallResult: "Not Available",
    epsActualGaap: null, revenueActualOfficial: null, secFilingUrl: null, secForm: null, secFiledAt: null,
    calendarProvider: "finnhub-earnings-calendar", consensusProvider: "finnhub-earnings-calendar",
    providerEventId: "finnhub:NVDA:2027:2", providerUpdatedAt: "2026-08-01T00:00:00.000Z",
    createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z", lastCheckedAt: null,
    logoUrl: null, industry: null, websiteUrl: null,
  },
];

const VIEWPORTS = [
  { width: 390, height: 844, label: "390px phone" },
  { width: 430, height: 932, label: "430px phone" },
  { width: 1440, height: 900, label: "1440px desktop" },
];

for (const viewport of VIEWPORTS) {
  test(`earnings drawer holds together at ${viewport.label}`, async ({ page }) => {
    test.setTimeout(45_000);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });

    await page.route("**/api/earnings?*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ from: "2026-01-01", to: "2026-12-31", summary: { today: 1, thisWeek: 1, next30Days: 2 }, events: EVENTS }),
      });
    });

    await page.goto("/earnings", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: /Earnings Calendar/ })).toBeVisible();

    // Open the AAPL drawer from the calendar cell.
    await page.getByRole("button", { name: /AAPL.*AMC/ }).first().click();
    const drawer = page.getByRole("dialog", { name: "Earnings Detail" });
    await expect(drawer).toBeVisible();

    // Market section: adjusted basis + compact money; GAAP never leaks in.
    const market = drawer.locator('.earnings-subsection[aria-label="Market earnings"]');
    await expect(market).toContainText("Adjusted EPS Actual");
    await expect(market).toContainText("$1.91");
    await expect(market).toContainText("$109.4B");
    await expect(market).not.toContainText("2.02");
    // Official section: GAAP lives here only.
    const official = drawer.locator('.earnings-subsection[aria-label="Official SEC data"]');
    await expect(official).toContainText("GAAP EPS");
    await expect(official).toContainText("$2.02");
    await expect(official).toContainText("Jul 31, 2026");
    await expect(drawer.getByRole("link", { name: /View SEC Filing/ })).toBeVisible();

    // No giant raw integers anywhere in the drawer.
    const drawerText = await drawer.innerText();
    expect(drawerText).not.toContain("110,823");
    expect(drawerText).not.toContain("93,634");

    // Educational copy is present.
    await expect(drawer.locator("summary")).toContainText("How to read these numbers");

    // No page-level or drawer-level horizontal overflow.
    const noOverflow = await page.evaluate(() => {
      const el = document.querySelector(".earnings-drawer");
      return {
        page: document.documentElement.scrollWidth <= window.innerWidth + 1,
        drawer: el ? el.scrollWidth <= el.clientWidth + 1 : true,
      };
    });
    expect(noOverflow.page, `no page overflow at ${viewport.label}`).toBeTruthy();
    expect(noOverflow.drawer, `no drawer overflow at ${viewport.label}`).toBeTruthy();

    // NVDA (upcoming) shows the estimate and nothing fabricated.
    await page.getByLabel("Close earnings detail").click();
    await page.getByRole("button", { name: /NVDA.*AMC/ }).first().click();
    const nvdaDrawer = page.getByRole("dialog", { name: "Earnings Detail" });
    await expect(nvdaDrawer.locator(".drawer-company .result")).toHaveText("Upcoming");
    const nvdaMarket = nvdaDrawer.locator('.earnings-subsection[aria-label="Market earnings"]');
    await expect(nvdaMarket).toContainText("$2.13");
    await expect(nvdaMarket).toContainText("$93.63B");
    await expect(nvdaDrawer.getByRole("link", { name: /View SEC Filing/ })).toHaveCount(0);
  });
}
