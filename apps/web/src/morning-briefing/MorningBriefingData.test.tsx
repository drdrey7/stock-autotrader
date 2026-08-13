import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import MorningBriefingApp from "./MorningBriefingApp";

const renderApp = (path = "/") => render(<MemoryRouter initialEntries={[path]}><MorningBriefingApp/></MemoryRouter>);

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
    if (url === "/api/status") return new Response(JSON.stringify({ candidates: [{ symbol: "NVDA", quantScore: 91 }], briefing: { available: true, freshness: "fresh", publishedAt: briefing.preparedAt } }), { status: 200 });
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

it("renders only qualified ideas and classifies scheduled earnings by date", async () => {
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

it("starts financially actionable sections empty when the backend has no data", async () => {
  vi.mocked(fetch).mockImplementation(async () => new Response(null, { status: 503 }));
  const view = renderApp();

  expect(await screen.findByText("Market data")).toBeInTheDocument();
  expect(view.container.querySelectorAll(".market-card")).toHaveLength(4);
  expect(view.container.querySelector(".market-grid")).toHaveTextContent("S&P 500");
  expect(view.container.querySelector(".market-grid")).toHaveTextContent("Nasdaq");
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

  expect(screen.getByRole("heading", { name: "Market Sentiment" })).toBeInTheDocument();
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
    if (url === "/api/status") return new Response(JSON.stringify({ candidates: [], briefing: { available: true, freshness: "fresh", publishedAt: briefing.preparedAt } }), { status: 200 });
    return new Response(null, { status: 404 });
  });

  const view = renderApp();
  await waitFor(() => expect(view.container.querySelector(".market-status")).toHaveTextContent("S&P 500 down -0.31%"));
  expect(screen.getByText("-1.25%")).toHaveClass("negative");
  expect(screen.queryByText("+-1.25%")).not.toBeInTheDocument();
});

it("keeps every benchmark card visible while unsupported values stay unavailable", async () => {
  const view = renderApp();
  await waitFor(() => expect(view.container.querySelectorAll(".market-card")).toHaveLength(4));
  expect(view.container.querySelector(".market-card")).toHaveTextContent("S&P 500");
  expect(view.container).toHaveTextContent("Dow Jones");
  expect(view.container.querySelectorAll(".market-card")[2]).toHaveTextContent("Not available");
  expect(view.container).not.toHaveTextContent("45,118.26");
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
  expect(view.container.querySelectorAll(".market-card")[1]).toHaveTextContent("Not available");
  expect(view.container).toHaveTextContent("Dow Jones");
  expect(view.container).toHaveTextContent("VIX");
  expect(view.container.querySelectorAll(".market-card")[2]).toHaveTextContent("Not available");
  expect(view.container.querySelectorAll(".market-card")[3]).toHaveTextContent("Not available");
  expect(view.container).not.toHaveTextContent("642.00");
  expect(view.container).not.toHaveTextContent("573.00");
});

