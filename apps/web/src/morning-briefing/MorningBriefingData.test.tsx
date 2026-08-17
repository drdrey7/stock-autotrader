import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import MorningBriefingApp from "./MorningBriefingApp";
import { ThemeProvider } from "../shell/theme";

const renderApp = (path = "/") => render(<MemoryRouter initialEntries={[path]}><ThemeProvider><MorningBriefingApp/></ThemeProvider></MemoryRouter>);
const useFixtureClock = () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date("2026-08-12T22:30:00Z"));
};

// The briefing feed that used to drive the Top Opportunities section is
// retired; the fixture now only survives as the publication timestamp that the
// /api/status health response echoes back.
const briefing = { preparedAt: "2026-08-12T12:30:00Z" };

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-08-12T22:30:00Z"));
  Object.defineProperty(window, "matchMedia", { configurable: true, value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })) });
  Object.defineProperty(window, "scrollTo", { configurable: true, value: vi.fn() });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/status") return new Response(JSON.stringify({
      candidates: [{ symbol: "NVDA", quantScore: 91 }],
      briefing: { available: true, freshness: "fresh", publishedAt: briefing.preparedAt },
    }), { status: 200 });
    if (url.startsWith("/api/x/posts")) return new Response(JSON.stringify({ posts: [
      { id: "older", author: "@nolimitgains", text: "Older post", created_at: "2026-08-11T19:30:00Z", url: "https://x.com/nolimitgains/status/older", symbol: null, company: null, price: null, change: null },
      { id: "newer", author: "@nolimitgains", text: "Newest post", created_at: "2026-08-12T20:30:00Z", url: "https://x.com/nolimitgains/status/newer", symbol: null, company: null, price: null, change: null },
    ], count: 2 }), { status: 200 });
    if (url === "/api/earnings") return new Response(JSON.stringify([
      { symbol: "OLD", company: "Past Corp", date: "2026-08-03", timing: "AMC", eventSignal: "Confirmed" },
      { symbol: "NEW", company: "Future Corp", date: "2026-08-14", timing: "BMO", eventSignal: "Confirmed" },
    ]), { status: 200 });
    return new Response(null, { status: 404 });
  }));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("mounts the TradingView widget sections on the homepage", async () => {
  const view = renderApp();
  // The market overview is a web component; the calendar and top stories are
  // framed iframe widgets. (The global tape lives in the app shell and is
  // exercised by the shell-level test in MorningBriefingApp.test.tsx.)
  await waitFor(() => expect(view.container.querySelectorAll(".tv-wc-host")).toHaveLength(1));
  expect(view.container.querySelector(".tv-market-overview-host")).not.toBeNull();
  expect(view.container.querySelector(".tv-widget-events")).not.toBeNull();
  expect(view.container.querySelector(".tv-widget-timeline")).not.toBeNull();
  // The iframe widgets carry the required TradingView attribution element.
  expect(view.container.querySelectorAll(".tradingview-widget-copyright")).toHaveLength(2);
});

it("renders the homepage without a Top Opportunities section", async () => {
  useFixtureClock();
  const view = renderApp();
  await waitFor(() => expect(view.container.querySelector(".market-overview-frame")).not.toBeNull());
  // Top Opportunities is removed from the homepage for now: no heading, no
  // rows, and the provider no longer even fetches the briefing feed that used
  // to drive them.
  expect(screen.queryByText("Top Opportunities")).not.toBeInTheDocument();
  expect(view.container.querySelector(".opportunity-row")).toBeNull();
  expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input) === "/api/briefs/latest")).toBe(false);
});

it("shows restrained TradingView widget states instead of fabricated market data when the backend is down", async () => {
  vi.mocked(fetch).mockImplementation(async () => new Response(null, { status: 503 }));
  const view = renderApp();

  // The market-overview web component and the two iframe widgets all mount.
  // The WC module import cannot load in jsdom, so the host surfaces its error
  // state; the iframe scripts stay loading until we signal a script failure.
  await waitFor(() => expect(view.container.querySelectorAll(".tv-wc-error")).toHaveLength(1));
  expect(view.container.querySelectorAll(".tv-widget-state.tv-widget-loading")).toHaveLength(2);
  expect(view.container.querySelectorAll("script[data-tv-iframe-widget]")).toHaveLength(2);

  view.container.querySelectorAll("script[data-tv-iframe-widget]").forEach((script) => {
    script.dispatchEvent(new Event("error"));
  });
  await waitFor(() => expect(view.container.querySelectorAll(".tv-widget-error")).toHaveLength(2));
  expect(view.container).toHaveTextContent("Market widget temporarily unavailable");
  // The web-component fallback renders alongside the iframe ones.
  expect(view.container).toHaveTextContent("Market overview temporarily unavailable");
  // No fabricated/demo market figures anywhere.
  expect(view.container).not.toHaveTextContent("6,427.18");
  expect(view.container).not.toHaveTextContent("NVDA");
  expect(view.container.querySelectorAll(".opportunity-row")).toHaveLength(0);
});

