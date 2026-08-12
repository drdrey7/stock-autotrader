import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import MorningBriefingApp from "./MorningBriefingApp";

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
  }],
  schedule: [],
};

beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(window, "matchMedia", { configurable: true, value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })) });
  Object.defineProperty(window, "scrollTo", { configurable: true, value: vi.fn() });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/briefs/latest") return new Response(JSON.stringify(briefing), { status: 200 });
    if (url === "/api/status") return new Response(JSON.stringify({ candidates: [{ symbol: "NVDA", quantScore: 91 }], briefing: { available: true, freshness: "fresh", publishedAt: briefing.preparedAt } }), { status: 200 });
    if (url.startsWith("/api/x/posts")) return new Response(JSON.stringify({ posts: [], count: 0 }), { status: 200 });
    if (url === "/api/earnings") return new Response(JSON.stringify([]), { status: 200 });
    if (url === "/api/market-data") return new Response(JSON.stringify({ benchmarks: [] }), { status: 200 });
    return new Response(null, { status: 404 });
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("renders published briefing data as live and keeps missing domains as demo", async () => {
  render(<MorningBriefingApp />);
  await waitFor(() => expect(screen.getByText("Backend partially populated")).toBeInTheDocument());
  expect(screen.getAllByText("Live").length).toBeGreaterThan(0);
  expect(screen.getAllByText("Demo").length).toBeGreaterThan(0);
  expect(screen.getByText("+1.75%")).toBeInTheDocument();
});
