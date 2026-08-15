import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import MorningBriefingApp from "./MorningBriefingApp";
import { isDisplayableMarketIndex } from "./MorningBriefingData";

const renderApp = (path = "/") => render(<MemoryRouter initialEntries={[path]}><MorningBriefingApp/></MemoryRouter>);
const useFixtureClock = () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date("2026-08-12T22:30:00Z"));
};

const briefing = {
  example: false,
  editionDate: "2026-08-12",
  editionType: "pre_market",
  timezone: "America/New_York",
  preparedAt: "2026-08-12T12:30:00Z",
  title: "Pre-market briefing",
  marketSummary: "Constructive session.",
  market: [
    { name: "VIX", symbol: "CBOE:VIX", value: "15.40", change: "-2.10%", state: "Contained", note: "Calm." },
    { name: "Nasdaq-100", symbol: "NASDAQ:NDX", value: "23,830.02", change: "+0.55%", state: "Leading", note: "Leading." },
    { name: "S&P 500", symbol: "SP:SPX", value: "6,412.10", change: "+0.31%", state: "Constructive", note: "Holding." },
  ],
  ideas: [{
    symbol: "NVDA", company: "NVIDIA Corporation", universe: "Both",
    verdict: "Potential Entry", price: "$183.10", change: "+1.75%",
    thesis: "Relative strength supports the setup.",
    source: { handle: "@nolimitgains", reference: "https://x.com/nolimitgains/status/1234", originalTimestamp: "2026-08-12T10:15:00Z", collectedTimestamp: "2026-08-12T12:30:00Z", summary: "Source." },
    technical: ["Strong"], financial: ["Healthy"], news: ["Clear"], risks: ["Gap risk"],
    levels: { trigger: "Above $183.60", invalidation: "Below $179.20", objective: "$194", rewardRisk: "2.6R", rewardRiskRatio: 2.6 },
  }, {
    symbol: "AMD", company: "Advanced Micro Devices", universe: "Both",
    verdict: "Potential Entry", price: "$184.00", change: "-1.25%",
    thesis: "Valid setup despite a negative session.",
    source: { handle: "@nolimitgains", reference: "https://x.com/nolimitgains/status/5678", originalTimestamp: "2026-08-12T10:15:00Z", collectedTimestamp: "2026-08-12T12:30:00Z", summary: "Source." },
    technical: ["Strong"], financial: ["Healthy"], news: ["Clear"], risks: ["Gap risk"],
    levels: { trigger: "Above $185", invalidation: "Below $179", objective: "$194", rewardRisk: "2.0R", rewardRiskRatio: 2 },
  }, {
    symbol: "TSLA", company: "Tesla", universe: "Both", verdict: "Avoid", price: "$400", change: "+4.00%",
    thesis: "Explicit rejection.", source: { handle: "@source", reference: "https://x.com/source/1", originalTimestamp: null, collectedTimestamp: "2026-08-12T12:30:00Z", summary: "Source." },
    technical: ["Weak"], financial: ["Mixed"], news: ["Risk"], risks: ["High risk"],
    levels: { trigger: "Not applicable", invalidation: "Not applicable", objective: "Not applicable", rewardRisk: "Not applicable", rewardRiskRatio: null },
  }],
  schedule: [],
};

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-08-12T22:30:00Z"));
  Object.defineProperty(window, "matchMedia", { configurable: true, value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })) });
  Object.defineProperty(window, "scrollTo", { configurable: true, value: vi.fn() });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/briefs/latest") return new Response(JSON.stringify(briefing), { status: 200 });
    if (url === "/api/status") return new Response(JSON.stringify({
      candidates: [{ symbol: "NVDA", quantScore: 91 }],
      briefing: { available: true, freshness: "fresh", publishedAt: briefing.preparedAt },
      market: { indices: [
        { symbol: "SPX", name: "S&P 500", value: 6412.10, change: 0.31, updatedAt: "2026-08-12T20:00:00Z" },
        { symbol: "NDX", name: "Nasdaq-100", value: 23830.02, change: 0.55, updatedAt: "2026-08-12T20:00:00Z" },
        { symbol: "DJI", name: "Dow Jones", value: 45118.26, change: 0.48, updatedAt: "2026-08-12T20:00:00Z" },
        { symbol: "VIX", name: "VIX", value: 15.40, change: -2.10, updatedAt: "2026-08-12T20:00:00Z" },
      ] },
    }), { status: 200 });
    if (url.startsWith("/api/x/posts")) return new Response(JSON.stringify({ posts: [
      { id: "older", author: "@nolimitgains", text: "Older post", created_at: "2026-08-11T19:30:00Z", url: "https://x.com/nolimitgains/status/older", symbol: null, company: null, price: null, change: null },
      { id: "newer", author: "@nolimitgains", text: "Newest post", created_at: "2026-08-12T20:30:00Z", url: "https://x.com/nolimitgains/status/newer", symbol: null, company: null, price: null, change: null },
    ], count: 2 }), { status: 200 });
    if (url === "/api/earnings") return new Response(JSON.stringify([
      { symbol: "OLD", company: "Past Corp", date: "2026-08-03", timing: "AMC", eventSignal: "Confirmed" },
      { symbol: "NEW", company: "Future Corp", date: "2026-08-14", timing: "BMO", eventSignal: "Confirmed" },
    ]), { status: 200 });
    if (url === "/api/market-data") return new Response(JSON.stringify({ benchmarks: [] }), { status: 200 });
    return new Response(null, { status: 404 });
  }));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("keeps a validated previous market session visible during the next session gap", () => {
  expect(isDisplayableMarketIndex("2026-08-12T20:00:00Z", Date.parse("2026-08-13T12:00:00Z"))).toBe(true);
  expect(isDisplayableMarketIndex("2026-08-14T20:00:00Z", Date.parse("2026-08-15T18:00:00Z"))).toBe(true);
});

it("accepts current-session indices but rejects genuinely stale observations", () => {
  expect(isDisplayableMarketIndex("2026-08-13T16:00:00Z", Date.parse("2026-08-13T20:00:00Z"))).toBe(true);
  expect(isDisplayableMarketIndex("2026-08-12T09:00:00Z", Date.parse("2026-08-13T12:00:00Z"))).toBe(false);
});

