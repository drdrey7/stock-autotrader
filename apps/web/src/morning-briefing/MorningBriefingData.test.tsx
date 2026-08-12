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
    { name: "S&P 500", symbol: "SP:SPX", value: "6,412.10", change: "+0.31%", state: "Constructive", note: "Holding." },
    { name: "Nasdaq-100", symbol: "NASDAQ:NDX", value: "23,830.02", change: "+0.55%", state: "Leading", note: "Leading." },
    { name: "VIX", symbol: "CBOE:VIX", value: "15.40", change: "-2.10%", state: "Contained", note: "Calm." },
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
  expect(screen.queryByText("TSLA")).not.toBeInTheDocument();
  const negative = screen.getByText("-1.25%");
  expect(negative).toHaveClass("negative");
  expect(screen.queryByText("+-1.25%")).not.toBeInTheDocument();
  expect(screen.getByText("WEDNESDAY · 12 AUGUST")).toBeInTheDocument();
  expect(view.container.querySelector(".earnings-mini")).toHaveTextContent("Future Corp");
  expect(view.container.querySelector(".earnings-mini")).not.toHaveTextContent("Past Corp");
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
