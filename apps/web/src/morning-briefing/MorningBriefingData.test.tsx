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
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("renders only qualified ideas and classifies scheduled earnings by date", async () => {
  const view = renderApp();
  await waitFor(() => expect(screen.getByText("Backend connected")).toBeInTheDocument());
  expect(screen.getAllByText("Live").length).toBeGreaterThan(0);
  expect(screen.getAllByText("Demo").length).toBeGreaterThan(0);
  expect(screen.getByText("+1.75%")).toBeInTheDocument();
  expect(screen.getAllByText("Not published").length).toBeGreaterThan(0);
  expect(screen.queryByText("TSLA")).not.toBeInTheDocument();
  const negative = screen.getByText("-1.25%");
  expect(negative).toHaveClass("negative");
  expect(screen.queryByText("+-1.25%")).not.toBeInTheDocument();
  expect(screen.getByText("WEDNESDAY · 12 AUGUST")).toBeInTheDocument();
  expect(view.container.querySelector(".market-status")).toHaveTextContent("S&P 500 up +0.31%");
  expect(view.container.querySelector(".earnings-mini")).toHaveTextContent("Future Corp");
  expect(view.container.querySelector(".earnings-mini")).not.toHaveTextContent("Past Corp");
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
    provider: "cache", status: "degraded", asOf: "2026-08-10T16:00:00Z",
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
  await waitFor(() => expect(screen.getByText("Demo fallback active")).toBeInTheDocument());
  expect(screen.queryByText("9,999.00")).not.toBeInTheDocument();
  expect(screen.getAllByText("Demo").length).toBeGreaterThan(0);
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
  await waitFor(() => expect(screen.getByText("Demo fallback active")).toBeInTheDocument());
  expect(screen.queryByText("Constructive session.")).not.toBeInTheDocument();
  expect(screen.queryByText("0.00")).not.toBeInTheDocument();
});

it("sorts fresh candidate fallback by score and does not invent a daily move", async () => {
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
  await waitFor(() => expect(screen.getByText("Backend partially populated")).toBeInTheDocument());
  const rows = [...view.container.querySelectorAll(".opportunity-row")];
  expect(rows[0]).toHaveTextContent("HIGH");
  expect(rows[0]).toHaveTextContent("Not published");
  expect(rows[0]).not.toHaveTextContent("0.00%");
});

it("refreshes backend data when the page becomes visible", async () => {
  renderApp();
  await waitFor(() => expect(screen.getByText("Backend connected")).toBeInTheDocument());
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