it("keeps the latest validated session visible before the next US open", async () => {
  vi.mocked(Date.now).mockReturnValue(Date.parse("2026-08-14T08:30:00Z"));
  vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/briefs/latest") return new Response(null, { status: 404 });
    if (url === "/api/status") return new Response(JSON.stringify({
      briefing: { available: false, freshness: "unavailable", publishedAt: null },
      market: {
        // The provider's previous-session bars are midnight-dated, while the
        // Worker collected and validated them during the session.
        latestSourceTimestamp: "2026-08-13T00:00:00-04:00",
        latestCollectedAt: "2026-08-13T16:00:00.000Z",
        indices: [
          { symbol: "SPX", name: "S&P 500", value: 7777.69, change: 0.38, updatedAt: "2026-08-13T00:00:00-04:00" },
          { symbol: "NDX", name: "Nasdaq-100", value: 30004.93, change: 0.88, updatedAt: "2026-08-13T00:00:00-04:00" },
          { symbol: "DJI", name: "Dow Jones", value: 53659.20, change: -0.21, updatedAt: "2026-08-13T00:00:00-04:00" },
          { symbol: "VIX", name: "VIX", value: 14.71, change: 1.10, updatedAt: "2026-08-13T00:00:00-05:00" },
        ],
      },
    }), { status: 200 });
    return new Response(null, { status: 404 });
  });

  const view = renderApp();
  await waitFor(() => expect(view.container.querySelectorAll(".market-card")).toHaveLength(4));
  expect(view.container.querySelector(".market-section")).not.toHaveTextContent("Not available");
  expect(view.container.querySelector(".market-section")).toHaveTextContent(/Updated 13 Aug/);
});

it("labels retained market quotes stale after a status refresh fails", async () => {
  let statusCalls = 0;
  const originalFetch = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === "/api/status") {
      statusCalls += 1;
      if (statusCalls > 1) return new Response(null, { status: 503 });
    }
    return originalFetch(input, init);
  });

  const view = renderApp();
  await waitFor(() => expect(view.container.querySelector(".market-section")).not.toHaveTextContent("Not available"));
  document.dispatchEvent(new Event("visibilitychange"));
  await waitFor(() => expect(statusCalls).toBeGreaterThanOrEqual(2));
  expect(view.container.querySelector(".market-section .card-subtitle")).toHaveTextContent("Stale");
});

it("renders a persisted market snapshot with an explicit stale label after a provider outage", async () => {
  vi.mocked(Date.now).mockReturnValue(Date.parse("2026-08-14T22:30:00Z"));
  vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/briefs/latest") return new Response(null, { status: 404 });
    if (url === "/api/status") return new Response(JSON.stringify({
      market: {
        latestCollectedAt: "2026-08-14T00:00:00.000Z",
        indices: [
          { symbol: "SPX", name: "S&P 500", value: 7777.69, change: 0.38, updatedAt: "2026-08-13T00:00:00-04:00" },
          { symbol: "NDX", name: "Nasdaq-100", value: 30004.93, change: 0.88, updatedAt: "2026-08-13T00:00:00-04:00" },
          { symbol: "DJI", name: "Dow Jones", value: 53659.20, change: -0.21, updatedAt: "2026-08-13T00:00:00-04:00" },
          { symbol: "VIX", name: "VIX", value: 14.71, change: 1.10, updatedAt: "2026-08-13T00:00:00-05:00" },
        ],
      },
      sources: { market: { state: "Cached", error: "SPX: provider HTTP 429" } },
    }), { status: 200 });
    return new Response(null, { status: 404 });
  });

  const view = renderApp();
  await waitFor(() => expect(view.container.querySelectorAll(".market-card")).toHaveLength(4));
  expect(view.container.querySelector(".market-section")).toHaveTextContent("SPX");
  expect(view.container.querySelector(".market-section .card-subtitle")).toHaveTextContent("Stale");
  expect(view.container.querySelector(".market-section")).not.toHaveTextContent("Not available");
});

it("renders only qualified ideas and classifies scheduled earnings by date", async () => {
  useFixtureClock();
  const view = renderApp();
  await waitFor(() => expect(view.container.querySelector(".market-status")).toHaveTextContent("S&P 500 up +0.31%"));
  expect(screen.getByText("+1.75%")).toBeInTheDocument();
  expect(screen.getAllByText("Not published").length).toBeGreaterThan(0);
  expect(screen.queryByText("TSLA")).not.toBeInTheDocument();
  const negative = screen.getByText("-1.25%");
  expect(negative).toHaveClass("negative");
  expect(screen.queryByText("+-1.25%")).not.toBeInTheDocument();
  expect(screen.getByText("WEDNESDAY · 12 AUGUST · PRE-MARKET")).toBeInTheDocument();
  expect(view.container.querySelector(".market-status")).toHaveTextContent("S&P 500 up +0.31%");
  expect(view.container.querySelector(".earnings-mini")).toHaveTextContent("Future Corp");
  expect(view.container.querySelector(".earnings-mini")).not.toHaveTextContent("Past Corp");
});

it("fails closed when the earnings payload has an invalid event list", async () => {
  const originalFetch = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === "/api/earnings") return new Response(JSON.stringify({ events: {} }), { status: 200 });
    return originalFetch(input, init);
  });

  const view = renderApp();
  await waitFor(() => expect(view.container.querySelector(".earnings-mini")).toHaveTextContent("No upcoming earnings published."));
  expect(view.container.querySelector(".recent-results")).toHaveTextContent("No recent earnings published.");
});

it("fails closed when an earnings event contains an invalid date", async () => {
  vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
    if (String(input) === "/api/earnings") return new Response(JSON.stringify([
      { symbol: "BAD", company: "Malformed Corp", date: "2026-99-99", timing: "BMO" },
    ]), { status: 200 });
    return new Response(null, { status: 404 });
  });

  const view = renderApp();
  await waitFor(() => expect(view.container.querySelector(".earnings-mini")).toHaveTextContent("No upcoming earnings published."));
  expect(view.container).not.toHaveTextContent("Malformed Corp");
});

