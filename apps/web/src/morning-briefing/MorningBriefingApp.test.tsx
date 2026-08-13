import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import MorningBriefingApp from "./MorningBriefingApp";

const renderApp = (path = "/") => render(<MemoryRouter initialEntries={[path]}><MorningBriefingApp/></MemoryRouter>);
function RoutedApp() {
  const location = useLocation();
  return <><output aria-label="Current path">{location.pathname}</output><MorningBriefingApp/></>;
}
function HistoryApp() {
  const navigate = useNavigate();
  return <><button onClick={() => navigate(-1)}>Browser Back</button><MorningBriefingApp/></>;
}

const liveBriefingForDetails = {
  example: false,
  editionDate: "2026-08-12",
  editionType: "pre_market",
  timezone: "America/New_York",
  preparedAt: "2026-08-12T12:30:00Z",
  title: "Pre-market briefing",
  marketSummary: "Constructive session.",
  market: [
    { name: "S&P 500", symbol: "SP:SPX", value: "6412.10", change: "+0.31%", state: "Constructive", note: "Holding." },
    { name: "Nasdaq-100", symbol: "NASDAQ:NDX", value: "23830.02", change: "+0.55%", state: "Leading", note: "Leading." },
    { name: "VIX", symbol: "CBOE:VIX", value: "15.40", change: "-2.10%", state: "Contained", note: "Calm." },
  ],
  ideas: [{
    symbol: "NVDA", company: "NVIDIA Corporation", universe: "Both", verdict: "Potential Entry",
    price: "$183.10", change: "+1.75%", thesis: "Relative strength supports the setup.",
    source: { handle: "@nolimitgains", reference: "https://x.com/nolimitgains/status/1234", originalTimestamp: null, collectedTimestamp: null, summary: "Source." },
    technical: ["Strong"], financial: ["Healthy"], news: ["Clear"], risks: ["Gap risk"],
    levels: { trigger: "Above $183.60", invalidation: "Below $179.20", objective: "$194", rewardRisk: "2.6R", rewardRiskRatio: 2.6 },
  }],
  schedule: [],
};