it("shows source health state and provider for a live briefing", async () => {
  vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/briefs/latest") return new Response(JSON.stringify(briefing), { status: 200 });
    if (url === "/api/status") return new Response(JSON.stringify({
      candidates: [],
      briefing: { available: true, freshness: "fresh", publishedAt: briefing.preparedAt },
      sources: {
        briefing: { provider: "stock-autotrader publisher", state: "Live", asOf: briefing.preparedAt, ageSeconds: 120, staleAfterSeconds: 93600, lastSuccess: briefing.preparedAt, lastAttempt: briefing.preparedAt, error: null },
        market: { provider: "stock-autotrader publisher", state: "Live", asOf: briefing.preparedAt, ageSeconds: 120, staleAfterSeconds: 93600, lastSuccess: briefing.preparedAt, lastAttempt: briefing.preparedAt, error: null },
        opportunities: { provider: "stock-autotrader publisher", state: "Live", asOf: briefing.preparedAt, ageSeconds: 120, staleAfterSeconds: 93600, lastSuccess: briefing.preparedAt, lastAttempt: briefing.preparedAt, error: null },
        x: { provider: "unavailable", state: "Unavailable", asOf: null, ageSeconds: null, staleAfterSeconds: 86400, lastSuccess: null, lastAttempt: null, error: "No validated source health has been published." },
        earnings: { provider: "unavailable", state: "Unavailable", asOf: null, ageSeconds: null, staleAfterSeconds: 86400, lastSuccess: null, lastAttempt: null, error: "No validated source health has been published." },
        sentiment: { provider: "unavailable", state: "Unavailable", asOf: null, ageSeconds: null, staleAfterSeconds: 86400, lastSuccess: null, lastAttempt: null, error: "No validated source health has been published." },
        quickStats: { provider: "unavailable", state: "Unavailable", asOf: null, ageSeconds: null, staleAfterSeconds: 86400, lastSuccess: null, lastAttempt: null, error: "No validated source health has been published." },
      },
    }), { status: 200 });
    return new Response(null, { status: 404 });
  });

  const view = renderApp();
  await waitFor(() => expect(view.container.querySelector(".market-status")).toHaveTextContent("S&P 500 up +0.31%"));
  expect(view.container.querySelector(".data-source.live")).not.toBeNull();
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
  expect(view.container).not.toHaveTextContent("23,750.00");
  expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input) === "/api/market-data")).toBe(false);
});

it("does not render legacy market-data snapshot values without a fresh briefing", async () => {
  const snapshot = {
    provider: "market-api", status: "healthy", asOf: "2026-08-12",
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
    if (url === "/api/status") return new Response(JSON.stringify({ candidates: [] }), { status: 200 });
    if (url === "/api/market-data") return new Response(JSON.stringify(snapshot), { status: 200 });
    return new Response(null, { status: 404 });
  });

  const view = renderApp();
  await waitFor(() => expect(view.container.querySelectorAll(".market-card")[0]).toHaveTextContent("Not available"));
  expect(view.container.querySelectorAll(".market-card")[1]).toHaveTextContent("Not available");
  expect(view.container.querySelectorAll(".market-card")[2]).toHaveTextContent("Not available");
  expect(view.container.querySelectorAll(".market-card")[3]).toHaveTextContent("Not available");
  expect(view.container).not.toHaveTextContent("6,420.00");
  expect(view.container).not.toHaveTextContent("23,750.00");
  expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input) === "/api/market-data")).toBe(false);
});

it("clears opportunities when the healthy candidate snapshot is explicitly empty", async () => {
  vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/status") return new Response(JSON.stringify({
      status: { engine: "online", apiHealth: "healthy", lastDataUpdate: "2026-08-12T20:00:00Z" },
      candidates: [],
      briefing: { available: false, freshness: "unavailable", publishedAt: null },
    }), { status: 200 });
    return new Response(null, { status: 404 });
  });

  const view = renderApp();
  await waitFor(() => expect(view.container.querySelector(".opportunities-card .empty-state")).toHaveTextContent("No qualified opportunities were published for this edition."));
  expect(view.container.querySelector(".opportunity-row")).toBeNull();
  expect(view.container.querySelector(".opportunities-card")).not.toHaveTextContent("NVDA");
  expect(view.container.querySelector(".x-preview")).toHaveTextContent("No recent posts.");
});

it("labels a post-close edition instead of showing a morning greeting", async () => {
  const postCloseBriefing = { ...briefing, editionType: "post_close", title: "Closing briefing" };
  vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/briefs/latest") return new Response(JSON.stringify(postCloseBriefing), { status: 200 });
    if (url === "/api/status") return new Response(JSON.stringify({ candidates: [], briefing: { available: true, freshness: "fresh", publishedAt: briefing.preparedAt } }), { status: 200 });
    return new Response(null, { status: 404 });
  });

  renderApp();
  expect(await screen.findByRole("heading", { name: "Market close." })).toBeInTheDocument();
  expect(screen.getByText("WEDNESDAY · 12 AUGUST · POST-CLOSE")).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "Good morning." })).not.toBeInTheDocument();
});

