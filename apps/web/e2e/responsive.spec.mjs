// Responsive reality check: the homepage must hold together at the mobile
// widths that matter (390px and 430px phones, 820px tablet) and on desktop
// (1440px), in both themes, with no page-level horizontal overflow, no console
// errors, no TradingView error states, and the DOM/visual section order
// matching the logical layout. Runs the viewport matrix on the desktop project
// (setViewportSize overrides the project viewport); mobile reality is also
// exercised by the mobile-chromium runs of smoke/tv-csp/tv-live.

import { expect, test } from "@playwright/test";
import { installShadowRootProbe, waitForTradingViewElement } from "./tv-helpers.mjs";

test.skip(({ isMobile }) => isMobile, "Responsive matrix runs on the desktop project");

const VIEWPORTS = [
  { width: 375, height: 812, label: "375px phone" },
  { width: 390, height: 844, label: "390px phone" },
  { width: 430, height: 932, label: "430px phone" },
  { width: 768, height: 1024, label: "768px tablet" },
  { width: 820, height: 1180, label: "820px tablet" },
  { width: 1024, height: 900, label: "1024px desktop" },
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

    if (viewport.width <= 900) {
      const brand = page.locator(".shell-topbar .shell-brand");
      const hamburger = page.locator(".shell-topbar .shell-menu-button");
      await expect(brand).toBeVisible();
      await expect(hamburger).toBeVisible();
      await expect(page.locator(".shell-bottom-nav")).toHaveCount(0);
      const [tickerBox, topbarBox] = await Promise.all([
        page.locator(".global-ticker").boundingBox(),
        page.locator(".shell-topbar").boundingBox(),
      ]);
      expect(tickerBox).not.toBeNull();
      expect(topbarBox).not.toBeNull();
      expect(tickerBox.y + tickerBox.height).toBeLessThanOrEqual(topbarBox.y + 1);
      const [brandBox, hamburgerBox] = await Promise.all([brand.boundingBox(), hamburger.boundingBox()]);
      expect(brandBox).not.toBeNull();
      expect(hamburgerBox).not.toBeNull();
      expect(hamburgerBox.x).toBeGreaterThan(brandBox.x);
      expect(hamburgerBox.x + hamburgerBox.width).toBeGreaterThan(brandBox.x + brandBox.width - 4);
    }

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
      // On mobile .shell-main intentionally uses display: contents so the
      // ticker can be ordered before the top bar without changing the DOM.
      // Measure the routed page surface instead; it keeps a real layout box.
      const contentBox = await page.locator(".page-content").boundingBox();
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

      await expect(page.locator("tv-ticker-tape")).toHaveAttribute("theme", theme);
      await expect(page.locator("tv-market-overview")).toHaveAttribute("theme", theme);

      // No TradingView error states, no dead-feed placeholders, no overflow.
      await expect(page.locator(".tv-widget-error")).toHaveCount(0);
      await expect(page.locator(".tv-wc-error")).toHaveCount(0);
      await expect(page.locator("body")).not.toContainText("No data here yet");
      expect(await noOverflow(), `no horizontal overflow at ${viewport.label} (${theme})`).toBeTruthy();

      // The hero, market overview frame and Fear & Greed card are all on
      // screen without a horizontal scrollbar.
      await expect(page.locator(".mb-hero")).toBeVisible();
      await expect(page.locator(".market-overview-frame")).toBeVisible();
      await expect(page.locator(".sentiment-card")).toBeVisible();

      // The simplified Fear & Greed card keeps only the title, gauge, score,
      // one label and the "Updated" timestamp — the Momentum / Risk appetite
      // rows are gone.
      await expect(page.locator(".sentiment-card")).not.toContainText("Momentum");
      await expect(page.locator(".sentiment-card")).not.toContainText("Risk appetite");

      // The Fear & Greed gauge stays horizontally centred inside its card on
      // every breakpoint. The score and its label live inside the gauge, so
      // centring the gauge centres the whole reading.
      const fgCentering = await page.evaluate(() => {
        const card = document.querySelector(".sentiment-card");
        const gauge = card?.querySelector(".gauge");
        if (!card || !gauge) return null;
        const cardRect = card.getBoundingClientRect();
        const gaugeRect = gauge.getBoundingClientRect();
        const strong = gauge.querySelector(".gauge-mask strong");
        const strongRect = strong?.getBoundingClientRect();
        return {
          gaugeOffset: gaugeRect.left + gaugeRect.width / 2 - (cardRect.left + cardRect.width / 2),
          strongOffset: strongRect
            ? strongRect.left + strongRect.width / 2 - (gaugeRect.left + gaugeRect.width / 2)
            : null,
        };
      });
      expect(fgCentering, `sentiment card + gauge present at ${viewport.label} (${theme})`).not.toBeNull();
      expect(Math.abs(fgCentering.gaugeOffset), `gauge centred in card at ${viewport.label} (${theme})`).toBeLessThanOrEqual(4);
      if (fgCentering.strongOffset !== null) {
        expect(Math.abs(fgCentering.strongOffset), `score centred in gauge at ${viewport.label} (${theme})`).toBeLessThanOrEqual(4);
      }

      if (viewport.width >= 981) {
        // Desktop: the Fear & Greed card keeps the standard card surface —
        // same background, border, radius and shadow as the greeting card it
        // sits beside — while staying aligned to the greeting block so the two
        // read as one hero row. Comparing computed styles to the hero is
        // theme-agnostic and pins the surface without hard-coding palette
        // values.
        const fgSurface = await page.evaluate(() => {
          const fg = document.querySelector(".sentiment-card");
          const hero = document.querySelector(".mb-hero");
          const fgcs = getComputedStyle(fg);
          const herocs = getComputedStyle(hero);
          const fgRect = fg.getBoundingClientRect();
          const heroRect = hero.getBoundingClientRect();
          return {
            bgMatches: fgcs.backgroundColor === herocs.backgroundColor,
            borderMatches: fgcs.borderTopColor === herocs.borderTopColor,
            radiusMatches: fgcs.borderRadius === herocs.borderRadius,
            shadowMatches: fgcs.boxShadow === herocs.boxShadow,
            topGap: fgRect.top - heroRect.top,
            heightGap: fgRect.height - heroRect.height,
          };
        });
        expect(fgSurface.bgMatches, `Fear & Greed background matches greeting card on desktop (${theme})`).toBeTruthy();
        expect(fgSurface.borderMatches, `Fear & Greed border matches greeting card on desktop (${theme})`).toBeTruthy();
        expect(fgSurface.radiusMatches, `Fear & Greed radius matches greeting card on desktop (${theme})`).toBeTruthy();
        expect(fgSurface.shadowMatches, `Fear & Greed shadow matches greeting card on desktop (${theme})`).toBeTruthy();
        expect(Math.abs(fgSurface.topGap), `Fear & Greed top aligns with greeting on desktop (${theme})`).toBeLessThanOrEqual(2);
        expect(Math.abs(fgSurface.heightGap), `Fear & Greed height matches greeting on desktop (${theme})`).toBeLessThanOrEqual(4);

        // Desktop row 2: Market Overview and the Economic Calendar stretch to
        // one shared height — same top, same bottom, same visible card height.
        const cols = await page.evaluate(() => {
          const market = document.querySelector(".market-overview-block").getBoundingClientRect();
          const calendar = document.querySelector(".calendar-block").getBoundingClientRect();
          const marketFrame = document.querySelector(".market-overview-frame").getBoundingClientRect();
          const calendarFrame = document.querySelector(".calendar-block .tv-widget-container").getBoundingClientRect();
          return {
            heightGap: market.height - calendar.height,
            topGap: market.top - calendar.top,
            frameHeightGap: marketFrame.height - calendarFrame.height,
            frameBottomGap: marketFrame.bottom - calendarFrame.bottom,
          };
        });
        expect(Math.abs(cols.heightGap), `Market/Calendar blocks same height on desktop (${theme})`).toBeLessThanOrEqual(4);
        expect(Math.abs(cols.topGap), `Market/Calendar blocks same top on desktop (${theme})`).toBeLessThanOrEqual(2);
        expect(Math.abs(cols.frameHeightGap), `Market/Calendar frames same height on desktop (${theme})`).toBeLessThanOrEqual(4);
        expect(Math.abs(cols.frameBottomGap), `Market/Calendar frames share a bottom edge on desktop (${theme})`).toBeLessThanOrEqual(4);
      }

      // DOM order must equal the logical visual order (Hero, Fear & Greed,
      // Market Overview, Economic Calendar, Top Stories) with no CSS `order`
      // rearrangements, on every breakpoint.
      const order = await page.evaluate(() => {
        const children = [...document.querySelectorAll(".homepage-grid > *")];
        const selectors = [".mb-hero", ".sentiment-card", ".market-overview-block", ".calendar-block", ".stories-block"];
        const domIndex = selectors.map((s) => children.indexOf(document.querySelector(s)));
        // Reading order by (top, left) — rows top-down, then left-right.
        const readingKey = selectors.map((s) => {
          const rect = document.querySelector(s).getBoundingClientRect();
          return Math.round(rect.top * 100000 + rect.left);
        });
        const sorted = [...readingKey].sort((a, b) => a - b);
        return { domIndex, inOrder: domIndex.every((v, i) => v === i) && readingKey.every((v, i) => v === sorted[i]) };
      });
      expect(order.domIndex, `DOM order at ${viewport.label} (${theme})`).toEqual([0, 1, 2, 3, 4]);
      expect(order.inOrder, `visual order must match DOM order at ${viewport.label} (${theme})`).toBeTruthy();
    }

    expect(errors, `no console errors at ${viewport.label}`).toEqual([]);
  });
}