it("keeps unavailable sentiment explicit without fixture numbers", async () => {
  vi.mocked(fetch).mockImplementation(async () => new Response(null, { status: 503 }));
  const view = renderApp();

  expect(screen.getByRole("heading", { name: "Fear & Greed" })).toBeInTheDocument();
  // No synthetic reading: the gauge itself says "Not available".
  expect(view.container.querySelector(".gauge-mask strong")).toHaveTextContent("Not available");
  expect(view.container.querySelector(".sentiment-card")).toHaveTextContent("Not available");
  expect(view.container).not.toHaveTextContent("72");
  expect(view.container).not.toHaveTextContent("4.28%");
  expect(view.container).not.toHaveTextContent("$80.21");
});

it("never renders the backend edition tag in the hero", async () => {
  const view = renderApp();
  await screen.findByText(/economic calendar and top stories/);
  // The hero shows only the visitor's local day/date + greeting — no
  // PRE-MARKET / POST-CLOSE / edition tag anywhere on the homepage.
  expect(view.container).not.toHaveTextContent("POST-CLOSE");
  expect(view.container).not.toHaveTextContent("PRE-MARKET");
  expect(screen.getByRole("heading", { level: 1 })).toBeInTheDocument();
});

it("announces the full date for earnings calendar events", async () => {
  sessionStorage.clear();
  renderApp("/earnings");
  expect(await screen.findByRole("heading", { name: "Earnings Calendar" })).toBeInTheDocument();
  expect(await screen.findByRole("button", { name: /Future Corp, Scheduled · BMO, Friday, August 14, 2026/i })).toBeInTheDocument();
});

it("fails closed when the earnings payload has an invalid event list", async () => {
  const originalFetch = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === "/api/earnings") return new Response(JSON.stringify({ events: {} }), { status: 200 });
    return originalFetch(input, init);
  });

  const view = renderApp("/earnings");
  // { events: {} } is not an array: the payload is rejected, so the calendar
  // must present itself as unavailable rather than pretend it has data.
  await waitFor(() => expect(view.container.querySelector(".earnings-top-summary")).toHaveTextContent("—"));
  expect(view.container.querySelector(".earnings-top-summary")).toHaveTextContent("N/A");
  expect(view.container.querySelector(".past-card")).toHaveTextContent("No recent earnings published.");
});

it("fails closed when an earnings event contains an invalid date", async () => {
  vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
    if (String(input) === "/api/earnings") return new Response(JSON.stringify([
      { symbol: "BAD", company: "Malformed Corp", date: "2026-99-99", timing: "BMO" },
    ]), { status: 200 });
    return new Response(null, { status: 404 });
  });

  const view = renderApp("/earnings");
  await waitFor(() => expect(view.container.querySelector(".earnings-top-summary")).toHaveTextContent("—"));
  expect(view.container).not.toHaveTextContent("Malformed Corp");
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

  renderApp("/earnings");
  expect(await screen.findByRole("button", { name: /FULL.*Full Shape Corp/ })).toBeInTheDocument();
});

it("drops only the invalid records and keeps the valid ones", async () => {
  vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
    if (String(input) === "/api/earnings") return new Response(JSON.stringify([
      { symbol: "GOOD", company: "Valid Corp", date: "2026-08-19", timing: "BMO" },
      { symbol: "BAD", company: "Malformed Corp", date: "2026-99-99", timing: "BMO" },
    ]), { status: 200 });
    return new Response(null, { status: 404 });
  });

  renderApp("/earnings");
  expect(await screen.findByRole("button", { name: /Valid Corp/ })).toBeInTheDocument();
  expect(screen.queryByText("Malformed Corp")).not.toBeInTheDocument();
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

it("renders the homepage without waiting for a stalled X request", async () => {
  useFixtureClock();
  vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/status") return new Response(JSON.stringify({ candidates: [], briefing: { available: true, freshness: "fresh", publishedAt: briefing.preparedAt } }), { status: 200 });
    if (url.startsWith("/api/x/posts")) return await new Promise<Response>(() => undefined);
    if (url === "/api/earnings") return new Response(JSON.stringify([{ symbol: "NEW", company: "Future Corp", date: "2026-08-14", timing: "BMO", eventSignal: "Confirmed" }]), { status: 200 });
    return new Response(null, { status: 404 });
  });

  const view = renderApp();
  await waitFor(() => expect(view.container.querySelector(".market-overview-frame")).not.toBeNull());
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

  const view = renderApp("/earnings");
  await waitFor(() => expect(view.container.querySelector(".earnings-top-summary")).toHaveTextContent("—"));
  expect(view.container).not.toHaveTextContent("Future Corp");
  expect(view.container.querySelector(".past-card")).toHaveTextContent("No recent earnings published.");
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

  const view = renderApp("/earnings");
  await screen.findByRole("button", { name: /Future Corp/ });
  await vi.advanceTimersByTimeAsync(60 * 60_000);
  await waitFor(() => expect(earningsCalls).toBeGreaterThanOrEqual(2));
  await waitFor(() => expect(view.container.querySelector(".earnings-top-summary")).toHaveTextContent("—"));
  vi.useRealTimers();
});

