// Responsive reality check: the homepage must hold together at the mobile
// widths that matter (390px phone, 820px tablet) and on desktop (1440px), in
// both themes, with no page-level horizontal overflow, no console errors and
// no TradingView error states. Runs the viewport matrix on the desktop project
// (setViewportSize overrides the project viewport); mobile reality is also
// exercised by the mobile-chromium runs of smoke/tv-csp/tv-live.

import { expect, test } from "@playwright/test";
import { installShadowRootProbe, waitForTradingViewElement } from "./tv-helpers.mjs";

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

    await installShadowRootProbe(page);
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

      // It must be a LIVE tape, not a static row. TradingView's official
      // marquee engine (tv-infinite-ticker) moves the quote items continuously;
      // reading the first item's position directly proves the engine is running
      // without prescribing pixels per second. Under prefers-reduced-motion the
      // engine switches to its documented 2s step-through — accessible
      // behaviour we must not override — so skip the motion assertion there.
      const reducedMotion = await page.evaluate(
        () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      );
      if (!reducedMotion) {
        const firstItemX = () =>
          page.evaluate(() => {
            const el = document.querySelector("tv-ticker-tape");
            const root = window.__tvShadowRoots?.get(el);
            const findFirst = (node) => {
              for (const child of node.children) {
                if (child.tagName?.toLowerCase() === "tv-ticker-chart-item") {
                  return Math.round(child.getBoundingClientRect().x);
                }
                const closed = window.__tvShadowRoots.get(child);
                if (child.shadowRoot && findFirst(child.shadowRoot)) return findFirst(child.shadowRoot);
                if (closed && closed !== child.shadowRoot && findFirst(closed)) return findFirst(closed);
                const r = findFirst(child);
                if (r != null) return r;
              }
              return null;
            };
            return root ? findFirst(root) : null;
          });
        // Wait for at least one quote item to render before sampling.
        let x1 = null;
        for (let attempt = 0; attempt < 20 && x1 === null; attempt += 1) {
          x1 = await firstItemX();
          if (x1 === null) await page.waitForTimeout(250);
        }
        await page.waitForTimeout(1200);
        const x2 = await firstItemX();
        expect(x1, "tape must render at least one quote item").not.toBeNull();
        expect(x2, "tape must render at least one quote item").not.toBeNull();
        expect(x1 !== x2, `ticker marquee must be moving at ${viewport.label} (${theme})`).toBeTruthy();
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