it("announces the full date for earnings calendar events", async () => {
  sessionStorage.clear();
  renderApp("/earnings");
  expect(await screen.findByRole("heading", { name: "Earnings Calendar" })).toBeInTheDocument();
  expect(await screen.findByRole("button", { name: /Future Corp, Scheduled · BMO, Friday, August 14, 2026/i })).toBeInTheDocument();
});

it("accepts a full-shape earnings payload exactly as the worker emits it", async () => {
  vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
    if (String(input) === "/api/earnings") return new Response(JSON.stringify({
      events: [{
        id: "evt-1", symbol: "FULL", company: "Full Shape Corp", cik: "0001045810",
        fiscalYear: 2027, fiscalQuarter: 2, fiscalPeriod: "2027 Q2", fiscalPeriodEnd: "2026-07-31",
        scheduledDate: "2026-08-19", scheduledTime: "09:00", timing: "BMO",
        status: "scheduled", scheduled: true, reported: false, cancelled: false, unknown: false,
        epsEstimate: 0.87, epsActual: null, epsSurprise: null, epsSurprisePct: null, epsResult: "Not Available",
        revenueEstimate: 28500000000, revenueActual: null, revenueSurprise: null, revenueSurprisePct: null, revenueResult: "Not Available",
        overallResult: "Not Available", reportedAt: null,
        calendarProvider: "Finnhub", consensusProvider: "Finnhub", providerEventId: "evt-1",
        providerUpdatedAt: "2026-08-12T10:00:00Z", officialReportUrl: null, investorRelationsUrl: null,
        secFilingUrl: null, secAccession: null, secForm: null, secFiledAt: null,
        createdAt: "2026-08-12T10:00:00Z", updatedAt: "2026-08-12T10:00:00Z", lastCheckedAt: null,
      }],
      summary: { today: 0, thisWeek: 0, next60Days: 1 },
      from: "2026-01-01", to: "2026-10-11",
    }), { status: 200 });
    return new Response(null, { status: 404 });
  });

  const view = renderApp();
  await waitFor(() => expect(view.container.querySelector(".earnings-mini")).toHaveTextContent("Full Shape Corp"));
  expect(view.container.querySelector(".earnings-mini")).toHaveTextContent("FULL");
});

it("drops only the invalid records and keeps the valid ones", async () => {
  vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
    if (String(input) === "/api/earnings") return new Response(JSON.stringify([
      { symbol: "GOOD", company: "Valid Corp", date: "2026-08-19", timing: "BMO" },
      { symbol: "BAD", company: "Malformed Corp", date: "2026-99-99", timing: "BMO" },
    ]), { status: 200 });
    return new Response(null, { status: 404 });
  });

  const view = renderApp();
  await waitFor(() => expect(view.container.querySelector(".earnings-mini")).toHaveTextContent("Valid Corp"));
  expect(view.container.querySelector(".earnings-mini")).not.toHaveTextContent("Malformed Corp");
});

it("treats a valid empty earnings publication as available, not unavailable", async () => {
  sessionStorage.clear();
  vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
    if (String(input) === "/api/earnings") return new Response(JSON.stringify({
      events: [],
      summary: { today: 0, thisWeek: 0, next60Days: 0 },
      from: "2026-01-01", to: "2026-10-11",
    }), { status: 200 });
    return new Response(null, { status: 404 });
  });

  const view = renderApp("/earnings");
  await waitFor(() => expect(view.container.querySelector(".earnings-top-summary")).toHaveTextContent("reports"));
  expect(view.container.querySelector(".earnings-top-summary")).toHaveTextContent("0");
  expect(view.container.querySelector(".earnings-top-summary")).not.toHaveTextContent("—");
});

it("starts financially actionable sections empty when the backend has no data", async () => {
  vi.mocked(fetch).mockImplementation(async () => new Response(null, { status: 503 }));
  const view = renderApp();

  expect(await screen.findByText("Market data")).toBeInTheDocument();
  expect(view.container.querySelectorAll(".market-card")).toHaveLength(4);
  expect(view.container.querySelector(".market-grid")).toHaveTextContent("S&P 500");
  expect(view.container.querySelector(".market-grid")).toHaveTextContent("Nasdaq-100");
  expect(view.container.querySelector(".market-grid")).toHaveTextContent("Dow Jones");
  expect(view.container.querySelector(".market-grid")).toHaveTextContent("VIX");
  expect(view.container.querySelector(".market-grid")).toHaveTextContent("Not available");
  expect(view.container.querySelectorAll(".opportunity-row")).toHaveLength(0);
  expect(view.container.querySelector(".opportunities-card .empty-state")).toHaveTextContent("No qualified opportunities");
  expect(view.container).not.toHaveTextContent("6,427.18");
  expect(view.container).not.toHaveTextContent("NVDA");
});

it("keeps unavailable market panel values explicit without fixture numbers", async () => {
  vi.mocked(fetch).mockImplementation(async () => new Response(null, { status: 503 }));
  const view = renderApp();

  expect(screen.getByRole("heading", { name: "Fear & Greed" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: /Momentum Not available/ })).toBeInTheDocument();
  expect(view.container.querySelector(".sentiment-card")).toHaveTextContent("Not available");
  expect(view.container.querySelector(".quick-card")).toHaveTextContent("10Y Treasury Yield");
  expect(view.container.querySelector(".quick-card")).toHaveTextContent("Not available");
  expect(view.container).not.toHaveTextContent("72");
  expect(view.container).not.toHaveTextContent("4.28%");
  expect(view.container).not.toHaveTextContent("$80.21");
});

