import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import App from "../App";
import MorningBriefingApp from "./MorningBriefingApp";
import { localDateLabel, marketGreeting } from "./local-time";
import { ThemeProvider } from "../shell/theme";

// The Morning Briefing pages now live inside the dashboard shell, which owns
// navigation (sidebar links / mobile drawer) and the theme toggle. Rendering the
// full <App/> lets these tests drive navigation through the real shell chrome.
const renderApp = (path = "/") => render(<MemoryRouter initialEntries={[path]}><App/></MemoryRouter>);
function RoutedApp() {
  const location = useLocation();
  return <><output aria-label="Current path">{location.pathname}</output><App/></>;
}
function HistoryApp() {
  const navigate = useNavigate();
  return <><button onClick={() => navigate(-1)}>Browser Back</button><ThemeProvider><MorningBriefingApp/></ThemeProvider></>;
}

const stubEarningsSchedule = () => {
  vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/status") {
      return new Response(JSON.stringify({
        candidates: [],
        briefing: { available: true, freshness: "fresh", publishedAt: "2026-08-12T12:30:00Z" },
      }), { status: 200 });
    }
    if (url === "/api/earnings") {
      return new Response(JSON.stringify([
        { symbol: "MSFT", company: "Microsoft", date: "2026-08-15", timing: "AMC", eventSignal: "Confirmed", officialReportUrl: "https://www.microsoft.com/en-us/Investor" },
      ]), { status: 200 });
    }
    return new Response(null, { status: 503 });
  });
};

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
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
  it("opens on Morning Briefing and navigates between the three areas via the shell", async () => {
    render(<MemoryRouter initialEntries={["/"]}><RoutedApp/></MemoryRouter>);
    expect(screen.getByText(/economic calendar and top stories/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("link", { name: "X Pulse" }));
    expect(await screen.findByRole("heading", { level: 1, name: /X Pulse/ })).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Current path" })).toHaveTextContent("/x");

    fireEvent.click(screen.getByRole("link", { name: "Earnings" }));
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

  it("keeps a manually selected month stable across a page refresh", async () => {
    const view = renderApp("/earnings");
    await screen.findByRole("heading", { level: 2, name: "August 2026" });
    fireEvent.click(screen.getByRole("button", { name: "Next month" }));
    expect(screen.getByRole("heading", { level: 2, name: "September 2026" })).toBeInTheDocument();
    view.unmount();
    renderApp("/earnings");
    expect(await screen.findByRole("heading", { level: 2, name: "September 2026" })).toBeInTheDocument();
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

  it("greets by the visitor's local hour regardless of machine timezone", () => {
    // A local-time Date constructor interprets the components in the machine's
    // own timezone, so getHours() is deterministic on Linux, macOS and Windows
    // without any process-level TZ pinning.
    expect(marketGreeting(new Date(2026, 7, 12, 10, 0, 0))).toBe("Good morning.");
    expect(marketGreeting(new Date(2026, 7, 12, 16, 0, 0))).toBe("Good afternoon.");
    expect(marketGreeting(new Date(2026, 7, 12, 22, 30, 0))).toBe("Good evening.");
  });

  it("covers the greeting hour boundaries at 5am and 5pm local", () => {
    expect(marketGreeting(new Date(2026, 7, 12, 4, 59, 0))).toBe("Good evening.");
    expect(marketGreeting(new Date(2026, 7, 12, 5, 0, 0))).toBe("Good morning.");
    expect(marketGreeting(new Date(2026, 7, 12, 11, 59, 0))).toBe("Good morning.");
    expect(marketGreeting(new Date(2026, 7, 12, 12, 0, 0))).toBe("Good afternoon.");
    expect(marketGreeting(new Date(2026, 7, 12, 16, 59, 0))).toBe("Good afternoon.");
    expect(marketGreeting(new Date(2026, 7, 12, 17, 0, 0))).toBe("Good evening.");
  });

  it("labels the visitor's local day and date", () => {
    // The weekday is a calendar fact (the same in every timezone); the local
    // constructor keeps the day-of-month and month fixed on any machine.
    expect(localDateLabel(new Date(2026, 7, 12, 10, 0, 0))).toBe("WEDNESDAY · 12 AUGUST");
    expect(localDateLabel(new Date(2026, 8, 1, 1, 0, 0))).toBe("TUESDAY · 1 SEPTEMBER");
  });

  it("keeps TradingView widgets in sync with the active theme", async () => {
    renderApp();
    await screen.findByText(/economic calendar and top stories/);
    const ticker = () => document.querySelector("tv-ticker-tape");
    const marketOverview = () => document.querySelector("tv-market-overview");
    // The global tape + market overview are web components: the theme updates in
    // place via the official theme attribute (no script remount).
    await waitFor(() => expect(marketOverview()?.getAttribute("theme")).toBe("light"));
    expect(ticker()?.getAttribute("theme")).toBe("light");

    fireEvent.click(screen.getAllByRole("button", { name: "Switch to dark mode" })[0]!);
    await waitFor(() => expect(marketOverview()?.getAttribute("theme")).toBe("dark"));
    expect(ticker()?.getAttribute("theme")).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");

    // The iframe widgets re-inject their script with the new colorTheme.
    const storiesScript = document.querySelector("script[data-tv-iframe-widget='timeline']");
    expect(storiesScript).not.toBeNull();
    await waitFor(() =>
      expect(JSON.parse(storiesScript!.textContent ?? "{}").colorTheme).toBe("dark"),
    );
  });

  it("shows one filter per tracked account without technical source badges", async () => {
    const view = renderApp();
    fireEvent.click(screen.getByRole("link", { name: "X Pulse" }));
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

  it("opens earnings details", async () => {
    stubEarningsSchedule();
    renderApp();
    fireEvent.click(screen.getByRole("link", { name: "Earnings" }));
    await screen.findByRole("heading", { name: /Earnings Calendar/ });
    fireEvent.click(await screen.findByRole("button", { name: /MSFT.*AMC/ }));

    expect(await screen.findByRole("dialog", { name: "Earnings Detail" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Back" })).toHaveFocus();
    expect(screen.getByRole("link", { name: /Official Earnings Report/ }))
      .toHaveAttribute("href", "https://www.microsoft.com/en-us/Investor");
  });

  it("closes an open detail when browser history changes the page", async () => {
    stubEarningsSchedule();
    render(<MemoryRouter initialEntries={["/", "/earnings"]} initialIndex={1}><HistoryApp/></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: /MSFT.*AMC/ }));
    expect(await screen.findByRole("dialog", { name: "Earnings Detail" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Browser Back" }));
    expect(await screen.findByText(/economic calendar and top stories/)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(document.body.style.overflow).toBe(""));
  });

  it("renders reported results, real summary counts and official links", async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/earnings") {
        return new Response(JSON.stringify({
          from: "2026-01-01",
          to: "2026-10-12",
          summary: { today: 1, thisWeek: 2, next60Days: 1 },
          events: [{
            id: "MSFT-2026-Q1", symbol: "MSFT", company: "Microsoft", cik: "0000789012",
            fiscalYear: 2026, fiscalQuarter: 1, fiscalPeriod: "Q1", fiscalPeriodEnd: "2026-06-30",
            scheduledDate: "2026-08-12", scheduledTime: "16:00:00", timing: "AMC", status: "reported",
            scheduled: false, reported: true, cancelled: false, unknown: false,
            epsEstimate: 3, epsActual: 3.3, epsSurprise: 0.3, epsSurprisePct: 10, epsResult: "Beat",
            revenueEstimate: 100, revenueActual: 90, revenueSurprise: -10, revenueSurprisePct: -10, revenueResult: "Miss",
            overallResult: "Mixed", reportedAt: null,
            calendarProvider: "finnhub-earnings-calendar", consensusProvider: "finnhub-earnings-calendar",
            providerEventId: "msft-event", providerUpdatedAt: "2026-08-12T20:10:00.000Z",
            officialReportUrl: "https://example.test/msft-release", investorRelationsUrl: "https://example.test/msft-ir",
            secFilingUrl: "https://www.sec.gov/Archives/edgar/data/789012/000078901226000001/msft8k.htm",
            secAccession: "0000789012-26-000001", secForm: "8-K", secFiledAt: "2026-08-12T00:00:00.000Z",
            createdAt: "2026-08-12T20:00:00.000Z", updatedAt: "2026-08-12T20:10:00.000Z", lastCheckedAt: "2026-08-12T20:15:00.000Z",
          }, {
            id: "AAPL-2026-Q3", symbol: "AAPL", company: "Apple", cik: null,
            fiscalYear: 2026, fiscalQuarter: 3, fiscalPeriod: "Q3", fiscalPeriodEnd: null,
            scheduledDate: "2026-08-20", scheduledTime: null, timing: "BMO", status: "scheduled",
            scheduled: true, reported: false, cancelled: false, unknown: false,
            epsEstimate: null, epsActual: null, epsSurprise: null, epsSurprisePct: null, epsResult: "Not Available",
            revenueEstimate: null, revenueActual: null, revenueSurprise: null, revenueSurprisePct: null, revenueResult: "Not Available",
            overallResult: "Not Available", reportedAt: null,
            calendarProvider: "finnhub-earnings-calendar", consensusProvider: "finnhub-earnings-calendar",
            providerEventId: "aapl-event", providerUpdatedAt: "2026-08-12T20:10:00.000Z",
            officialReportUrl: null, investorRelationsUrl: null, secFilingUrl: null, secAccession: null, secForm: null, secFiledAt: null,
            createdAt: "2026-08-12T20:00:00.000Z", updatedAt: "2026-08-12T20:10:00.000Z", lastCheckedAt: null,
          }],
        }), { status: 200 });
      }
      return new Response(null, { status: 503 });
    });
    const view = renderApp("/earnings");
    const summary = await screen.findByLabelText("Earnings summary");
    expect(summary).toHaveTextContent(/TODAY\s*1/);
    expect(summary).toHaveTextContent(/THIS WEEK\s*1/);
    expect(summary).toHaveTextContent(/NEXT 60 DAYS\s*2/);
    expect(view.container).toHaveTextContent("Mixed");
    const ticker = (await screen.findAllByText("MSFT")).find((element) => element.tagName === "B");
    expect(ticker).toBeDefined();
    fireEvent.click(ticker!.closest("button")!);
    const drawer = await screen.findByRole("dialog", { name: "Earnings Detail" });
    expect(drawer).toHaveTextContent("3.3");
    expect(drawer).toHaveTextContent("+10.00%");
    expect(drawer).toHaveTextContent("Mixed");
    expect(drawer).toHaveTextContent(/Reported at\s*N\/A/);
    expect(screen.getByRole("link", { name: /Official Earnings Report/ })).toHaveAttribute("href", "https://example.test/msft-release");
    expect(screen.getByRole("link", { name: /SEC Filing/ })).toHaveAttribute("href", expect.stringContaining("sec.gov"));
    expect(screen.getByRole("link", { name: /Investor Relations/ })).toHaveAttribute("href", "https://example.test/msft-ir");
    expect(view.container.querySelector(".earnings-table")).toHaveTextContent("Mixed");
  });

  it("renders the earnings calendar Monday-first with earnings pinned to their dates", async () => {
    stubEarningsSchedule();
    renderApp("/earnings");
    await screen.findByRole("heading", { name: /Earnings Calendar/ });
    const msftButton = await screen.findByRole("button", { name: /MSFT.*AMC/ });
    const weekdays = Array.from(document.querySelectorAll(".weekdays span")).map((el) => el.textContent);
    expect(weekdays).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
    const cells = Array.from(document.querySelectorAll(".calendar-grid > div"));
    expect(cells).toHaveLength(42);
    expect(cells.slice(0, 5).every((cell) => cell.classList.contains("empty"))).toBe(true);
    expect(cells[5]!.querySelector(".day-number")).toHaveTextContent("1");
    expect(cells[6]!.querySelector(".day-number")).toHaveTextContent("2");
    expect(cells[7]!.querySelector(".day-number")).toHaveTextContent("3");
    // MSFT is scheduled for 2026-08-15 (a Saturday): index 5 + (15 - 1) = 19.
    const msftCell = cells[19]!;
    expect(msftCell.querySelector(".day-number")).toHaveTextContent("15");
    expect(msftCell).toContainElement(msftButton);
  });

  it("counts THIS WEEK with a Monday-anchored week", async () => {
    // Today is Monday 2026-08-17 (NY); the only event sits on the previous
    // Sunday 2026-08-16. With a Monday-first week that Sunday belongs to last
    // week, so THIS WEEK must be 0 — a Sunday-anchored week would report 1.
    vi.mocked(Date.now).mockReturnValue(Date.parse("2026-08-17T16:00:00Z"));
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/earnings") {
        return new Response(JSON.stringify([
          { symbol: "TST", company: "Test Corp", date: "2026-08-16", timing: "BMO", eventSignal: "Confirmed" },
        ]), { status: 200 });
      }
      return new Response(null, { status: 503 });
    });
    renderApp("/earnings");
    const summary = await screen.findByLabelText("Earnings summary");
    await waitFor(() => expect(summary).toHaveTextContent(/THIS WEEK\s*0/));
  });
});