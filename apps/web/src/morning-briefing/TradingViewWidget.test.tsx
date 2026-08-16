import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TradingViewWidget, type TradingViewWidgetType } from "./TradingViewWidget";
import { ThemeProvider, ThemeToggle } from "../shell/theme";

const TICKER_SETTINGS = { symbols: [{ proName: "SP:SPX", title: "S&P 500" }], locale: "en" };

const renderWidget = (type: TradingViewWidgetType = "ticker-tape", lazy = false) => render(
  <ThemeProvider><ThemeToggle /><TradingViewWidget type={type} settings={TICKER_SETTINGS} lazy={lazy}/></ThemeProvider>,
);

beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(window, "matchMedia", { configurable: true, value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })) });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("injects exactly one bootstrap script and the required attribution", () => {
  renderWidget("ticker-tape");
  const scripts = document.querySelectorAll("script[data-tv-widget]");
  expect(scripts).toHaveLength(1);
  expect(scripts[0]).toHaveAttribute("src", "https://s3.tradingview.com/external-embedding/embed-widget-ticker-tape.js");
  expect(document.querySelector(".tradingview-widget-container__widget")).not.toBeNull();
  const copyright = document.querySelector(".tradingview-widget-copyright");
  expect(copyright).not.toBeNull();
  expect(copyright!.textContent).toContain("TradingView");
});

it("uses the official embed script per widget type", () => {
  const expected: Record<TradingViewWidgetType, string> = {
    "ticker-tape": "embed-widget-ticker-tape.js",
    "market-overview": "embed-widget-market-overview.js",
    events: "embed-widget-events.js",
    timeline: "embed-widget-timeline.js",
  };
  for (const type of Object.keys(expected) as TradingViewWidgetType[]) {
    const view = renderWidget(type);
    const script = document.querySelector(`script[data-tv-widget="${type}"]`);
    expect(script).toHaveAttribute("src", `https://s3.tradingview.com/external-embedding/${expected[type]}`);
    view.unmount();
  }
});

it("renders a restrained fallback when the widget script fails to load", async () => {
  renderWidget();
  expect(screen.getByRole("status")).toHaveTextContent("Loading market data…");
  document.querySelector("script[data-tv-widget]")!.dispatchEvent(new Event("error"));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Market widget temporarily unavailable"));
  // No fabricated figures are ever substituted for the failed widget.
  expect(screen.queryByText("S&P 500")).not.toBeInTheDocument();
});

it("fails closed if the widget iframe never renders", async () => {
  vi.useFakeTimers();
  renderWidget();
  // The widget times out to the fallback when no iframe appears; the advance
  // must run inside act so the resulting state update flushes to the DOM.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(21_000);
  });
  expect(screen.getByRole("alert")).toHaveTextContent("Market widget temporarily unavailable");
});

it("remounts the widget script when the app theme changes", async () => {
  renderWidget();
  const script = () => document.querySelector("script[data-tv-widget='ticker-tape']");
  await waitFor(() => expect(script()!.textContent).toContain('"colorTheme":"light"'));
  expect(document.querySelector(".tv-widget-container")).toHaveAttribute("data-theme", "light");

  fireEvent.click(screen.getByRole("button", { name: "Switch to dark mode" }));
  await waitFor(() => expect(script()!.textContent).toContain('"colorTheme":"dark"'));
  expect(document.querySelector(".tv-widget-container")).toHaveAttribute("data-theme", "dark");
  // Exactly one script stays in the DOM after the remount — no duplicates.
  expect(document.querySelectorAll("script[data-tv-widget='ticker-tape']")).toHaveLength(1);
});

it("still loads lazy widgets when IntersectionObserver is unavailable", () => {
  renderWidget("events", true);
  expect(document.querySelector("script[data-tv-widget='events']")).not.toBeNull();
});