it("preserves a Unicode minus when rendering negative moves", async () => {
  const unicodeBriefing = {
    ...briefing,
    market: briefing.market.map((item) => item.name === "S&P 500" ? { ...item, change: "−0.31%" } : item),
    ideas: briefing.ideas.map((item) => item.symbol === "AMD" ? { ...item, change: "−1.25%" } : item),
  };
  vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/briefs/latest") return new Response(JSON.stringify(unicodeBriefing), { status: 200 });
    if (url === "/api/status") return new Response(JSON.stringify({ candidates: [], briefing: { available: true, freshness: "fresh", publishedAt: briefing.preparedAt }, market: { indices: [
      { symbol: "SPX", name: "S&P 500", value: 6412.10, change: -0.31, updatedAt: "2026-08-12T20:00:00Z" },
      { symbol: "NDX", name: "Nasdaq-100", value: 23830.02, change: 0.55, updatedAt: "2026-08-12T20:00:00Z" },
      { symbol: "DJI", name: "Dow Jones", value: 45118.26, change: 0.48, updatedAt: "2026-08-12T20:00:00Z" },
      { symbol: "VIX", name: "VIX", value: 15.40, change: -2.10, updatedAt: "2026-08-12T20:00:00Z" },
    ] } }), { status: 200 });
    return new Response(null, { status: 404 });
  });

  const view = renderApp();
  await waitFor(() => expect(view.container.querySelector(".market-status")).toHaveTextContent("S&P 500 down -0.31%"));
  expect(screen.getByText("-1.25%")).toHaveClass("negative");
  expect(screen.queryByText("+-1.25%")).not.toBeInTheDocument();
});

it("keeps every supported benchmark card visible", async () => {
  const view = renderApp();
  await waitFor(() => expect(view.container.querySelectorAll(".market-card")).toHaveLength(4));
  expect(view.container.querySelector(".market-card")).toHaveTextContent("S&P 500");
  expect(view.container).toHaveTextContent("Dow Jones");
  expect(view.container.querySelectorAll(".market-card")[2]).not.toHaveTextContent("Not available");
});

it("does not fill a live market snapshot with unsupported mock benchmarks", async () => {
  const snapshot = {
    provider: "market-api", status: "healthy", asOf: "2026-08-12",
    lastSuccessfulUpdate: "2026-08-12T20:00:00Z",
    universe: { total: 2, eligible: 2, excluded: 0 },
    benchmarks: [
      { symbol: "SPY", date: "2026-08-12", open: 640, high: 645, low: 639, close: 642, adjustedClose: 642, volume: 1 },
      { symbol: "QQQ", date: "2026-08-12", open: 570, high: 575, low: 569, close: 573, adjustedClose: 573, volume: 1 },
    ],
    warnings: [], updatedAt: "2026-08-12T20:00:00Z",
  };
  vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/status") return new Response(JSON.stringify({ candidates: [] }), { status: 200 });
    if (url === "/api/market-data") return new Response(JSON.stringify(snapshot), { status: 200 });
    return new Response(null, { status: 404 });
  });

  const view = renderApp();
  await waitFor(() => expect(view.container.querySelectorAll(".market-card")).toHaveLength(4));
  expect(view.container.querySelectorAll(".market-card")[0]).toHaveTextContent("Not available");
  expect(view.container).toHaveTextContent("Dow Jones");
  expect(view.container).not.toHaveTextContent("642.00");
  expect(view.container).not.toHaveTextContent("573.00");
});

it("does not use legacy status candidates or market-data snapshots without a fresh briefing", async () => {
  const snapshot = {
    provider: "legacy-market-api", status: "healthy", asOf: "2026-08-12",
    lastSuccessfulUpdate: "2026-08-12T20:00:00Z",
    universe: { total: 2, eligible: 2, excluded: 0 },
    benchmarks: [
      { symbol: "SP:SPX", date: "2026-08-12", open: 6400, high: 6450, low: 6390, close: 6420, adjustedClose: 6420, volume: 1 },
      { symbol: "NASDAQ:NDX", date: "2026-08-12", open: 23700, high: 23800, low: 23600, close: 23750, adjustedClose: 23750, volume: 1 },
    ],
    warnings: [], updatedAt: "2026-08-12T20:00:00Z",
  };
  vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/status") return new Response(JSON.stringify({
      status: { engine: "online", apiHealth: "healthy", lastDataUpdate: "2026-08-12T20:00:00Z" },
      candidates: [],
      marketData: snapshot,
      briefing: { available: false, freshness: "unavailable", publishedAt: null },
    }), { status: 200 });
    if (url === "/api/market-data") return new Response(JSON.stringify(snapshot), { status: 200 });
    return new Response(null, { status: 404 });
  });

  const view = renderApp();
  await waitFor(() => expect(view.container.querySelector(".market-status")).toHaveTextContent("Not available"));
  expect(view.container.querySelectorAll(".opportunity-row")).toHaveLength(0);
  expect(view.container).not.toHaveTextContent("6,420.00");
  expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input) === "/api/market-data")).toBe(false);
});

it("labels a post-close edition instead of showing a morning greeting", async () => {
  const postCloseBriefing = { ...briefing, editionType: "post_close", title: "Closing briefing" };
  vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/briefs/latest") return new Response(JSON.stringify(postCloseBriefing), { status: 200 });
    if (url === "/api/status") return new Response(JSON.stringify({ candidates: [], briefing: { available: true, freshness: "fresh", publishedAt: briefing.preparedAt }, market: { indices: [
      { symbol: "SPX", name: "S&P 500", value: 6412.10, change: 0.31, updatedAt: "2026-08-12T20:00:00Z" },
      { symbol: "NDX", name: "Nasdaq-100", value: 23830.02, change: 0.55, updatedAt: "2026-08-12T20:00:00Z" },
      { symbol: "DJI", name: "Dow Jones", value: 45118.26, change: 0.48, updatedAt: "2026-08-12T20:00:00Z" },
      { symbol: "VIX", name: "VIX", value: 15.40, change: -2.10, updatedAt: "2026-08-12T20:00:00Z" },
    ] } }), { status: 200 });
    return new Response(null, { status: 404 });
  });

  renderApp();
  expect(await screen.findByRole("heading", { name: "Market close." })).toBeInTheDocument();
  expect(screen.getByText("WEDNESDAY · 12 AUGUST · POST-CLOSE")).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "Good morning." })).not.toBeInTheDocument();
});

