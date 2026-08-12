import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MorningBriefingApp from "./MorningBriefingApp";

beforeEach(() => {
  localStorage.clear();
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

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Morning Briefing frontend demo", () => {
  it("opens on Morning Briefing and navigates between the three areas", async () => {
    render(<MorningBriefingApp />);
    expect(screen.getByRole("heading", { name: "Good morning." })).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole("button", { name: "X Pulse" })[0]!);
    expect(await screen.findByRole("heading", { level: 1, name: /X Pulse/ })).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole("button", { name: "Earnings" })[0]!);
    expect(await screen.findByRole("heading", { name: /Earnings Calendar/ })).toBeInTheDocument();
  });

  it("shows one filter per tracked account and keeps the source badge separate from time", async () => {
    const view = render(<MorningBriefingApp />);
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
    render(<MorningBriefingApp />);
    const toggle = (await screen.findAllByRole("button", { name: "Switch to dark mode" }))[0]!;
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(document.documentElement.dataset.theme).toBe("dark");
      expect(localStorage.getItem("morning-briefing-theme")).toBe("dark");
    });
  });

  it("opens opportunity and earnings details", async () => {
    render(<MorningBriefingApp />);
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
