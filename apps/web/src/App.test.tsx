import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { lazy, Suspense } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { LazyPageErrorBoundary } from "./morning-briefing/shared";
import appSource from "./App.tsx?raw";
import indexHtml from "../index.html?raw";
import cloudflareHeaders from "../public/_headers?raw";

vi.mock("./morning-briefing/stock-detail/StockDetailPage", () => ({
  default: () => <div className="stock-detail-test-route"><h1>Stock detail route</h1><p>Dynamic stock detail page</p></div>,
}));

beforeEach(() => {
  localStorage.clear();
  // A fixed instant for the data fetches; the hero's local-time greeting/date
  // are deliberately NOT asserted here (they live in the pure-helper tests).
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-08-12T16:00:00Z"));
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline test fallback")));
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false, media: query, onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
      addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    })),
  });
  Object.defineProperty(window, "scrollTo", { configurable: true, value: vi.fn() });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("ships restrictive Cloudflare static-asset headers", () => {
  expect(cloudflareHeaders).toContain("Content-Security-Policy:");
  expect(cloudflareHeaders).toContain("frame-ancestors 'none'");
  expect(cloudflareHeaders).toContain("X-Frame-Options: DENY");
});

it("allows only the official TradingView hosts plus Finnhub logo CDNs in the CSP", () => {
  // The homepage embeds official TradingView widgets: the ES-module web
  // components load from widgets.tradingview-widget.com and fetch their datafeed
  // from the same host (script-src/connect-src + the internal datafeed iframe in
  // frame-src); the iframe widgets' bootstrap scripts load from s3.tradingview.com
  // and render from tradingview-widget.com (s.tradingview.com fallback), sending
  // TradingView's own analytics beacon to snowplow-pixel.tradingview.com
  // (connect-src); symbol logos load from s3-symbol-logo.tradingview.com
  // (img-src). Earnings company logos load from Finnhub's static CDNs only
  // (img-src). No other third party, and no inline scripts.
  expect(cloudflareHeaders).toContain(
    "script-src 'self' https://s3.tradingview.com https://widgets.tradingview-widget.com;",
  );
  expect(cloudflareHeaders).toContain(
    "connect-src 'self' https://widgets.tradingview-widget.com https://snowplow-pixel.tradingview.com;",
  );
  expect(cloudflareHeaders).toContain(
    "img-src 'self' data: https://s3-symbol-logo.tradingview.com https://widgets.tradingview-widget.com https://static.finnhub.io https://static2.finnhub.io https://static9.finnhub.io;",
  );
  expect(cloudflareHeaders).toContain(
    "frame-src https://www.tradingview-widget.com https://s.tradingview.com https://widgets.tradingview-widget.com;",
  );
  // Inline styles are allowed (the theme and shadow DOM use them), but inline
  // scripts are not.
  expect(cloudflareHeaders).not.toContain("script-src 'self' 'unsafe-inline'");
  expect(cloudflareHeaders).not.toMatch(/img-src[^;]*\*/);
});

it("ships How Are The Markets metadata in the static HTML fallback", () => {
  expect(indexHtml).toContain("<title>How Are The Markets — Market Intelligence &amp; Stock Analysis</title>");
  expect(indexHtml).toContain('name="application-name" content="How Are The Markets"');
  expect(indexHtml).toContain("Market overview, stock screener, technical levels, earnings and market intelligence in one place.");
  expect(indexHtml).toContain('href="/brand/favicon.svg"');
  expect(indexHtml).not.toContain("Stock Autotrader");
  expect(indexHtml).not.toContain("Stock Daily Briefing");
});