it("renders successful sources without waiting for a stalled X request", async () => {
  vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/briefs/latest") return new Response(JSON.stringify(briefing), { status: 200 });
    if (url === "/api/status") return new Response(JSON.stringify({ candidates: [], briefing: { available: true, freshness: "fresh", publishedAt: briefing.preparedAt } }), { status: 200 });
    if (url.startsWith("/api/x/posts")) return await new Promise<Response>(() => undefined);
    if (url === "/api/earnings") return new Response(JSON.stringify([{ symbol: "NEW", company: "Future Corp", date: "2026-08-14", timing: "BMO", eventSignal: "Confirmed" }]), { status: 200 });
    if (url === "/api/market-data") return new Response(JSON.stringify({ benchmarks: [] }), { status: 200 });
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

it("labels retained posts cached after a feed failure while the backend source stays live", async () => {
  const liveXSource = {
    provider: "x-search collector", state: "Live", asOf: "2026-08-12T20:30:00Z",
    ageSeconds: 7200, staleAfterSeconds: 604800,
    lastSuccess: "2026-08-12T20:30:00Z", lastAttempt: "2026-08-12T20:30:00Z", error: null,
  };
  let xRequests = 0;
  const originalFetch = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/status") {
      return new Response(JSON.stringify({
        candidates: [],
        briefing: { available: true, freshness: "fresh", publishedAt: briefing.preparedAt },
        sources: { x: liveXSource },
      }), { status: 200 });
    }
    if (url.startsWith("/api/x/posts")) {
      xRequests += 1;
      if (xRequests === 1) return new Response(JSON.stringify({ posts: [
        { id: "p1", author: "@nolimitgains", text: "First post", created_at: "2026-08-12T20:30:00Z", url: "https://x.com/nolimitgains/status/p1", symbol: null, company: null, price: null, change: null },
      ], count: 1 }), { status: 200 });
      return new Response(null, { status: 503 });
    }
    return originalFetch(input, init);
  });

  const view = renderApp();
  await screen.findByText("First post");
  expect(view.container.querySelector(".x-preview .section-title .data-source.live")).not.toBeNull();
  document.dispatchEvent(new Event("visibilitychange"));
  await waitFor(() => expect(xRequests).toBe(2));
  await waitFor(() => expect(view.container.querySelector(".post-status .data-source.cached")).not.toBeNull());
  expect(view.container.querySelector(".x-preview .section-title .data-source.live")).not.toBeNull();
});

it("fails closed to Unavailable when the backend publishes malformed source health", async () => {
  const malformedLive = {
    provider: "broken", state: "Live", asOf: null, ageSeconds: null,
    staleAfterSeconds: 3600, lastSuccess: null, lastAttempt: null, error: null,
  };
  vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/briefs/latest") return new Response(JSON.stringify(briefing), { status: 200 });
    if (url === "/api/status") return new Response(JSON.stringify({
      candidates: [],
      briefing: { available: true, freshness: "fresh", publishedAt: briefing.preparedAt },
      sources: { briefing: malformedLive, opportunities: malformedLive },
    }), { status: 200 });
    return new Response(null, { status: 404 });
  });

  const view = renderApp();
  await waitFor(() => expect(view.container.querySelector(".market-status")).toHaveTextContent("S&P 500 up +0.31%"));
  expect(view.container.querySelector(".section-title .data-source.live")).toBeNull();
  expect(view.container.querySelector(".opportunities-card .data-source.unavailable")).not.toBeNull();
});