it("renders the briefing without waiting for a stalled X request", async () => {
  useFixtureClock();
  vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/briefs/latest") return new Response(JSON.stringify(briefing), { status: 200 });
    if (url === "/api/status") return new Response(JSON.stringify({ candidates: [], briefing: { available: true, freshness: "fresh", publishedAt: briefing.preparedAt }, market: { indices: [
      { symbol: "SPX", name: "S&P 500", value: 6412.10, change: 0.31, updatedAt: "2026-08-12T20:00:00Z" },
      { symbol: "NDX", name: "Nasdaq-100", value: 23830.02, change: 0.55, updatedAt: "2026-08-12T20:00:00Z" },
      { symbol: "DJI", name: "Dow Jones", value: 45118.26, change: 0.48, updatedAt: "2026-08-12T20:00:00Z" },
      { symbol: "VIX", name: "VIX", value: 15.40, change: -2.10, updatedAt: "2026-08-12T20:00:00Z" },
    ] } }), { status: 200 });
    if (url.startsWith("/api/x/posts")) return await new Promise<Response>(() => undefined);
    if (url === "/api/earnings") return new Response(JSON.stringify([{ symbol: "NEW", company: "Future Corp", date: "2026-08-14", timing: "BMO", eventSignal: "Confirmed" }]), { status: 200 });
    return new Response(null, { status: 404 });
  });

  const view = renderApp();
  await waitFor(() => expect(view.container.querySelector(".market-status")).toHaveTextContent("S&P 500 up +0.31%"));
  expect(screen.getByText("Future Corp")).toBeInTheDocument();
});

it("keeps the last X posts when a later refresh fails", async () => {
  let xRequests = 0;
  const originalFetch = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).startsWith("/api/x/posts")) {
      xRequests += 1;
      if (xRequests > 1) return new Response(null, { status: 503 });
    }
    return originalFetch(input, init);
  });

  renderApp("/x");
  await screen.findByText("Newest post");
  vi.mocked(Date.now).mockReturnValue(Date.parse("2026-08-13T01:30:00Z"));
  document.dispatchEvent(new Event("visibilitychange"));
  await waitFor(() => expect(xRequests).toBe(2));
  expect(screen.getByText("Newest post")).toBeInTheDocument();
  expect(screen.getByText("5h")).toBeInTheDocument();
  expect(screen.getByText("1d 6h")).toBeInTheDocument();
  expect(screen.queryByText("Last update")).not.toBeInTheDocument();
});

it("keeps posts available during temporary feed failures without freshness badges", async () => {
  let xRequests = 0;
  const originalFetch = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).startsWith("/api/x/posts")) {
      xRequests += 1;
      if (xRequests === 1) return new Response(JSON.stringify({ posts: [
        { id: "p1", author: "@nolimitgains", text: "First post", created_at: "2026-08-12T20:30:00Z", url: "https://x.com/nolimitgains/status/p1", symbol: null, company: null, price: null, change: null },
      ], count: 1 }), { status: 200 });
      return new Response(null, { status: 503 });
    }
    return originalFetch(input, init);
  });

  const view = renderApp("/x");
  await screen.findByText("First post");
  document.dispatchEvent(new Event("visibilitychange"));
  await waitFor(() => expect(xRequests).toBe(2));
  expect(screen.getByText("First post")).toBeInTheDocument();
  expect(view.container.querySelector(".post-status .data-source")).toBeNull();
});

it("does not show mock X posts after a successful empty feed", async () => {
  const originalFetch = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).startsWith("/api/x/posts")) return new Response(JSON.stringify({ posts: [], count: 0 }), { status: 200 });
    return originalFetch(input, init);
  });

  const view = renderApp("/x");
  await waitFor(() => expect(view.container.querySelector(".empty-state")).toHaveTextContent("No recent posts."));
  expect(view.container.querySelector(".post-card")).toBeNull();
  expect(screen.queryByText("Two scenarios for GOOGL and MSFT from an earlier call both played out at the same time: $GOOGL down 11% while $MSFT is up 22%.")).not.toBeInTheDocument();
});

it("renders retained X posts immediately while the network is unavailable", () => {
  localStorage.setItem("morning-briefing-x-post-cache-v1", JSON.stringify([{
    category: "Markets",
    name: "Nolimit Gains",
    handle: "@nolimitgains",
    time: "2h",
    createdAt: "2026-08-12T20:30:00Z",
    text: "Cached before network",
    likes: "—",
    reposts: "—",
    replies: "—",
    color: "#176b47",
    url: "https://x.com/nolimitgains/status/cached-before-network",
  }]));
  vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
    if (String(input).startsWith("/api/x/posts")) return await new Promise<Response>(() => undefined);
    return new Response(null, { status: 503 });
  });

  renderApp("/x");
  expect(screen.getByText("Cached before network")).toBeInTheDocument();
});

it("does not show static earnings when the first backend request fails", async () => {
  const originalFetch = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === "/api/earnings") return new Response(null, { status: 503 });
    return originalFetch(input, init);
  });

  const view = renderApp();
  await waitFor(() => expect(view.container.querySelector(".recent-results")).toHaveTextContent("No recent earnings published."));
  expect(view.container.querySelector(".recent-results")).not.toHaveTextContent("Microsoft");
  expect(view.container.querySelector(".earnings-mini")).toHaveTextContent("No upcoming earnings published.");
});

it("clears earnings when the endpoint fails after a success", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date("2026-08-12T16:00:00Z"));
  let earningsCalls = 0;
  const originalFetch = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === "/api/earnings") {
      earningsCalls += 1;
      if (earningsCalls > 1) return new Response(null, { status: 503 });
    }
    return originalFetch(input, init);
  });

  const view = renderApp();
  await waitFor(() => expect(view.container.querySelector(".earnings-mini")).toHaveTextContent("Future Corp"));
  await vi.advanceTimersByTimeAsync(60 * 60_000);
  await waitFor(() => expect(earningsCalls).toBeGreaterThanOrEqual(2));
  expect(view.container.querySelector(".earnings-mini")).toHaveTextContent("No upcoming earnings published.");
  vi.useRealTimers();
});

