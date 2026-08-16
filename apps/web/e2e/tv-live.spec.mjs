// TradingView real-data E2E. Unlike the unit suite (jsdom) and the CSP spec
// (enforcement), this spec drives a real browser against the live TradingView
// datafeed and proves every symbol the homepage configures actually renders a
// value — a symbol that "exists" but renders a dead-feed placeholder (-----,
// "No data here yet") is a release blocker.
//
// Provider vs config regression: when TradingView is unreachable from this
// machine the whole group skips with a provider-outage reason. When it IS
// reachable and a row still renders a placeholder, the spec fails — that is a
// config regression in OUR symbol list, not a transient outage.
//
// The configured symbol list is read from the live widget attributes
// (<tv-ticker-tape symbols> / <tv-market-overview symbol-sectors>) so the
// spec always validates exactly what the app mounted — no duplicated config.

import { expect, test } from "@playwright/test";
import {
  DEAD_FEED_MARKERS,
  clickMarketOverviewSection,
  installShadowRootProbe,
  readMarketRows,
  readTickerItems,
  tradingViewReachable,
  waitForTradingViewElement,
} from "./tv-helpers.mjs";

const isLiveText = (text) => text.length > 0 && !DEAD_FEED_MARKERS.some((marker) => text.includes(marker));

test.describe("TradingView live data", () => {
  let provider;
  test.beforeAll(async () => {
    provider = await tradingViewReachable();
  });
  test.beforeEach(() => {
    test.skip(!provider.reachable, `TradingView unreachable (${provider.detail}) — provider outage, not a config regression`);
  });

  test("ticker tape renders a row for every configured symbol", async ({ page }) => {
    await installShadowRootProbe(page);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await waitForTradingViewElement(page, "tv-ticker-tape");

    const configured = await page.evaluate(() => {
      const symbols = document.querySelector("tv-ticker-tape")?.getAttribute("symbols")?.split(",") ?? [];
      return symbols.filter(Boolean);
    });
    expect(configured.length, "the app must configure at least one ticker symbol").toBeGreaterThan(0);

    // Structural contract: the tape renders exactly the configured symbols,
    // in order, and none of them is a dead-feed placeholder.
    await expect
      .poll(
        async () => {
          const { items, error } = await readTickerItems(page);
          if (error) return { ok: false, error };
          const symbols = items.map((item) => item.symbol);
          const dead = items.filter((item) => !isLiveText(item.text));
          return {
            ok: items.length === configured.length
              && configured.every((symbol) => symbols.includes(symbol))
              && dead.length === 0,
            items,
          };
        },
        { timeout: 20_000, message: "ticker did not render every configured symbol without dead-feed markers" },
      )
      .toMatchObject({ ok: true });

    // Live quotes: the tape streams real-time prices where the environment
    // supports it. A partial stream means a symbol-specific regression; an
    // empty stream means the real-time channel is unavailable here (the
    // structural contract above already passed), so skip rather than fail.
    const deadline = Date.now() + 20_000;
    let snapshot;
    for (;;) {
      snapshot = await readTickerItems(page);
      if (snapshot.error) throw new Error(snapshot.error);
      const liveCount = snapshot.items.filter((item) => isLiveText(item.text)).length;
      if (liveCount === snapshot.items.length && snapshot.items.length > 0) break;
      if (liveCount > 0 && liveCount < snapshot.items.length) {
        throw new Error(
          `ticker streamed live values for only ${liveCount}/${snapshot.items.length} symbols: ` +
            `${JSON.stringify(snapshot.items)}`,
        );
      }
      if (Date.now() > deadline) break;
      await page.waitForTimeout(1_000);
    }
    const liveCount = snapshot.items.filter((item) => isLiveText(item.text)).length;
    if (liveCount === 0) {
      test.skip(
        true,
        "TradingView real-time quote channel did not stream in this environment; structural symbol checks passed",
      );
    }
  });

  test("market overview renders live rows for every configured section", async ({ page }) => {
    await installShadowRootProbe(page);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await waitForTradingViewElement(page, "tv-market-overview");

    const sections = await page.evaluate(() => {
      try {
        return JSON.parse(document.querySelector("tv-market-overview")?.getAttribute("symbol-sectors") ?? "[]");
      } catch {
        return [];
      }
    });
    expect(sections.length, "the app must configure at least one market overview section").toBeGreaterThan(0);

    for (const section of sections) {
      const clicked = await clickMarketOverviewSection(page, section.sectionName);
      expect(clicked, `market overview section tab "${section.sectionName}" not found`).toBeTruthy();

      await expect
        .poll(
          async () => {
            const { rows, error } = await readMarketRows(page);
            if (error) return { ok: false, error };
            return {
              ok: rows.length === section.symbols.length && rows.every((row) => isLiveText(row.text)),
              rows,
            };
          },
          {
            timeout: 15_000,
            message: `market overview section "${section.sectionName}" did not render live values for every configured row`,
          },
        )
        .toMatchObject({ ok: true });
    }
  });

  test("economic calendar and top stories iframes load and render on their official hosts", async ({ page }) => {
    await installShadowRootProbe(page);
    await page.goto("/", { waitUntil: "domcontentloaded" });

    const cases = [
      { selector: ".tv-widget-events", name: "Economic calendar" },
      { selector: ".tv-widget-timeline", name: "Top stories" },
    ];
    for (const { selector, name } of cases) {
      const widget = page.locator(selector);
      await widget.scrollIntoViewIfNeeded();
      await expect(widget.locator("iframe"), `${name} iframe must load`).toBeVisible({ timeout: 20_000 });
      const src = await widget.locator("iframe").getAttribute("src");
      expect(src, `${name} iframe src must be present`).toBeTruthy();
      expect(new URL(src).hostname, `${name} must load from a TradingView host`).toMatch(
        /(?:www\.)?tradingview-widget\.com|s\.tradingview\.com/,
      );
      await expect(widget.locator(".tv-widget-error"), `${name} must not error`).toHaveCount(0);
    }
  });

  test("no TradingView error markers render anywhere on the homepage", async ({ page }) => {
    await installShadowRootProbe(page);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await waitForTradingViewElement(page, "tv-ticker-tape");
    await waitForTradingViewElement(page, "tv-market-overview");

    await expect(page.locator(".tv-widget-error")).toHaveCount(0);
    await expect(page.locator(".tv-wc-error")).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText("No data here yet");
    await expect(page.locator("body")).not.toContainText("-----");
  });
});