it("never labels a missing market card Live when the backend market source is live", async () => {
  const liveMarketSource = {
    provider: "test-market", state: "Live", asOf: "2026-08-12T12:30:00Z",
    ageSeconds: 3600, staleAfterSeconds: 93600,
    lastSuccess: "2026-08-12T12:30:00Z", lastAttempt: "2026-08-12T12:30:00Z", error: null,
  };
  vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/briefs/latest") return new Response(JSON.stringify(briefing), { status: 200 });
    if (url === "/api/status") return new Response(JSON.stringify({
      candidates: [],
      briefing: { available: true, freshness: "fresh", publishedAt: briefing.preparedAt },
      sources: { market: liveMarketSource },
    }), { status: 200 });
    return new Response(null, { status: 404 });
  });

  const view = renderApp();
  await waitFor(() => expect(view.container.querySelector(".market-status")).toHaveTextContent("S&P 500 up +0.31%"));
  // The briefing publishes three indexes; those cards are live. The missing
  // Dow Jones card must not inherit a Live badge from the backend source.
  expect(view.container.querySelectorAll(".market-card .data-source.live")).toHaveLength(3);
  const dowCard = [...view.container.querySelectorAll(".market-card")].find((card) => card.textContent?.includes("Dow Jones"));
  expect(dowCard).toBeDefined();
  expect(dowCard!.textContent).toContain("Not available");
  expect(dowCard!.querySelector(".data-source")).toHaveClass("unavailable");
});

it("shows populated market cards with backend cached health, not Live", async () => {
  const cachedMarketSource = {
    provider: "market-cache", state: "Cached", asOf: "2026-08-12T12:30:00Z",
    ageSeconds: 7200, staleAfterSeconds: 3600,
    lastSuccess: "2026-08-12T12:30:00Z", lastAttempt: "2026-08-12T20:30:00Z", error: "Market snapshot is degraded.",
  };
  vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/briefs/latest") return new Response(JSON.stringify(briefing), { status: 200 });
    if (url === "/api/status") return new Response(JSON.stringify({
      candidates: [],
      briefing: { available: true, freshness: "fresh", publishedAt: briefing.preparedAt },
      sources: { market: cachedMarketSource },
    }), { status: 200 });
    return new Response(null, { status: 404 });
  });

  const view = renderApp();
  await waitFor(() => expect(view.container.querySelector(".market-status")).toHaveTextContent("S&P 500 up +0.31%"));
  expect(view.container.querySelectorAll(".market-card .data-source.cached")).toHaveLength(3);
  expect(view.container.querySelectorAll(".market-card .data-source.live")).toHaveLength(0);
  await waitFor(() => expect(view.container.querySelector(".market-card strong")).not.toHaveTextContent("Not available"));
});

it("drops previous Live health when a later status response omits sources", async () => {
  let statusAvailable = true;
  let statusRequests = 0;
  const liveMarketSource = {
    provider: "briefing publisher", state: "Live", asOf: briefing.preparedAt,
    ageSeconds: 120, staleAfterSeconds: 93600,
    lastSuccess: briefing.preparedAt, lastAttempt: briefing.preparedAt, error: null,
  };
  vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/briefs/latest") return new Response(JSON.stringify(briefing), { status: 200 });
    if (url === "/api/status") {
      statusRequests += 1;
      return new Response(JSON.stringify(statusAvailable ? {
        candidates: [],
        briefing: { available: true, freshness: "fresh", publishedAt: briefing.preparedAt },
        sources: { market: liveMarketSource },
      } : {
        candidates: [],
        briefing: { available: false, freshness: "unavailable", publishedAt: null },
      }), { status: 200 });
    }
    return new Response(null, { status: 404 });
  });

  const view = renderApp();
  await waitFor(() => expect(view.container.querySelectorAll(".market-card .data-source.live")).toHaveLength(3));
  statusAvailable = false;
  document.dispatchEvent(new Event("visibilitychange"));
  await waitFor(() => expect(statusRequests).toBeGreaterThanOrEqual(5));
  await waitFor(() => expect(view.container.querySelector(".market-status")).toHaveTextContent("Not available"));
  expect(view.container.querySelectorAll(".market-card .data-source.live")).toHaveLength(0);
});