it("rejects stale market data even when the status still says fresh", async () => {
  const oldBriefing = { ...briefing, preparedAt: "2026-08-10T12:30:00Z", editionDate: "2026-08-10" };
  vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/briefs/latest") return new Response(JSON.stringify(oldBriefing), { status: 200 });
    if (url === "/api/status") return new Response(JSON.stringify({
      candidates: [],
      briefing: { available: true, freshness: "fresh", publishedAt: oldBriefing.preparedAt },
    }), { status: 200 });
    return new Response(null, { status: 404 });
  });

  const view = renderApp();
  await waitFor(() => expect(view.container.querySelector(".market-status")).toHaveTextContent("Not available"));
  expect(view.container.querySelectorAll(".market-card")).toHaveLength(4);
  expect(view.container.querySelector(".market-grid")).toHaveTextContent("Not available");
  // The last published analysis (2 days old) stays visible with its date.
  expect(view.container.querySelectorAll(".opportunity-row").length).toBeGreaterThan(0);
  expect(view.container.querySelector(".opportunities-card")).toHaveTextContent("Analysis · 10 Aug");
});

it("keeps opportunities visible when the briefing is not marked fresh", async () => {
  vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/briefs/latest") return new Response(JSON.stringify(briefing), { status: 200 });
    if (url === "/api/status") return new Response(JSON.stringify({
      candidates: [],
      briefing: { available: true, freshness: "stale", publishedAt: briefing.preparedAt },
    }), { status: 200 });
    return new Response(null, { status: 404 });
  });

  const view = renderApp();
  await waitFor(() => expect(view.container.querySelector(".opportunity-row")).toHaveTextContent("NVDA"));
  expect(view.container.querySelector(".opportunities-card")).toHaveTextContent("Analysis · 12 Aug");
  // Market data is the only section gated on freshness: no fresh briefing,
  // no market numbers presented as today's.
  expect(view.container.querySelector(".market-grid")).toHaveTextContent("Not available");
  expect(view.container).not.toHaveTextContent("6,412.10");
});

it("shows when market data was updated", async () => {
  const view = renderApp();
  await waitFor(() => expect(view.container.querySelector(".market-status")).toHaveTextContent("S&P 500 up +0.31%"));
  const updated = view.container.querySelector(".market-section .card-subtitle");
  expect(updated).not.toBeNull();
  expect(updated!.textContent).toMatch(/^Updated \d+ Aug · \d{2}:\d{2}$/);
});

it("keeps opportunities during a transient briefing failure while the analysis is still valid", async () => {
  let briefRequests = 0;
  const originalFetch = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === "/api/briefs/latest") {
      briefRequests += 1;
      if (briefRequests > 1) return new Response(null, { status: 503 });
    }
    return originalFetch(input, init);
  });

  const view = renderApp();
  await waitFor(() => expect(view.container.querySelector(".opportunity-row")).toHaveTextContent("NVDA"));
  document.dispatchEvent(new Event("visibilitychange"));
  await waitFor(() => expect(briefRequests).toBeGreaterThan(1));
  // A still-valid daily analysis survives the transient failure.
  expect(view.container.querySelector(".opportunity-row")).toHaveTextContent("NVDA");
  expect(view.container.querySelector(".opportunities-card")).toHaveTextContent("Analysis · 12 Aug");
});

it("does not render source-health badges anywhere", async () => {
  const view = renderApp();
  await waitFor(() => expect(view.container.querySelector(".market-status")).toHaveTextContent("S&P 500 up +0.31%"));
  expect(view.container.querySelectorAll(".data-source")).toHaveLength(0);
  expect(view.container).not.toHaveTextContent("Live");
  expect(view.container).not.toHaveTextContent("Cached");
  expect(view.container).not.toHaveTextContent("Stale");
  expect(view.container).not.toHaveTextContent("Error");
});

it("ignores malformed stored X posts instead of rendering partial objects", async () => {
  localStorage.setItem("morning-briefing-x-post-cache-v1", JSON.stringify([{ createdAt: "2026-08-12T20:30:00Z", handle: "@broken", text: "Missing fields" }]));
  vi.mocked(fetch).mockImplementation(async () => new Response(null, { status: 503 }));

  renderApp("/x");
  expect(await screen.findByText("No recent posts.")).toBeInTheDocument();
  expect(screen.queryByText("Missing fields")).not.toBeInTheDocument();
});

it("clears financial sections after the backend stops publishing", async () => {
  let coreAvailable = true;
  const originalFetch = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!coreAvailable && ["/api/briefs/latest", "/api/status", "/api/market-data"].includes(url)) {
      return new Response(null, { status: 503 });
    }
    return originalFetch(input, init);
  });

  const view = renderApp();
  await waitFor(() => expect(view.container.querySelector(".market-status")).toHaveTextContent("S&P 500 up +0.31%"));
  expect(view.container.querySelector(".opportunity-row")).toHaveTextContent("NVDA");

  coreAvailable = false;
  // Advance beyond the 72h analysis window so the retained daily
  // publication expires and the sections must clear.
  vi.mocked(Date.now).mockReturnValue(Date.parse("2026-08-16T01:00:00Z"));
  document.dispatchEvent(new Event("visibilitychange"));
  await waitFor(() => expect(view.container.querySelectorAll(".market-card")).toHaveLength(4));
  expect(view.container.querySelector(".opportunity-row")).toBeNull();
  expect(view.container.querySelector(".market-status")).toHaveTextContent("Not available");
});

it("refreshes earnings silently after the internal refresh interval", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date("2026-08-12T16:00:00Z"));
  renderApp();
  await waitFor(() => expect(vi.mocked(fetch).mock.calls.filter(([input]) => String(input) === "/api/earnings")).toHaveLength(1));
  await vi.advanceTimersByTimeAsync(60 * 60_000);
  await waitFor(() => expect(vi.mocked(fetch).mock.calls.filter(([input]) => String(input) === "/api/earnings")).toHaveLength(2));
  expect(screen.queryByText("Backend connected")).not.toBeInTheDocument();
  expect(screen.queryByText("Last update")).not.toBeInTheDocument();
});

it("does not force an earnings fetch when the tab becomes visible before the cadence is due", async () => {
  renderApp();
  await waitFor(() => expect(vi.mocked(fetch).mock.calls.filter(([input]) => String(input) === "/api/earnings")).toHaveLength(1));
  document.dispatchEvent(new Event("visibilitychange"));
  await waitFor(() => expect(vi.mocked(fetch).mock.calls.filter(([input]) => String(input) === "/api/earnings")).toHaveLength(1));
});