const stubEarningsSchedule = () => {
  vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/briefs/latest") {
      return new Response(JSON.stringify(liveBriefingForDetails), { status: 200 });
    }
    if (url === "/api/status") {
      return new Response(JSON.stringify({
        candidates: [],
        briefing: { available: true, freshness: "fresh", publishedAt: liveBriefingForDetails.preparedAt },
      }), { status: 200 });
    }
    if (url === "/api/earnings") {
      return new Response(JSON.stringify([
        { symbol: "MSFT", company: "Microsoft", date: "2026-08-15", timing: "AMC", eventSignal: "Confirmed" },
      ]), { status: 200 });
    }
    return new Response(null, { status: 503 });
  });
};

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-08-12T16:00:00Z"));
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline test fallback")));
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
  Object.defineProperty(window, "scrollTo", {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("Morning Briefing frontend demo", () => {
  it("opens on Morning Briefing and navigates between the three areas", async () => {
    render(<MemoryRouter initialEntries={["/"]}><RoutedApp/></MemoryRouter>);
    expect(screen.getByRole("heading", { name: "Good morning." })).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole("button", { name: "X Pulse" })[0]!);
    expect(await screen.findByRole("heading", { level: 1, name: /X Pulse/ })).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Current path" })).toHaveTextContent("/x");

    fireEvent.click(screen.getAllByRole("button", { name: "Earnings" })[0]!);
    expect(await screen.findByRole("heading", { name: /Earnings Calendar/ })).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Current path" })).toHaveTextContent("/earnings");
  });

  it("does not show a synthetic chart while market data is unavailable", () => {
    const view = renderApp();
    expect(screen.queryByText("Demo chart")).not.toBeInTheDocument();
    expect(view.container.querySelector(".hero-chart")).toBeNull();
  });

  it("moves the earnings calendar across years and returns to today", async () => {
    renderApp("/earnings");
    const initial = await screen.findByRole("heading", { level: 2, name: "August 2026" });
    expect(initial).toHaveTextContent("August 2026");
    for (let index = 0; index < 5; index += 1) fireEvent.click(screen.getByRole("button", { name: "Next month" }));
    expect(screen.getByRole("heading", { level: 2, name: "January 2027" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Today" }));
    expect(screen.getByRole("heading", { level: 2, name: "August 2026" })).toBeInTheDocument();
  });

  it("uses the New York market date for calendar Today near a UTC boundary", async () => {
    vi.mocked(Date.now).mockReturnValue(Date.parse("2026-09-01T01:00:00Z"));
    renderApp("/earnings");
    expect(await screen.findByRole("heading", { level: 2, name: "August 2026" })).toBeInTheDocument();
    expect(document.querySelector(".is-today .day-number")).toHaveTextContent("31");
    expect(document.querySelectorAll(".calendar-grid > div")).toHaveLength(42);
    fireEvent.click(screen.getByRole("button", { name: "Next month" }));
    expect(screen.getByRole("heading", { level: 2, name: "September 2026" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Today" }));
    expect(screen.getByRole("heading", { level: 2, name: "August 2026" })).toBeInTheDocument();
  });

  it("uses the New York market date in the fallback briefing header", () => {
    vi.mocked(Date.now).mockReturnValue(Date.parse("2026-09-01T01:00:00Z"));
    renderApp();
    expect(screen.getByText("MONDAY · 31 AUGUST")).toBeInTheDocument();
  });

  it("shows one filter per tracked account without technical source badges", async () => {
    const view = renderApp();
    fireEvent.click(screen.getAllByRole("button", { name: "X Pulse" })[0]!);
    await screen.findByRole("heading", { level: 1, name: /X Pulse/ });

    expect(screen.getByRole("button", { name: "All" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "@nolimitgains" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Markets" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "AI" })).not.toBeInTheDocument();
    expect(screen.queryByText("Top Social Buzz")).not.toBeInTheDocument();
    expect(screen.queryByText("Trending Keywords")).not.toBeInTheDocument();

    expect(view.container.querySelector(".data-source")).toBeNull();
    expect(view.container.querySelector(".post-status")).toBeNull();
    expect(screen.getByText("No recent posts.")).toBeInTheDocument();
    expect(view.container.querySelector(".backend-ribbon")).toBeNull();
  });

  it("persists the selected colour theme", async () => {
    renderApp();
    const toggle = (await screen.findAllByRole("button", { name: "Switch to dark mode" }))[0]!;
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(document.documentElement.dataset.theme).toBe("dark");
      expect(localStorage.getItem("morning-briefing-theme")).toBe("dark");
    });
  });

  it("opens opportunity and earnings details", async () => {
    stubEarningsSchedule();
    renderApp();
    const opportunityTrigger = (await screen.findAllByRole("button", { name: /NVDA.*NVIDIA Corporation/ }))[0]!;
    opportunityTrigger.focus();
    fireEvent.click(opportunityTrigger);
    const opportunityDialog = screen.getByRole("dialog", { name: /NVDA/ });
    expect(opportunityDialog).toHaveTextContent("OPPORTUNITY DETAIL");
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(opportunityTrigger).toHaveFocus());
    fireEvent.click(screen.getAllByRole("button", { name: "Earnings" })[0]!);
    await screen.findByRole("heading", { name: /Earnings Calendar/ });
    fireEvent.click(await screen.findByRole("button", { name: /MSFT.*AMC/ }));

    expect(await screen.findByRole("dialog", { name: "Earnings Detail" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Back" })).toHaveFocus();
    expect(screen.getByRole("link", { name: /View Official Earnings Report/ }))
      .toHaveAttribute("href", "https://www.microsoft.com/en-us/Investor");
  });

  it("closes an open detail when browser history changes the page", async () => {
    stubEarningsSchedule();
    render(<MemoryRouter initialEntries={["/", "/earnings"]} initialIndex={1}><HistoryApp/></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: /MSFT.*AMC/ }));
    expect(await screen.findByRole("dialog", { name: "Earnings Detail" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Browser Back" }));
    expect(await screen.findByRole("heading", { name: "Good morning." })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(document.body.style.overflow).toBe(""));
  });
});