it("does not let an older refreshX overwrite newer posts after its status fetch", async () => {
  let postsCalls = 0;
  let statusCalls = 0;
  let releaseFirstPosts: ((response: Response) => void) | null = null;
  let releaseOldStatus: ((response: Response) => void) | null = null;
  const liveXSource = {
    provider: "x-search collector", state: "Live", asOf: "2026-08-12T21:00:00Z",
    ageSeconds: 5400, staleAfterSeconds: 604800,
    lastSuccess: "2026-08-12T21:00:00Z", lastAttempt: "2026-08-12T21:00:00Z", error: null,
  };
  const staleXSource = {
    provider: "x-search collector", state: "Stale", asOf: "2026-08-10T09:00:00Z",
    ageSeconds: 172800, staleAfterSeconds: 604800,
    lastSuccess: "2026-08-10T09:00:00Z", lastAttempt: "2026-08-10T09:00:00Z", error: null,
  };
  const statusPayload = (sources: Record<string, unknown>) => ({
    candidates: [],
    briefing: { available: true, freshness: "fresh", publishedAt: briefing.preparedAt },
    sources,
  });
  const post = (id: string, text: string, created_at: string) => ({
    id, author: "@nolimitgains", text, created_at, url: `https://x.com/nolimitgains/status/${id}`,
    symbol: null, company: null, price: null, change: null,
  });
  vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/briefs/latest") return new Response(JSON.stringify(briefing), { status: 200 });
    if (url === "/api/earnings") return new Response(JSON.stringify([]), { status: 200 });
    if (url.startsWith("/api/x/posts")) {
      postsCalls += 1;
      if (postsCalls === 1) {
        return new Promise<Response>((resolve) => { releaseFirstPosts = resolve; });
      }
      return new Response(JSON.stringify({ posts: [post("newer", "Post B", "2026-08-12T20:30:00Z")], count: 1 }), { status: 200 });
    }
    if (url === "/api/status") {
      statusCalls += 1;
      // The status fetch that follows the FIRST posts call belongs to the old
      // refreshX invocation; hold it until the newer one has completed.
      if (statusCalls === 3) {
        return new Promise<Response>((resolve) => { releaseOldStatus = resolve; });
      }
      return new Response(JSON.stringify(statusPayload({ x: liveXSource })), { status: 200 });
    }
    return new Response(null, { status: 404 });
  });

  const view = renderApp();
  await waitFor(() => expect(postsCalls).toBe(1));
  releaseFirstPosts!(new Response(JSON.stringify({ posts: [post("older", "Post A", "2026-08-12T21:00:00Z")], count: 1 }), { status: 200 }));
  await waitFor(() => expect(statusCalls).toBe(3));
  document.dispatchEvent(new Event("visibilitychange"));
  await waitFor(() => expect(view.container.querySelector(".x-preview .section-title .data-source.live")).not.toBeNull());
  releaseOldStatus!(new Response(JSON.stringify(statusPayload({ x: staleXSource })), { status: 200 }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(screen.getByText("Post B")).toBeInTheDocument();
  expect(screen.queryByText("Post A")).not.toBeInTheDocument();
  expect(view.container.querySelector(".x-preview .section-title .data-source.live")).not.toBeNull();
});

