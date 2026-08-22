import { expect, test } from "@playwright/test";

const THEME_STORAGE_KEY = "how-are-the-markets-theme";
const COMPANY_NAMES = {
  MSFT: "Microsoft Corporation",
  NVDA: "NVIDIA Corporation",
  CRCL: "Circle Internet Group, Inc.",
};

async function setTheme(page, theme) {
  await page.addInitScript(({ key, value }) => {
    window.localStorage.setItem(key, value);
  }, { key: THEME_STORAGE_KEY, value: theme });
}

function priceHistory(symbol) {
  const count = symbol === "CRCL" ? 60 : 260;
  const end = Date.parse("2026-08-14T00:00:00.000Z");
  return Array.from({ length: count }, (_, index) => {
    const time = new Date(end - (count - 1 - index) * 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const close = 100 + index * 0.5;
    return { time, open: close - 1, high: close + 2, low: close - 2, close, volume: 1_000_000 + index };
  });
}

function detailFixture(symbol) {
  const history = priceHistory(symbol);
  const hasSma = symbol !== "CRCL";
  const ivBase = symbol === "MSFT" ? 570.31 : symbol === "NVDA" ? 221.02 : null;
  const quotePrice = symbol === "MSFT" ? 500 : symbol === "NVDA" ? 180 : 130;
  return {
    schemaVersion: 1,
    generatedAt: "2026-08-21T15:00:00.000Z",
    symbol,
    company: { name: COMPANY_NAMES[symbol], exchange: null, sector: null, logoUrl: null },
    quote: {
      price: quotePrice,
      changeAbs: 1.5,
      changePct: 0.75,
      provider: "fixture",
      asOf: "2026-08-21T14:59:00.000Z",
      updatedAt: "2026-08-21T14:59:05.000Z",
      state: "Live",
      marketState: "regular",
      scaleState: "safe",
    },
    valuation: {
      intrinsicValue: ivBase === null ? null : {
        low: null,
        base: ivBase,
        high: null,
        method: "manual",
        asOf: "2026-08-03",
        upsidePct: (ivBase / quotePrice - 1) * 100,
      },
    },
    technical: {
      sma200w: hasSma ? 150 : null,
      distanceToSma200wPct: hasSma ? (quotePrice / 150 - 1) * 100 : null,
      sma200wState: hasSma ? "Above" : "NotEnoughHistory",
      sma200wHistoryWeeks: hasSma ? 459 : history.length,
      sma200wAsOf: hasSma ? "2026-08-14T20:00:00.000Z" : null,
      supports: symbol === "MSFT"
        ? [{ level: 1, price: 450, method: "manual", asOf: "2026-08-03", triggered: false }]
        : [],
      sma200wHistory: hasSma
        ? history.slice(-61).map((point, index) => ({ time: point.time, value: 140 + index * 0.15 }))
        : [],
    },
    chart: { interval: "1w", priceHistory: history, intrinsicValueHistory: [] },
    freshness: {
      quoteAsOf: "2026-08-21T14:59:00.000Z",
      historyAsOf: "2026-08-15T06:00:00.000Z",
      valuationAsOf: ivBase === null ? null : "2026-08-03",
      technicalAsOf: hasSma ? "2026-08-15T06:00:00.000Z" : null,
    },
  };
}

async function installStockDetailApiFixtures(page) {
  await page.route("**/api/stocks/*/detail", async (route) => {
    const match = new URL(route.request().url()).pathname.match(/^\/api\/stocks\/([^/]+)\/detail$/);
    const symbol = decodeURIComponent(match?.[1] ?? "").toUpperCase();
    if (!(symbol in COMPANY_NAMES)) {
      await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "stock_not_found" }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(detailFixture(symbol)) });
  });
}

async function expectNoHorizontalOverflow(page) {
  const measurements = await page.evaluate(() => ({
    viewport: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth,
  }));
  expect(measurements.documentWidth).toBeLessThanOrEqual(measurements.viewport + 1);
  expect(measurements.bodyWidth).toBeLessThanOrEqual(measurements.viewport + 1);
}

