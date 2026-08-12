import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, useLocation } from "react-router-dom";
import MorningBriefingApp from "./MorningBriefingApp";

const renderApp = (path = "/") => render(<MemoryRouter initialEntries={[path]}><MorningBriefingApp/></MemoryRouter>);
function RoutedApp() {
  const location = useLocation();
  return <><output aria-label="Current path">{location.pathname}</output><MorningBriefingApp/></>;
}

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

  it("discloses the decorative demo chart", () => {
    const view = renderApp();
    expect(screen.getByText("Demo chart")).toBeInTheDocument();
    expect(view.container.querySelector(".hero-chart")).toHaveAttribute("aria-hidden", "true");
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

  it("shows one filter per tracked account and keeps the source badge separate from time", async () => {
    const view = renderApp();
    fireEvent.click(screen.getAllByRole("button", { name: "X Pulse" })[0]!);
    await screen.findByRole("heading", { level: 1, name: /X Pulse/ });

    expect(screen.getByRole("button", { name: "All" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "@nolimitgains" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Markets" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "AI" })).not.toBeInTheDocument();
    expect(screen.queryByText("Top Social Buzz")).not.toBeInTheDocument();
    expect(screen.queryByText("Trending Keywords")).not.toBeInTheDocument();

    const postStatus = view.container.querySelector(".post-status");
    expect(postStatus?.querySelector(".data-source")).not.toBeNull();
    expect(postStatus?.querySelector("time")).not.toBeNull();
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
    renderApp();
    fireEvent.click(screen.getAllByRole("button", { name: /NVDA NVIDIA Corporation/ })[0]!);
    expect(screen.getByRole("dialog")).toHaveTextContent("OPPORTUNITY DETAIL");

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Earnings" })[0]!);
    await screen.findByRole("heading", { name: /Earnings Calendar/ });
    fireEvent.click(await screen.findByRole("button", { name: /MSFT AMC/ }));

    expect(await screen.findByText("Earnings Detail")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /View Official Earnings Report/ }))
      .toHaveAttribute("href", "https://www.microsoft.com/en-us/Investor");
  });
});
