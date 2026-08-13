import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import indexHtml from "../index.html?raw";
import cloudflareHeaders from "../public/_headers?raw";

beforeEach(() => {
  localStorage.clear();
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
});

it("ships restrictive Cloudflare static-asset headers", () => {
  expect(cloudflareHeaders).toContain("Content-Security-Policy:");
  expect(cloudflareHeaders).toContain("frame-ancestors 'none'");
  expect(cloudflareHeaders).toContain("X-Frame-Options: DENY");
});

it("ships Morning Briefing metadata in the static HTML fallback", () => {
  expect(indexHtml).toContain("<title>Morning Briefing — Markets, Opportunities &amp; Insights</title>");
  expect(indexHtml).toContain('name="application-name" content="Morning Briefing"');
  expect(indexHtml).not.toContain("Stock Autotrader");
  expect(indexHtml).not.toContain("Stock Daily Briefing");
});

describe("Morning Briefing public experience", () => {
  it.each(["/", "/dashboard"])("opens Morning Briefing at %s", (path) => {
    render(<MemoryRouter initialEntries={[path]}><App /></MemoryRouter>);
    expect(screen.getByRole("heading", { name: "Good morning." })).toBeInTheDocument();
    expect(screen.getByText("Top Opportunities")).toBeInTheDocument();
    expect(screen.queryByText(/log in|sign in/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /buy|sell|trade/i })).not.toBeInTheDocument();
  });

  it("opens the X Pulse route directly", () => {
    render(<MemoryRouter initialEntries={["/x"]}><App /></MemoryRouter>);
    expect(screen.getByRole("heading", { name: /X Pulse/ })).toBeInTheDocument();
  });

  it("opens the Earnings route directly", () => {
    render(<MemoryRouter initialEntries={["/earnings"]}><App /></MemoryRouter>);
    expect(screen.getByRole("heading", { name: /Earnings Calendar/ })).toBeInTheDocument();
  });

  it.each([
    "/scanner", "/signals", "/stocks/NVDA", "/strategies",
    "/strategies/trend_breakout_v1", "/research", "/research/example",
    "/portfolio", "/market-data", "/activity",
  ])("redirects legacy route %s to Morning Briefing", async (path) => {
    render(<MemoryRouter initialEntries={[path]}><App /></MemoryRouter>);
    expect(await screen.findByRole("heading", { name: "Good morning." })).toBeInTheDocument();
  });

  it.each([
    ["/methodology", "Methodology"],
    ["/status", "System status"],
    ["/disclaimer", "Disclaimer"],
  ])("keeps public information route %s", (path, heading) => {
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