it("keeps the homepage stable during a transient status failure", async () => {
  let statusRequests = 0;
  const originalFetch = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === "/api/status") {
      statusRequests += 1;
      if (statusRequests === 1) {
        return new Response(JSON.stringify({
          briefing: { available: true, freshness: "fresh", publishedAt: briefing.preparedAt },
          sentiment: { provider: "cnn-fear-greed", score: 62, rating: "greed", asOf: "2026-08-12T21:00:00Z" },
        }), { status: 200 });
      }
      return new Response(null, { status: 503 });
    }
    return originalFetch(input, init);
  });

  const view = renderApp();
  await waitFor(() => expect(view.container.querySelector(".sentiment-card")).toHaveTextContent("Greed"));
  document.dispatchEvent(new Event("visibilitychange"));
  await waitFor(() => expect(statusRequests).toBeGreaterThan(1));
  // A transient failure must not blank the homepage: the retained sentiment
  // reading and the static widget sections all remain mounted.
  expect(view.container.querySelector(".sentiment-card")).toHaveTextContent("Greed");
  expect(view.container.querySelector(".market-overview-frame")).not.toBeNull();
  expect(view.container.querySelector(".calendar-block")).not.toBeNull();
});

it("does not render source-health badges anywhere", async () => {
  const view = renderApp();
  await waitFor(() => expect(view.container.querySelector(".market-overview-frame")).not.toBeNull());
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

it("clears the sentiment card after the backend stops publishing", async () => {
  let coreAvailable = true;
  const originalFetch = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!coreAvailable && url === "/api/status") {
      return new Response(null, { status: 503 });
    }
    if (url === "/api/status") {
      return new Response(JSON.stringify({
        briefing: { available: true, freshness: "fresh", publishedAt: briefing.preparedAt },
        sentiment: { provider: "cnn-fear-greed", score: 62, rating: "greed", asOf: "2026-08-12T21:00:00Z" },
      }), { status: 200 });
    }
    return originalFetch(input, init);
  });

  const view = renderApp();
  await waitFor(() => expect(view.container.querySelector(".sentiment-card")).toHaveTextContent("Greed"));

  coreAvailable = false;
  // Advance beyond the 72h sentiment window so the retained reading expires
  // and the card must clear to "Not available".
  vi.mocked(Date.now).mockReturnValue(Date.parse("2026-08-16T01:00:00Z"));
  document.dispatchEvent(new Event("visibilitychange"));
  await waitFor(() => expect(view.container.querySelector(".sentiment-card .gauge-mask strong")).toHaveTextContent("Not available"));
  expect(view.container.querySelector(".sentiment-card .gauge-mask span")).toHaveTextContent("Fear & Greed");
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
  vi.setSystemTime(new Date("2026-08-13T03:59:00Z")); // 23:59 ET on 12 Aug
  const originalFetch = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === "/api/earnings") return new Response(JSON.stringify([
      { symbol: "ROLL", company: "Rollover Corp", date: "2026-08-12", timing: "AMC", eventSignal: "Confirmed" },
    ]), { status: 200 });
    return originalFetch(input, init);
  });

  const view = renderApp("/earnings");
  await screen.findByRole("button", { name: /Rollover Corp/ });
  const todayCount = () => view.container.querySelector(".earnings-top-summary > .card strong")?.textContent;
  // Before midnight ET the report counts as "today".
  expect(todayCount()).toBe("1");
  vi.setSystemTime(new Date("2026-08-13T04:01:00Z")); // 00:01 ET on 13 Aug
  await vi.advanceTimersByTimeAsync(60_000);
  await waitFor(() => expect(vi.mocked(fetch).mock.calls.filter(([input]) => String(input) === "/api/earnings")).toHaveLength(2));
  await waitFor(() => expect(todayCount()).toBe("0"));
  vi.useRealTimers();
});

it("renders the fear & greed number and gauge from the status sentiment", async () => {
  const freshIso = "2026-08-12T22:00:00.000Z";
  vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
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
  // The simplified card shows the score, one label, the gauge and a small
  // "Updated ..." timestamp — no Momentum / Risk appetite rows.
  expect(view.container.querySelector(".sentiment-card .card-subtitle")).toHaveTextContent("Updated");
  expect(view.container.querySelector(".sentiment-card")).not.toHaveTextContent("Not available");
});

it("keeps the sentiment card unavailable when the reading is stale", async () => {
  vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/status") return new Response(JSON.stringify({
      briefing: { available: false, freshness: "unavailable", publishedAt: null },
      sentiment: { provider: "cnn-fear-greed", score: 62, rating: "greed", asOf: "2026-08-01T12:00:00Z" },
    }), { status: 200 });
    return new Response(null, { status: 404 });
  });

  const view = renderApp();
  await waitFor(() => expect(view.container.querySelector(".sentiment-card")).toHaveTextContent("Not available"));
  expect(view.container.querySelector(".sentiment-card .gauge-value")).toBeNull();
});
