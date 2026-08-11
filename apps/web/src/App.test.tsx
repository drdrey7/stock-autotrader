import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import App from "./App";
import { exampleDailyBriefing } from "./daily-briefing-example";
import indexHtml from "../index.html?raw";
import cloudflareHeaders from "../public/_headers?raw";

afterEach(cleanup);

it("ships restrictive Cloudflare static-asset headers", () => {
  expect(cloudflareHeaders).toContain("Content-Security-Policy:");
  expect(cloudflareHeaders).toContain("frame-ancestors 'none'");
  expect(cloudflareHeaders).toContain("X-Frame-Options: DENY");
});

it("ships Stock Daily Briefing metadata in the static HTML fallback", () => {
  expect(indexHtml).toContain("<title>Stock Daily Briefing — US market intelligence</title>");
  expect(indexHtml).toContain(
    'content="Twice-daily S&amp;P 500 and Nasdaq-100 market context, curated stock ideas and independent qualification."',
  );
  expect(indexHtml).toContain('name="theme-color" content="#071017"');
  expect(indexHtml).not.toContain("Stock Autotrader");
});

describe("Stock Daily Briefing public experience", () => {
  it("renders a short landing with the approved brand, preview and CTA", () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <App />
      </MemoryRouter>,
    );

    expect(screen.getAllByText("Stock Daily Briefing").length).toBeGreaterThan(0);
    expect(
      screen.getByRole("heading", { name: "The market, distilled. Twice daily." }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: "Stock Daily Briefing terminal preview" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Example Data")).toBeInTheDocument();

    const cta = screen.getByRole("link", { name: "View Live Dashboard" });
    expect(cta).toHaveAttribute("href", "/dashboard");
  });

  it("opens the public terminal from the landing CTA", () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <App />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("link", { name: "View Live Dashboard" }));

    expect(
      screen.getByRole("heading", { name: exampleDailyBriefing.title }),
    ).toBeInTheDocument();
  });

  it("does not expose the legacy product navigation or trading experience", () => {
    const view = render(
      <MemoryRouter initialEntries={["/"]}>
        <App />
      </MemoryRouter>,
    );

    expect(view.container.querySelector(".sidebar, .tabs")).toBeNull();
    expect(screen.queryByText("Stock Autotrader")).not.toBeInTheDocument();
    expect(screen.queryByText("Shadow Portfolio")).not.toBeInTheDocument();
    expect(screen.queryByText("Strategies")).not.toBeInTheDocument();
    expect(screen.queryByText(/log in|sign in/i)).not.toBeInTheDocument();
  });

  it("renders one public dashboard with market, X, analysis and provenance inline", () => {
    const view = render(
      <MemoryRouter initialEntries={["/dashboard"]}>
        <App />
      </MemoryRouter>,
    );

    expect(
      screen.getByText("Example Data", { selector: ".briefing-example-badge" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: exampleDailyBriefing.title })).toBeInTheDocument();
    expect(
      screen.getByText(new RegExp(`^(PRE|POST) / ${exampleDailyBriefing.editionDate}$`)),
    ).toBeInTheDocument();
    expect(screen.getByText("S&P 500")).toBeInTheDocument();
    expect(screen.getByText("Nasdaq-100")).toBeInTheDocument();
    expect(screen.getByText("VIX")).toBeInTheDocument();
    expect(screen.getAllByText("@nolimitgains").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Potential Entry").length).toBeGreaterThan(0);
    expect(screen.getByText("Watch")).toBeInTheDocument();
    expect(screen.getByText("Avoid")).toBeInTheDocument();
    expect(screen.getAllByText("Technical confirmation").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Financial context").length).toBeGreaterThan(0);
    expect(screen.getAllByText("News check").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Risks").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Provenance").length).toBeGreaterThan(0);
    expect(view.container.querySelector(".sidebar, .tabs")).toBeNull();
    expect(screen.queryByText(/log in|sign in/i)).not.toBeInTheDocument();
  });

  it("renders the three dashboard menu views and a mobile drawer toggle", () => {
    const view = render(
      <MemoryRouter initialEntries={["/dashboard"]}>
        <App />
      </MemoryRouter>,
    );

    expect(screen.getByRole("complementary", { name: "Dashboard menu" })).toBeInTheDocument();

    const morningBriefing = screen.getByRole("link", { name: /Morning briefing/ });
    expect(morningBriefing).toHaveAttribute("href", "#briefing-today");
    expect(morningBriefing).toHaveAttribute("aria-current", "page");
    expect(morningBriefing).toHaveTextContent("Today");

    for (const label of ["X search", "Earnings"]) {
      const button = screen.getByRole("button", {
        name: new RegExp(`Coming soon.*${label}`),
      });
      expect(button).toBeDisabled();
      expect(button).toHaveTextContent("Coming soon");
      expect(button).toHaveTextContent(label);
      expect(button).not.toHaveAttribute("href");
    }

    const toggle = screen.getByRole("button", { name: "Open dashboard menu" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-label", "Close dashboard menu");
    expect(toggle).toHaveAttribute("aria-expanded", "true");

    const backdrop = view.container.querySelector<HTMLButtonElement>(
      ".briefing-dashboard-menu-backdrop",
    );
    expect(backdrop).not.toBeNull();
    fireEvent.click(backdrop!);
    expect(toggle).toHaveAttribute("aria-label", "Open dashboard menu");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  it.each([
    "/scanner",
    "/signals",
    "/stocks/NVDA",
    "/strategies",
    "/strategies/trend_breakout_v1",
    "/research",
    "/research/example",
    "/portfolio",
    "/earnings",
    "/market-data",
    "/activity",
    "/x-search",
  ])("redirects legacy route %s to the terminal", (path) => {
    render(
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>,
    );

    expect(
      screen.getByRole("heading", { name: exampleDailyBriefing.title }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Stock Autotrader")).not.toBeInTheDocument();
  });

  it.each([
    ["/methodology", "Methodology"],
    ["/status", "System status"],
    ["/disclaimer", "Disclaimer"],
  ])("keeps the public information route %s", (path, heading) => {
    render(
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>,
    );

    expect(screen.getByRole("heading", { name: heading })).toBeInTheDocument();
    expect(screen.getAllByText("Stock Daily Briefing").length).toBeGreaterThan(0);
  });
});
