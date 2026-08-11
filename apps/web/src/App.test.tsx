import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import cloudflareHeaders from "../public/_headers?raw";
import { demoData } from "./lib/api";
import { DataContext } from "./lib/data-context";
import { DataProvider, POLL_INTERVAL_MS } from "./lib/data-provider";

afterEach(cleanup);

it("ships restrictive Cloudflare static-asset headers", () => {
  expect(cloudflareHeaders).toContain("Content-Security-Policy:");
  expect(cloudflareHeaders).toContain("frame-ancestors 'none'");
  expect(cloudflareHeaders).toContain("X-Frame-Options: DENY");
});

describe("public application", () => {
  it("renders the clean landing headline", () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <App />
      </MemoryRouter>,
    );
    expect(
      screen.getByRole("heading", { name: /Data\. Analysis\. Opportunity\./i }),
    ).toBeInTheDocument();
    expect(screen.getAllByText("Demo Data").length).toBeGreaterThan(0);
  });

  it("renders signals candidates through the dynamic app route", () => {
    render(
      <MemoryRouter initialEntries={["/signals"]}>
        <App />
      </MemoryRouter>,
    );
    expect(
      screen.getByRole("heading", { name: "Market signals" }),
    ).toBeInTheDocument();
    expect(screen.getAllByText("NVDA").length).toBeGreaterThan(0);
    expect(screen.getByText("Strong Setups")).toBeInTheDocument();
    expect(screen.getAllByText("Watch").length).toBeGreaterThan(0);
    expect(screen.getByText("Relevant Rejections")).toBeInTheDocument();
  });

  it("redirects the legacy scanner route to signals", () => {
    render(
      <MemoryRouter initialEntries={["/scanner"]}>
        <App />
      </MemoryRouter>,
    );
    expect(
      screen.getByRole("heading", { name: "Market signals" }),
    ).toBeInTheDocument();
  });

  it("splits signals into strong, watch and relevant rejections", () => {
    render(
      <MemoryRouter initialEntries={["/signals"]}>
        <App />
      </MemoryRouter>,
    );
    const strongSection = screen
      .getByText("Strong Setups")
      .closest("section");
    expect(strongSection).not.toBeNull();
    expect(strongSection?.textContent).toContain("NVDA");
    expect(strongSection?.textContent).toContain("MSFT");
    const rejectedSection = screen
      .getByText("Relevant Rejections")
      .closest("section");
    expect(rejectedSection?.textContent).toContain("TSLA");
  });

  it("renders the validated market-data snapshot", () => {
    render(
      <MemoryRouter initialEntries={["/market-data"]}>
        <App />
      </MemoryRouter>,
    );
    expect(screen.getByRole("heading", { name: "Market data" })).toBeInTheDocument();
    expect(screen.getByText("SPY and QQQ")).toBeInTheDocument();
    expect(screen.getByText("1,648")).toBeInTheDocument();
    expect(screen.getAllByText("SPY").length).toBeGreaterThan(0);
    expect(screen.getAllByText("QQQ").length).toBeGreaterThan(0);
  });
  it("surfaces degraded market data in public system status", () => {
    const degraded = {
      ...demoData,
      demo: false,
      marketData: {
        ...demoData.marketData,
        status: "offline" as const,
        benchmarks: [],
        lastSuccessfulUpdate: null,
        warnings: ["No validated market-data snapshot has been published."],
      },
    };
    render(
      <DataContext.Provider value={degraded}>
        <MemoryRouter initialEntries={["/status"]}>
          <App />
        </MemoryRouter>
      </DataContext.Provider>,
    );
    expect(screen.getByText("Public data is delayed or degraded")).toBeInTheDocument();
    expect(screen.queryByText("Demo Data")).not.toBeInTheDocument();
    expect(screen.getAllByText("unavailable").length).toBeGreaterThan(0);
    expect(screen.getAllByText("No validated market-data snapshot has been published.").length).toBeGreaterThan(0);
  });

  it("renders the shadow portfolio with $10,000 simulated capital", () => {
    render(
      <MemoryRouter initialEntries={["/portfolio"]}>
        <App />
      </MemoryRouter>,
    );
    expect(
      screen.getByRole("heading", { name: "Shadow Portfolio" }),
    ).toBeInTheDocument();
    expect(screen.getByText("$10,000")).toBeInTheDocument();
    expect(screen.getByText("Simulated")).toBeInTheDocument();
    expect(screen.getByText("+3.07%")).toBeInTheDocument();
  });

  it("labels non-demo data as public operational data", () => {
    render(
      <DataContext.Provider value={{ ...demoData, demo: false }}>
        <MemoryRouter initialEntries={["/signals"]}>
          <App />
        </MemoryRouter>
      </DataContext.Provider>,
    );
    expect(screen.getByText("operational")).toBeInTheDocument();
    expect(screen.queryByText("Demo Data")).not.toBeInTheDocument();
  });

  it("switches earnings calendar tabs and filters", () => {
    render(
      <MemoryRouter initialEntries={["/earnings"]}>
        <App />
      </MemoryRouter>,
    );
    expect(screen.getByText("META")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Tomorrow" }));
    expect(screen.getByText("TSLA")).toBeInTheDocument();
    expect(screen.queryByText("META")).not.toBeInTheDocument();
  });

  it("does not link earnings without a matching stock candidate", () => {
    const orphan = {
      ...demoData.earnings[0]!,
      symbol: "CRM",
      date: "2026-08-11",
    };
    render(
      <DataContext.Provider value={{ ...demoData, candidates: [], earnings: [orphan] }}>
        <MemoryRouter initialEntries={["/earnings"]}>
          <App />
        </MemoryRouter>
      </DataContext.Provider>,
    );
    const card = screen.getByText("CRM").closest(".earning-card");
    expect(card).not.toBeNull();
    expect(card?.tagName).toBe("DIV");
    expect(card?.closest("a")).toBeNull();
  });

  it.each(["/stocks/UNKNOWN", "/strategies/unknown", "/research/unknown"])(
    "does not substitute unrelated data for unknown detail route %s",
    (path) => {
      render(
        <MemoryRouter initialEntries={[path]}>
          <App />
        </MemoryRouter>,
      );
      expect(
        screen.getByRole("heading", { name: "Page not found" }),
      ).toBeInTheDocument();
    },
  );

  it("selects the requested strategy when a symbol has multiple candidates", () => {
    const alternate = {
      ...demoData.candidates[0]!,
      strategyId: "post_earnings_v1",
      strategyVersion: "2.0.0",
      strategy: "Post Earnings",
      status: "Watch" as const,
    };
    render(
      <DataContext.Provider
        value={{
          ...demoData,
          candidates: [demoData.candidates[0]!, alternate],
        }}
      >
        <MemoryRouter
          initialEntries={["/stocks/NVDA?strategy=post_earnings_v1"]}
        >
          <App />
        </MemoryRouter>
      </DataContext.Provider>,
    );
    expect(screen.getByText("Version 2.0.0 · Watch")).toBeInTheDocument();
  });

  it("polls public data conservatively and clears the timer on unmount", () => {
    const interval = vi.spyOn(window, "setInterval");
    const clear = vi.spyOn(window, "clearInterval");
    const view = render(
      <DataProvider>
        <div>child</div>
      </DataProvider>,
    );
    expect(interval).toHaveBeenCalledWith(
      expect.any(Function),
      POLL_INTERVAL_MS,
    );
    view.unmount();
    expect(clear).toHaveBeenCalled();
    interval.mockRestore();
    clear.mockRestore();
  });

  it.each([
    "Research",
    "Validation",
    "Out-of-Sample",
    "Shadow",
    "Live",
  ] as const)("marks %s as the current strategy lifecycle stage", (state) => {
    const strategy = { ...demoData.strategies[0]!, state };
    const view = render(
      <DataContext.Provider value={{ ...demoData, strategies: [strategy] }}>
        <MemoryRouter initialEntries={[`/strategies/${strategy.id}`]}>
          <App />
        </MemoryRouter>
      </DataContext.Provider>,
    );
    expect(
      view.container.querySelector(".lifecycle .active")?.textContent,
    ).toBe(state);
  });
});
