// Responsive reality check: the homepage must hold together at the mobile
// widths that matter (390px phone, 820px tablet) and on desktop (1440px), in
// both themes, with no page-level horizontal overflow, no console errors and
// no TradingView error states. Runs the viewport matrix on the desktop project
// (setViewportSize overrides the project viewport); mobile reality is also
// exercised by the mobile-chromium runs of smoke/tv-csp/tv-live.

import { expect, test } from "@playwright/test";
import { waitForTradingViewElement } from "./tv-helpers.mjs";

test.skip(({ isMobile }) => isMobile, "Responsive matrix runs on the desktop project");

const VIEWPORTS = [
  { width: 390, height: 844, label: "390px phone" },
  { width: 820, height: 1180, label: "820px tablet" },
  { width: 1440, height: 900, label: "1440px desktop" },
];

for (const viewport of VIEWPORTS) {
  test(`homepage holds together at ${viewport.label}, light and dark`, async ({ page }) => {
    test.setTimeout(45_000);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });

    const errors = [];
    page.on("console", (msg) => {
      if (msg.type() !== "error") return;
      const text = msg.text();
      const isCspViolation =
        /violates the following Content Security Policy|Refused to (execute|load|connect|frame|send|run)/i.test(text);
      // TradingView's iframe widgets log their own provider fetch failures
      // (e.g. the economic calendar's chart-events feed). Those are transient
      // provider noise, not CSP violations (covered by tv-csp) or config
      // regressions (covered by tv-live) — ignore them, keep everything else.
      const isTradingViewWidgetNoise = !isCspViolation &&
        /chartevents-reuters|tradingview-widget|tradingview\.com|snowplow-pixel/i.test(text);
      if (isCspViolation || !isTradingViewWidgetNoise) errors.push(text);
    });

    await page.goto("/", { waitUntil: "domcontentloaded" });
    await waitForTradingViewElement(page, "tv-ticker-tape");
    await waitForTradingViewElement(page, "tv-market-overview");

    const noOverflow = () =>
      page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

    // Toggle through both themes. The toggle's label names the theme it will
    // switch TO ("Switch to dark mode" = currently light), so derive the theme
    // to assert from the label rather than assuming a starting theme.
    for (let pass = 0; pass < 2; pass += 1) {
      const toggle = page.getByRole("button", { name: /switch to (dark|light) mode/i });
      const aria = await toggle.getAttribute("aria-label");
      const theme = aria?.includes("dark") ? "dark" : "light";
      await toggle.click();

      // The global tape is a thin strip directly under the header, spanning
      // the content column (on desktop the shell's fixed sidebar sits beside
      // it; on mobile the column is the full viewport).
      const tape = page.locator(".global-ticker");
      await expect(tape).toBeVisible();
      const tapeBox = await tape.boundingBox();
      expect(tapeBox).not.toBeNull();
      const contentBox = await page.locator(".shell-main").boundingBox();
      expect(contentBox).not.toBeNull();
      expect(tapeBox.width, "ticker strip must span the content column").toBeGreaterThan(contentBox.width * 0.9);
      expect(tapeBox.height, "ticker strip must stay compact").toBeLessThan(64);

      // It must be a LIVE tape, not a static row: the strip's pixels advance
      // continuously (TradingView animates the marquee via transform/rAF, so a
      // frame-diff is the mechanism-agnostic way to prove motion). Under
      // prefers-reduced-motion the marquee stops — TradingView's accessible
      // behaviour, which is correct — so skip the motion assertion there.
      const reducedMotion = await page.evaluate(
        () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      );
      if (!reducedMotion) {
        const frameA = await tape.screenshot();
        await page.waitForTimeout(1200);
        const frameB = await tape.screenshot();
        expect(Buffer.compare(frameA, frameB) !== 0, `ticker tape must scroll at ${viewport.label} (${theme})`).toBeTruthy();
      }

      await expect(page.locator("tv-ticker-tape")).toHaveAttribute("color-theme", theme);
      await expect(page.locator("tv-market-overview")).toHaveAttribute("color-theme", theme);

      // No TradingView error states, no dead-feed placeholders, no overflow.
      await expect(page.locator(".tv-widget-error")).toHaveCount(0);
      await expect(page.locator(".tv-wc-error")).toHaveCount(0);
      await expect(page.locator("body")).not.toContainText("No data here yet");
      expect(await noOverflow(), `no horizontal overflow at ${viewport.label} (${theme})`).toBeTruthy();

      // The hero, market overview frame and opportunities section are all on
      // screen without a horizontal scrollbar.
      await expect(page.locator(".hero")).toBeVisible();
      await expect(page.locator(".market-overview-frame")).toBeVisible();
      await expect(page.locator(".opportunities-card")).toBeVisible();
    }

    expect(errors, `no console errors at ${viewport.label}`).toEqual([]);
  });
}
