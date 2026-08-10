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

  it("renders scanner candidates through the dynamic app route", () => {
    render(
      <MemoryRouter initialEntries={["/scanner"]}>
        <App />
      </MemoryRouter>,
    );
    expect(
      screen.getByRole("heading", { name: "Market scanner" }),
    ).toBeInTheDocument();
    expect(screen.getAllByText("NVDA").length).toBeGreaterThan(0);
  });

  it("combines scanner signal and minimum-score filters", () => {
    render(
      <MemoryRouter initialEntries={["/scanner"]}>
        <App />
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByLabelText("Signal"), {
      target: { value: "Watch" },
    });
    expect(screen.getAllByText("AMD").length).toBeGreaterThan(0);
    expect(screen.queryByText("NVDA")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Min score"), {
      target: { value: "85" },
    });
    expect(
      screen.getByText("No candidates match these filters"),
    ).toBeInTheDocument();
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