it("treats an empty earnings response as a successful daily refresh", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const originalFetch = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === "/api/earnings") return new Response(JSON.stringify([]), { status: 200 });
    return originalFetch(input, init);
  });
  renderApp();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(vi.mocked(fetch).mock.calls.filter(([input]) => String(input) === "/api/earnings")).toHaveLength(1);
});

it("reclassifies earnings and refreshes once when the New York market date changes", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date("2026-08-13T03:59:00Z"));
  const originalFetch = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === "/api/earnings") return new Response(JSON.stringify([
      { symbol: "ROLL", company: "Rollover Corp", date: "2026-08-12", timing: "AMC", eventSignal: "Confirmed" },
    ]), { status: 200 });
    return originalFetch(input, init);
  });

  const view = renderApp();
  await waitFor(() => expect(view.container.querySelector(".earnings-mini")).toHaveTextContent("Rollover Corp"));
  vi.setSystemTime(new Date("2026-08-13T04:01:00Z"));
  await vi.advanceTimersByTimeAsync(60_000);
  await waitFor(() => expect(view.container.querySelector(".earnings-mini")).not.toHaveTextContent("Rollover Corp"));
  expect(view.container.querySelector(".recent-results")).toHaveTextContent("No recent earnings published.");
  expect(vi.mocked(fetch).mock.calls.filter(([input]) => String(input) === "/api/earnings")).toHaveLength(2);
  vi.useRealTimers();
});

it("renders zero market movement as flat without an upward arrow", async () => {
  const flatBriefing = { ...briefing, market: briefing.market.map((item) => item.name === "S&P 500" ? { ...item, change: "0.00%" } : item) };
  vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/briefs/latest") return new Response(JSON.stringify(flatBriefing), { status: 200 });
    if (url === "/api/status") return new Response(JSON.stringify({ candidates: [], briefing: { available: true, freshness: "fresh", publishedAt: briefing.preparedAt }, market: { indices: [
      { symbol: "SPX", name: "S&P 500", value: 6412.10, change: 0, updatedAt: "2026-08-12T20:00:00Z" },
      { symbol: "NDX", name: "Nasdaq-100", value: 23830.02, change: 0.55, updatedAt: "2026-08-12T20:00:00Z" },
      { symbol: "DJI", name: "Dow Jones", value: 45118.26, change: 0.48, updatedAt: "2026-08-12T20:00:00Z" },
      { symbol: "VIX", name: "VIX", value: 15.40, change: -2.10, updatedAt: "2026-08-12T20:00:00Z" },
    ] } }), { status: 200 });
    return new Response(null, { status: 404 });
  });

  const view = renderApp();
  await waitFor(() => expect(view.container.querySelector(".market-status")).toHaveTextContent("S&P 500 flat 0.00%"));
  expect(view.container.querySelector(".market-status")).toHaveClass("neutral");
  expect(view.container.querySelector(".market-status strong")).toHaveClass("neutral");
  expect(view.container.querySelector(".market-status svg")).toBeNull();
});

it("fires the market refresh when the tab becomes visible", async () => {
  const originalFetch = vi.mocked(fetch).getMockImplementation()!;
  let statusCalls = 0;
  vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === "/api/status") statusCalls += 1;
    return originalFetch(input, init);
  });

  renderApp();
  await waitFor(() => expect(statusCalls).toBe(1));
  document.dispatchEvent(new Event("visibilitychange"));
  await waitFor(() => expect(statusCalls).toBe(2));
});

it("prefers the live /api/status indices over the briefing snapshot", async () => {
  // The briefing is fresh (normal path during the session) and carries its
  // own market values; the live index context must win on the cards.
  vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/briefs/latest") return new Response(JSON.stringify(briefing), { status: 200 });
    if (url === "/api/status") {
      return new Response(JSON.stringify({
        briefing: { available: true, freshness: "fresh", publishedAt: briefing.preparedAt },
        market: { indices: [
            { symbol: "SPX", name: "S&P 500", value: 7799.82, change: 0.66, updatedAt: "2026-08-12T22:00:00.000Z" },
            { symbol: "NDX", name: "Nasdaq-100", value: 30110.55, change: 1.24, updatedAt: "2026-08-12T22:00:00.000Z" },
            { symbol: "DJI", name: "Dow Jones", value: 53843.24, change: 0.14, updatedAt: "2026-08-12T22:00:00.000Z" },
            { symbol: "VIX", name: "VIX", value: 14.74, change: 1.31, updatedAt: "2026-08-12T22:00:00.000Z" },
          ],
        },
      }), { status: 200 });
    }
    return new Response(null, { status: 404 });
  });
  const view = renderApp();
  await waitFor(() => expect(view.container.querySelectorAll(".market-card")).toHaveLength(4));
  const first = view.container.querySelector(".market-card");
  expect(first).toHaveTextContent("+0.66%");
  expect(first).not.toHaveTextContent("Not available");
  expect(view.container.querySelector(".market-section")).toHaveTextContent(/Updated 12 Aug/);
});

