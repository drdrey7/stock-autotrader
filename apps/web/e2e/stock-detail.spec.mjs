import { expect, test } from "@playwright/test";

const THEME_STORAGE_KEY = "how-are-the-markets-theme";

async function setTheme(page, theme) {
  await page.addInitScript(({ key, value }) => {
    window.localStorage.setItem(key, value);
  }, { key: THEME_STORAGE_KEY, value: theme });
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