it("keeps an endpoint fail-closed when a parallel refresh reports it healthy", async () => {
  let statusCalls = 0;
  let releaseXStatus: ((response: Response) => void) | null = null;
  const liveEarningsSource = {
    provider: "earnings calendar", state: "Live", asOf: briefing.preparedAt,
    ageSeconds: 120, staleAfterSeconds: 93600,
    lastSuccess: briefing.preparedAt, lastAttempt: briefing.preparedAt, error: null,
  };
  const statusPayload = {
    candidates: [],
    briefing: { available: true, freshness: "fresh", publishedAt: briefing.preparedAt },
    sources: { earnings: liveEarningsSource },
  };
  vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/briefs/latest") return new Response(JSON.stringify(briefing), { status: 200 });
    if (url === "/api/earnings") return new Response(null, { status: 503 });
    if (url.startsWith("/api/x/posts")) return new Response(JSON.stringify({ posts: [], count: 0 }), { status: 200 });
    if (url === "/api/status") {
      statusCalls += 1;
      // Hold the refreshX status fetch: it completes last and would resurrect
      // the earnings Live badge without the centralized fail-closed override.
      if (statusCalls === 3) {
        return new Promise<Response>((resolve) => { releaseXStatus = resolve; });
      }
      return new Response(JSON.stringify(statusPayload), { status: 200 });
    }
    return new Response(null, { status: 404 });
  });

  const view = renderApp();
  await waitFor(() => expect(statusCalls).toBe(3));
  await waitFor(() => expect(view.container.querySelector(".earnings-summary .data-source.unavailable")).not.toBeNull());
  releaseXStatus!(new Response(JSON.stringify(statusPayload), { status: 200 }));
  // The released refreshX continuation applies its setData in a microtask;
  // give it a tick, then assert the fail-closed badge survived.
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(view.container.querySelector(".earnings-summary .data-source.live")).toBeNull();
  expect(view.container.querySelector(".earnings-summary .data-source.unavailable")).not.toBeNull();
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

it("does not show API posts older than seven days", async () => {
  const originalFetch = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).startsWith("/api/x/posts")) return new Response(JSON.stringify({ posts: [
      { id: "expired", author: "@nolimitgains", text: "Expired post", created_at: "2026-08-05T22:29:00Z", url: "https://x.com/nolimitgains/status/expired", symbol: null, company: null, price: null, change: null },
    ], count: 1 }), { status: 200 });
    return originalFetch(input, init);
  });

  const view = renderApp("/x");
  await waitFor(() => expect(view.container.querySelector(".empty-state")).toHaveTextContent("No recent posts."));
  expect(screen.queryByText("Expired post")).not.toBeInTheDocument();
  expect(view.container.querySelector(".post-card")).toBeNull();
});

it("keeps a tracked account's old posts for seven days, then shows no recent posts", async () => {
  let xRequests = 0;
  const originalFetch = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).startsWith("/api/x/posts")) {
      xRequests += 1;
      if (xRequests === 1) return new Response(JSON.stringify({ posts: [
        { id: "cached", author: "@nolimitgains", text: "Cached account post", created_at: "2026-08-06T22:30:00Z", url: "https://x.com/nolimitgains/status/cached", symbol: null, company: null, price: null, change: null },
      ], count: 1 }), { status: 200 });
      return new Response(JSON.stringify({ posts: [], count: 0 }), { status: 200 });
    }
    return originalFetch(input, init);
  });

  const view = renderApp("/x");
  await screen.findByText("Cached account post");
  vi.mocked(Date.now).mockReturnValue(Date.parse("2026-08-12T22:30:00Z"));
  document.dispatchEvent(new Event("visibilitychange"));
  await waitFor(() => expect(xRequests).toBe(2));
  expect(screen.getByText("Cached account post")).toBeInTheDocument();

  vi.mocked(Date.now).mockReturnValue(Date.parse("2026-08-14T22:30:00Z"));
  document.dispatchEvent(new Event("visibilitychange"));
  await waitFor(() => expect(xRequests).toBe(3));
  await waitFor(() => expect(view.container.querySelector(".empty-state")).toHaveTextContent("No recent posts."));
  expect(screen.queryByText("Cached account post")).not.toBeInTheDocument();
});