it("fills the market cards with live index quotes when no fresh briefing exists", async () => {
  // The suite pins Date.now() to 2026-08-12T22:30:00Z; stay inside the
  // 26h freshness window relative to that clock.
  const freshIso = "2026-08-12T22:00:00.000Z";
  vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/briefs/latest") return new Response(null, { status: 404 });
    if (url === "/api/status") return new Response(JSON.stringify({
      briefing: { available: false, freshness: "unavailable", publishedAt: null },
      market: {
        indices: [
          { symbol: "SPX", name: "S&P 500", value: 6427.18, change: 0.62, updatedAt: freshIso },
          { symbol: "NDX", name: "Nasdaq-100", value: 23724.31, change: 0.78, updatedAt: freshIso },
          { symbol: "DJI", name: "Dow Jones", value: 45118.26, change: 0.48, updatedAt: freshIso },
          { symbol: "VIX", name: "VIX", value: 15.41, change: -1.26, updatedAt: freshIso },
        ],
      },
    }), { status: 200 });
    return new Response(null, { status: 404 });
  });

  const view = renderApp();
  await waitFor(() => expect(view.container.querySelectorAll(".market-card")).toHaveLength(4));
  expect(view.container.querySelectorAll(".market-card")[0]).toHaveTextContent("S&P 500");
  // Live index quotes drive the cards: symbols and changes come from the
  // status read model. (AnimatedValue eases the numeric figure and is driven
  // by requestAnimationFrame, which jsdom mis-times under the pinned clock,
  // so the exact figure is asserted elsewhere, not here.)
  expect(view.container.querySelectorAll(".market-card")[0]).toHaveTextContent("SPX");
  expect(view.container).toHaveTextContent("+0.62%");
  expect(view.container).toHaveTextContent("-1.26%");
  expect(view.container.querySelector(".market-section")).toHaveTextContent(/Updated 12 Aug/);
  expect(view.container.querySelector(".market-section")).not.toHaveTextContent("Not available");
});

it("renders stale index quotes with an explicit stale label", async () => {
  vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/briefs/latest") return new Response(null, { status: 404 });
    if (url === "/api/status") return new Response(JSON.stringify({
      briefing: { available: false, freshness: "unavailable", publishedAt: null },
      market: {
        indices: [
          { symbol: "SPX", name: "S&P 500", value: 6427.18, change: 0.62, updatedAt: "2026-08-12T20:00:00Z" },
          { symbol: "NDX", name: "Nasdaq-100", value: 23724.31, change: 0.78, updatedAt: "2026-08-12T20:00:00Z" },
          { symbol: "DJI", name: "Dow Jones", value: 45118.26, change: 0.48, updatedAt: "2026-08-12T20:00:00Z" },
          { symbol: "VIX", name: "VIX", value: 15.41, change: -1.26, updatedAt: "2026-08-12T20:00:00Z" },
        ],
      },
      sources: { market: { state: "Cached", error: "SPX: provider HTTP 429" } },
    }), { status: 200 });
    return new Response(null, { status: 404 });
  });

  const view = renderApp();
  await waitFor(() => expect(view.container.querySelectorAll(".market-card")).toHaveLength(4));
  expect(view.container.querySelectorAll(".market-card")[0]).toHaveTextContent("SPX");
  expect(view.container.querySelector(".market-section .card-subtitle")).toHaveTextContent("Stale");
  expect(view.container).toHaveTextContent("+0.62%");
});

it("clears retained market cards after the 26-hour grace window", async () => {
  vi.mocked(Date.now).mockReturnValue(Date.parse("2026-08-14T22:30:00Z"));
  vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/briefs/latest") return new Response(null, { status: 404 });
    if (url === "/api/status") return new Response(JSON.stringify({
      market: {
        latestCollectedAt: "2026-08-13T16:00:00.000Z",
        indices: [
          { symbol: "SPX", name: "S&P 500", value: 7777.69, change: 0.38, updatedAt: "2026-08-13T00:00:00-04:00" },
          { symbol: "NDX", name: "Nasdaq-100", value: 30004.93, change: 0.88, updatedAt: "2026-08-13T00:00:00-04:00" },
          { symbol: "DJI", name: "Dow Jones", value: 53659.20, change: -0.21, updatedAt: "2026-08-13T00:00:00-04:00" },
          { symbol: "VIX", name: "VIX", value: 14.71, change: 1.10, updatedAt: "2026-08-13T00:00:00-05:00" },
        ],
      },
      sources: { market: { state: "Cached", error: "SPX: provider HTTP 429" } },
    }), { status: 200 });
    return new Response(null, { status: 404 });
  });

  const view = renderApp();
  await waitFor(() => expect(view.container.querySelectorAll(".market-card")).toHaveLength(4));
  expect(view.container.querySelector(".market-grid")).toHaveTextContent("Not available");
  expect(view.container.querySelector(".market-grid")).not.toHaveTextContent("7,777.69");
});

it("renders the fear & greed number and gauge from the status sentiment", async () => {
  const freshIso = "2026-08-12T22:00:00.000Z";
  vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/briefs/latest") return new Response(null, { status: 404 });
    if (url === "/api/status") return new Response(JSON.stringify({
      briefing: { available: false, freshness: "unavailable", publishedAt: null },
      sentiment: { provider: "cnn-fear-greed", score: 62, rating: "greed", asOf: freshIso },
    }), { status: 200 });
    return new Response(null, { status: 404 });
  });

  const view = renderApp();
  await waitFor(() => expect(view.container.querySelector(".sentiment-card")).toHaveTextContent("Greed"));
  expect(view.container.querySelector(".sentiment-card .gauge-mask strong")).toHaveTextContent("62");
  expect(view.container.querySelector(".sentiment-card .gauge-value")).not.toBeNull();
  // The gauge arc must reflect the score (62/100 of the semicircle), not the
  // full circle: π·65 ≈ 204.2 is the arc length, 62% ≈ 126.6.
  expect(view.container.querySelector(".sentiment-card .gauge-value")).toHaveAttribute(
    "stroke-dasharray",
    expect.stringMatching(/^126\.\d+/),
  );
  expect(view.container.querySelector(".sentiment-card")).toHaveTextContent("Risk-on");
  expect(view.container.querySelector(".sentiment-card")).not.toHaveTextContent("Not available");
});

it("keeps the sentiment card unavailable when the reading is stale", async () => {
  vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/briefs/latest") return new Response(null, { status: 404 });
    if (url === "/api/status") return new Response(JSON.stringify({
      briefing: { available: false, freshness: "unavailable", publishedAt: null },
      sentiment: { provider: "cnn-fear-greed", score: 62, rating: "greed", asOf: "2026-08-01T12:00:00Z" },
    }), { status: 200 });
    return new Response(null, { status: 404 });
  });

  const view = renderApp();
  await waitFor(() => expect(view.container.querySelector(".sentiment-card")).toHaveTextContent("Not available"));
  expect(view.container.querySelector(".sentiment-card")).not.toHaveTextContent("Risk-on");
  expect(view.container.querySelector(".sentiment-card .gauge-value")).toBeNull();
});