async function expectStockDetailReady(page, symbol, companyName) {
  await expect(page.getByRole("heading", { level: 1, name: companyName })).toBeVisible();
  await expect(page.getByRole("link", { name: "Back to Screener" })).toHaveAttribute("href", "/screener");
  await expect(page.getByRole("tablist")).toHaveCount(0);
  await expect(page.getByText("Preview data")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Our Intrinsic Value" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Price & Key Levels" })).toBeVisible();
  const chart = page.getByRole("img", { name: new RegExp(`${symbol} price chart`, "i") });
  await expect(chart).toBeVisible();
  const box = await chart.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThan(220);
  expect(box?.height ?? 0).toBeGreaterThan(260);
  await expect(page.getByText(/TradingView Lightweight Charts™ Copyright \(c\) 2025/)).toBeVisible();
  await expect(page.getByRole("link", { name: "TradingView, Inc." })).toHaveAttribute("href", "https://www.tradingview.com/");
}

test.describe("Stock Detail browser smoke", () => {
  test("desktop keeps the real shell and updates the chart across dark and light themes", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop-chromium", "desktop validation runs once");
    await installStockDetailApiFixtures(page);
    await page.setViewportSize({ width: 1440, height: 1024 });

    await setTheme(page, "dark");
    await page.goto("/stocks/MSFT");
    await expectStockDetailReady(page, "MSFT", "Microsoft Corporation");
    await expect(page.getByRole("navigation", { name: "Primary navigation" })).toBeVisible();
    await expect(page.getByLabel("Live market ticker")).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: testInfo.outputPath("stock-detail-desktop-dark.png"), fullPage: true });

    await page.getByRole("button", { name: "Switch to light mode" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await expectStockDetailReady(page, "MSFT", "Microsoft Corporation");
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: testInfo.outputPath("stock-detail-desktop-light.png"), fullPage: true });
  });

  test("mobile uses one shell, updates theme live and has no overflow at target widths", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile-chromium", "mobile validation runs once");
    await installStockDetailApiFixtures(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await setTheme(page, "dark");
    await page.goto("/stocks/MSFT");
    await expectStockDetailReady(page, "MSFT", "Microsoft Corporation");
    await expect(page.locator(".shell-topbar")).toHaveCount(1);
    await expect(page.locator(".shell-sidebar")).toBeHidden();
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: testInfo.outputPath("stock-detail-mobile-dark.png"), fullPage: true });

    await page.getByRole("button", { name: "Switch to light mode" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await expectStockDetailReady(page, "MSFT", "Microsoft Corporation");
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: testInfo.outputPath("stock-detail-mobile-light.png"), fullPage: true });

    for (const width of [320, 375, 390, 430]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto("/stocks/NVDA");
      await expectStockDetailReady(page, "NVDA", "NVIDIA Corporation");
      await expectNoHorizontalOverflow(page);
    }
  });

  test("core-universe routes share the same page and invalid symbols stay in-shell", async ({ page }) => {
    await installStockDetailApiFixtures(page);
    for (const [symbol, companyName] of [
      ["NVDA", "NVIDIA Corporation"],
      ["CRCL", "Circle Internet Group, Inc."],
    ]) {
      await page.goto(`/stocks/${symbol}`);
      await expectStockDetailReady(page, symbol, companyName);
    }

    await page.goto("/stocks/INVALID");
    await expect(page.getByRole("heading", { name: "Stock not found" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Back to Screener" })).toBeVisible();
    await expect(page.locator(".shell")).toHaveCount(1);
    await expect(page.locator(".shell-main")).toContainText("Stock not found");
  });

  test("dashboard and screener continue to load independently of the stock-detail chunk", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page.getByText(/economic calendar and top stories/i)).toBeVisible();
    await page.goto("/screener");
    await expect(page.getByRole("heading", { name: "Screener" })).toBeVisible();
  });
});