it("does not append static earnings results to a successful API schedule", async () => {
  const originalFetch = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === "/api/earnings") return new Response(JSON.stringify([
      { symbol: "API", company: "API Corp", date: "2026-08-03", timing: "AMC", eventSignal: "Confirmed" },
      { symbol: "NEXT", company: "Next Corp", date: "2026-08-14", timing: "BMO", eventSignal: "Confirmed" },
    ]), { status: 200 });
    return originalFetch(input, init);
  });

  const view = renderApp();
  await waitFor(() => expect(view.container.querySelector(".recent-results")).toHaveTextContent("API Corp"));
  expect(view.container.querySelector(".recent-results")).not.toHaveTextContent("Microsoft");
  expect(view.container.querySelector(".recent-results")).not.toHaveTextContent("Amazon");
  expect(view.container.querySelector(".earnings-mini")).toHaveTextContent("Next Corp");
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
  expect(view.container.querySelector(".recent-results")).not.toHaveTextContent("Amazon");
  expect(view.container.querySelector(".earnings-mini")).toHaveTextContent("No upcoming earnings published.");
});

it("rejects an old briefing even when its status still says fresh", async () => {
  const oldBriefing = { ...briefing, preparedAt: "2026-08-10T12:30:00Z" };
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
  expect(view.container.querySelector(".opportunity-row")).toBeNull();
  expect(screen.getByText("WEDNESDAY · 12 AUGUST")).toBeInTheDocument();
});

it("ignores malformed stored X posts instead of rendering partial objects", async () => {
  localStorage.setItem("morning-briefing-x-post-cache-v1", JSON.stringify([{ createdAt: "2026-08-12T20:30:00Z", handle: "@broken", text: "Missing fields" }]));
  vi.mocked(fetch).mockImplementation(async () => new Response(null, { status: 503 }));

  renderApp("/x");
  expect(await screen.findByText("No recent posts.")).toBeInTheDocument();
  expect(screen.queryByText("Missing fields")).not.toBeInTheDocument();
});

it("clears expired financial data after the backend stops publishing", async () => {
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
  vi.mocked(Date.now).mockReturnValue(Date.parse("2026-08-14T01:00:00Z"));
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
  expect(view.container.querySelector(".recent-results")).toHaveTextContent("Rollover Corp");
  expect(vi.mocked(fetch).mock.calls.filter(([input]) => String(input) === "/api/earnings")).toHaveLength(2);
  vi.useRealTimers();
});

it("renders zero market movement as flat without an upward arrow", async () => {
  const flatBriefing = { ...briefing, market: briefing.market.map((item) => item.name === "S&P 500" ? { ...item, change: "0.00%" } : item) };
  vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/briefs/latest") return new Response(JSON.stringify(flatBriefing), { status: 200 });
    if (url === "/api/status") return new Response(JSON.stringify({ candidates: [], briefing: { available: true, freshness: "fresh", publishedAt: briefing.preparedAt } }), { status: 200 });
    return new Response(null, { status: 404 });
  });
  const view = renderApp();
  await waitFor(() => expect(view.container.querySelector(".market-status")).toHaveTextContent("S&P 500 flat 0.00%"));
  expect(view.container.querySelector(".market-status")).toHaveClass("neutral");
  expect(view.container.querySelector(".market-status strong")).toHaveClass("neutral");
  expect(view.container.querySelector(".market-status svg")).toBeNull();
});

it("rejects a degraded market snapshot instead of labelling stale prices live", async () => {
  const degradedSnapshot = {
    provider: "cache", status: "degraded", asOf: "2026-08-10",
    lastSuccessfulUpdate: "2026-08-10T16:00:00Z",
    universe: { total: 1, eligible: 1, excluded: 0 },
    benchmarks: [{ symbol: "SPY", date: "2026-08-10", open: 9000, high: 10000, low: 8900, close: 9999, adjustedClose: 9999, volume: 1 }],
    warnings: ["stale"], updatedAt: "2026-08-10T16:00:00Z",
  };
  vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/status") return new Response(JSON.stringify({ candidates: [], marketData: degradedSnapshot }), { status: 200 });
    if (url === "/api/market-data") return new Response(JSON.stringify(degradedSnapshot), { status: 200 });
    return new Response(null, { status: 404 });
  });

  renderApp();
  await waitFor(() => expect(screen.getByText("Good morning.")).toBeInTheDocument());
  expect(screen.queryByText("9,999.00")).not.toBeInTheDocument();
});