it("keeps Stock Detail and Lightweight Charts behind the lazy route boundary", () => {
  expect(appSource).toContain('lazy(() => import("./morning-briefing/stock-detail/StockDetailPage"))');
  expect(appSource).not.toContain("lightweight-charts");
  expect(appSource).not.toMatch(/from\s+["']\.\/morning-briefing\/stock-detail\/StockDetailPage["']/);
});

it("shows an accessible recovery state when a lazy page fails", async () => {
  const FailedPage = lazy(() => Promise.reject(new Error("chunk failed")));
  const ReadyPage = () => <h1>Recovered page</h1>;
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    const view = render(<LazyPageErrorBoundary resetKey="failed"><Suspense fallback={<div role="status">Loading…</div>}><FailedPage /></Suspense></LazyPageErrorBoundary>);
    expect(await screen.findByRole("alert")).toHaveTextContent("Page unavailable");
    expect(screen.getByRole("button", { name: "Reload page" })).toBeInTheDocument();
    view.rerender(<LazyPageErrorBoundary resetKey="recovered"><Suspense fallback={<div role="status">Loading…</div>}><ReadyPage /></Suspense></LazyPageErrorBoundary>);
    expect(await screen.findByRole("heading", { name: "Recovered page" })).toBeInTheDocument();
  } finally {
    errorSpy.mockRestore();
  }
});

describe("Morning Briefing public experience", () => {
  it.each(["/", "/dashboard"])("opens Morning Briefing at %s", (path) => {
    render(<MemoryRouter initialEntries={[path]}><App /></MemoryRouter>);
    // The hero greeting is the visitor's local time (covered by pure-function
    // helper tests); the subtitle is static and TZ-independent.
    expect(screen.getByText(/economic calendar and top stories/)).toBeInTheDocument();
    // The homepage keeps only Market Overview, Economic Calendar, Fear & Greed
    // and Top Stories — Top Opportunities is removed for now.
    expect(screen.queryByText("Top Opportunities")).not.toBeInTheDocument();
    expect(screen.queryByText(/log in|sign in/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /buy|sell|trade/i })).not.toBeInTheDocument();
  });

  it("opens the X Pulse route directly", async () => {
    render(<MemoryRouter initialEntries={["/x"]}><App /></MemoryRouter>);
    expect(await screen.findByRole("heading", { name: /X Pulse/ })).toBeInTheDocument();
  });

  it("opens the Earnings route directly", async () => {
    render(<MemoryRouter initialEntries={["/earnings"]}><App /></MemoryRouter>);
    expect(await screen.findByRole("heading", { name: /Earnings Calendar/ })).toBeInTheDocument();
  });

  it("opens the Heatmap route directly", async () => {
    render(<MemoryRouter initialEntries={["/heatmap"]}><App /></MemoryRouter>);
    expect(await screen.findByRole("heading", { level: 1, name: "Heatmap" })).toBeInTheDocument();
  });

  it("opens the dynamic stock detail route inside the existing shell", async () => {
    render(<MemoryRouter initialEntries={["/stocks/NVDA"]}><App /></MemoryRouter>);
    expect(await screen.findByRole("heading", { name: "Stock detail route" })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Primary navigation" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Screener/ })).toBeInTheDocument();
  });

  it.each([
    "/signals", "/strategies",
    "/strategies/trend_breakout_v1", "/research", "/research/example",
    "/portfolio", "/market-data", "/activity",
  ])("redirects legacy route %s to Morning Briefing", async (path) => {
    render(<MemoryRouter initialEntries={[path]}><App /></MemoryRouter>);
    // Static hero subtitle confirms the briefing landed, independent of the
    // machine timezone the local-time greeting/date depends on.
    expect(await screen.findByText(/economic calendar and top stories/)).toBeInTheDocument();
  });

  it("opens the Screener route directly", async () => {
    render(<MemoryRouter initialEntries={["/screener"]}><App /></MemoryRouter>);
    expect(await screen.findByRole("heading", { name: "Screener" })).toBeInTheDocument();
  });

  it("redirects the legacy /scanner route to the Screener", async () => {
    render(<MemoryRouter initialEntries={["/scanner"]}><App /></MemoryRouter>);
    expect(await screen.findByRole("heading", { name: "Screener" })).toBeInTheDocument();
  });

  it.each([["/status", "System status"]])("keeps public information route %s", (path, heading) => {
    render(<MemoryRouter initialEntries={[path]}><App /></MemoryRouter>);
    expect(screen.getByRole("heading", { name: heading })).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent("Not connected in PR #6");
    expect(document.body).not.toHaveTextContent("Live publication arrives in a later release");
  });

  it("keeps the status route free of technical source indicators", () => {
    render(<MemoryRouter initialEntries={["/status"]}><App /></MemoryRouter>);
    expect(screen.getByRole("heading", { name: "System status" })).toBeInTheDocument();
    expect(screen.queryByText("Backend integration")).not.toBeInTheDocument();
    expect(screen.queryByText("Temporarily unavailable")).not.toBeInTheDocument();
    expect(screen.queryByText("Online and healthy")).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(/fresh|stale|fallback/i);
  });
});
