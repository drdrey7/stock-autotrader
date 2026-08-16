// CSP E2E: proves the production Content-Security-Policy (the single source of
// truth in public/_headers, served by scripts/preview-server.mjs) actually
// permits the official TradingView widgets end to end.
//
// The deterministic header test asserts the allowlist. The live-enforcement
// group runs a real browser against the built app: the cross-origin web
// component ES modules must load (script-src), the embed-widget iframes must
// appear (frame-src), and nothing may be CSP-blocked along the way. When
// TradingView itself is unreachable from this machine the live group skips —
// a provider outage, not a policy regression.

import { expect, test } from "@playwright/test";
import {
  collectCspViolations,
  installShadowRootProbe,
  parseCsp,
  tradingViewReachable,
  waitForTradingViewElement,
} from "./tv-helpers.mjs";

const EXPECTED_SCRIPT_SRC = ["'self'", "https://s3.tradingview.com", "https://widgets.tradingview-widget.com"];
const EXPECTED_FRAME_SRC = [
  "https://www.tradingview-widget.com",
  "https://s.tradingview.com",
  "https://widgets.tradingview-widget.com",
];
const EXPECTED_CONNECT_SRC = ["'self'", "https://widgets.tradingview-widget.com"];
const EXPECTED_IMG_SRC = [
  "'self'",
  "data:",
  "https://s3-symbol-logo.tradingview.com",
  "https://widgets.tradingview-widget.com",
];

test("serves the production CSP that permits exactly the official TradingView hosts", async ({ page }) => {
  const response = await page.goto("/", { waitUntil: "domcontentloaded" });
  const header = response?.headers()["content-security-policy"];
  expect(header, "Content-Security-Policy header must be served").toBeTruthy();
  const csp = parseCsp(header);

  for (const [directive, required] of Object.entries({
    "script-src": EXPECTED_SCRIPT_SRC,
    "frame-src": EXPECTED_FRAME_SRC,
    "connect-src": EXPECTED_CONNECT_SRC,
    "img-src": EXPECTED_IMG_SRC,
  })) {
    const sources = csp.get(directive) ?? [];
    for (const source of required) {
      expect(sources, `${directive} must allow ${source}`).toContain(source);
    }
  }

  // The policy is locked down: no inline script execution and no wildcard
  // hosts, plus the standard hardening directives.
  const scriptSrc = csp.get("script-src") ?? [];
  expect(scriptSrc).not.toContain("'unsafe-inline'");
  expect(scriptSrc.every((source) => !source.includes("*"))).toBeTruthy();
  expect(csp.get("frame-ancestors")).toEqual(["'none'"]);
  expect(csp.get("base-uri")).toEqual(["'self'"]);
  expect(csp.get("form-action")).toEqual(["'none'"]);
});

test.describe("live enforcement", () => {
  let provider;
  test.beforeAll(async () => {
    provider = await tradingViewReachable();
  });
  test.beforeEach(() => {
    test.skip(!provider.reachable, `TradingView unreachable (${provider.detail}) — cannot prove live enforcement`);
  });

  test("loads the homepage with every TradingView resource allowed — no CSP violations", async ({ page }) => {
    await installShadowRootProbe(page);
    const violations = collectCspViolations(page);
    const response = await page.goto("/", { waitUntil: "domcontentloaded" });
    const cspHeader = response?.headers()["content-security-policy"];
    expect(cspHeader).toBeTruthy();
    const frameSrcHosts = (parseCsp(cspHeader).get("frame-src") ?? []).map((source) => {
      try {
        return new URL(source).hostname;
      } catch {
        return null;
      }
    });

    // script-src permits the cross-origin web-component modules: the elements
    // register only if the loader's dynamic import was allowed to run.
    await waitForTradingViewElement(page, "tv-ticker-tape");
    await waitForTradingViewElement(page, "tv-market-overview");

    // frame-src permits the embed-widget iframes (calendar + stories). They
    // lazy-load below the fold, so scroll them into view first.
    const calendar = page.locator(".tv-widget-events");
    await calendar.scrollIntoViewIfNeeded();
    await expect(calendar.locator("iframe")).toBeVisible({ timeout: 20_000 });
    const stories = page.locator(".tv-widget-timeline");
    await stories.scrollIntoViewIfNeeded();
    await expect(stories.locator("iframe")).toBeVisible({ timeout: 20_000 });

    for (const widget of [calendar, stories]) {
      const src = await widget.locator("iframe").getAttribute("src");
      expect(src, "widget iframe must be served from an allowlisted host").toBeTruthy();
      const host = new URL(src).hostname;
      expect(frameSrcHosts, `frame-src must allow ${host}`).toContain(host);
    }

    // Let late requests settle, then assert nothing was blocked and no widget
    // fell back to its error state.
    await page.waitForTimeout(1_500);
    expect(violations, "no CSP violation may be emitted").toEqual([]);
    await expect(page.locator(".tv-widget-error")).toHaveCount(0);
  });
});