it("rejects stale briefing data and invalid live market numbers", async () => {
  const staleBriefing = { ...briefing, market: briefing.market.map((item, index) => index === 0 ? { ...item, value: "N/A" } : item) };
  vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/briefs/latest") return new Response(JSON.stringify(staleBriefing), { status: 200 });
    if (url === "/api/status") return new Response(JSON.stringify({ candidates: [], briefing: { available: true, freshness: "stale", publishedAt: briefing.preparedAt } }), { status: 200 });
    return new Response(null, { status: 404 });
  });

  renderApp();
  await waitFor(() => expect(screen.getByText("Good morning.")).toBeInTheDocument());
  expect(screen.queryByText("Constructive session.")).not.toBeInTheDocument();
  expect(screen.queryByText("N/A")).not.toBeInTheDocument();
});

it("does not surface legacy status candidates as qualified opportunities", async () => {
  const candidate = (symbol: string, quantScore: number) => ({
    symbol, company: `${symbol} Corp`, sector: "Tech", marketCap: 1, price: 10,
    quantScore, strategyId: "trend", strategyVersion: "1", strategy: "Trend",
    trend: "Strong", momentum: 1, relativeStrength: 1, relativeVolume: 1,
    breakout: "$11", earningsDate: null, earningsProximityDays: null,
    status: "Strong Setup", direction: "Bullish", riskFlags: [],
    updatedAt: "2026-08-12T20:00:00Z", reasons: [],
  });
  vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/status") return new Response(JSON.stringify({
      status: { engine: "online", apiHealth: "healthy", lastDataUpdate: "2026-08-12T20:00:00Z" },
      candidates: [candidate("LOW", 70), candidate("HIGH", 95)],
      briefing: { available: false, freshness: "unavailable", publishedAt: null },
    }), { status: 200 });
    return new Response(null, { status: 404 });
  });

  const view = renderApp();
  await waitFor(() => expect(view.container.querySelector(".opportunities-card .empty-state")).toHaveTextContent("No qualified opportunities were published for this edition."));
  expect(view.container.querySelector(".opportunity-row")).toBeNull();
  expect(view.container).not.toHaveTextContent("HIGH");
  expect(view.container).not.toHaveTextContent("LOW");
});

it("refreshes backend data when the page becomes visible", async () => {
  renderApp();
  await waitFor(() => expect(screen.getByText("Good morning.")).toBeInTheDocument());
  const before = vi.mocked(fetch).mock.calls.length;
  document.dispatchEvent(new Event("visibilitychange"));
  await waitFor(() => expect(vi.mocked(fetch).mock.calls.length).toBeGreaterThan(before));
});

it("sorts X Pulse newest first and shows days plus remaining hours", async () => {
  const view = renderApp("/x");
  await screen.findByRole("heading", { level: 1, name: /X Pulse/ });
  await waitFor(() => expect(screen.getByText("Newest post")).toBeInTheDocument());

  const posts = [...view.container.querySelectorAll(".feed .post-card p")]
    .map((element) => element.textContent);
  expect(posts).toEqual(["Newest post", "Older post"]);
  expect(screen.getByText("2h")).toBeInTheDocument();
  expect(screen.getByText("1d 3h")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "@nolimitgains" }));
  expect([...view.container.querySelectorAll(".feed .post-card p")].map((element) => element.textContent))
    .toEqual(["Newest post", "Older post"]);
});
