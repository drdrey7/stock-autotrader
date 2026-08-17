import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider, ThemeToggle } from "../../shell/theme";
import { EconomicCalendar } from "./EconomicCalendar";
import { TopStories } from "./TopStories";
import { MarketOverview } from "./MarketOverview";
import { TickerTape } from "./TickerTape";
import { MARKET_OVERVIEW_SECTIONS, TICKER_SYMBOLS } from "./tradingview-config";

const renderWithTheme = (node: ReactNode) => render(<ThemeProvider>{node}</ThemeProvider>);

beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("TickerTape (web component)", () => {
  // The final global tape is exactly these seven headline instruments. This is
  // the product contract: it guards against non-essential instruments (ETH,
  // SOL, EUR/USD, …) creeping back into the thin strip above the fold.
  const FINAL_TICKER_SYMBOLS = [
    "FOREXCOM:SPXUSD", // S&P 500
    "FOREXCOM:NSXUSD", // Nasdaq-100
    "FOREXCOM:DJI", // Dow Jones
    "VIX", // Volatility Index
    "BITSTAMP:BTCUSD", // Bitcoin
    "CMCMARKETS:GOLD", // Gold
    "USOIL", // WTI Crude Oil
  ];

  it("mounts a tv-ticker-tape element with the seven verified symbols, a compact size and charts hidden", () => {
    renderWithTheme(<TickerTape symbols={TICKER_SYMBOLS} colorTheme="light" />);
    const el = document.querySelector("tv-ticker-tape");
    expect(el).not.toBeNull();
    expect(el!.getAttribute("symbols")).toBe(TICKER_SYMBOLS.join(","));
    expect(el!.getAttribute("item-size")).toBe("compact");
    expect(el!.getAttribute("theme")).toBe("light");
    expect(el!.hasAttribute("color-theme")).toBe(false);
    // The tape is a clean text strip: the mini sparkline is hidden so each item
    // is a compact quote (name + value + change), not a chart that eats the
    // mobile viewport.
    expect(el!.hasAttribute("hide-chart")).toBe(true);
  });

  it("configures exactly the final seven headline instruments on verified feeds", () => {
    expect(TICKER_SYMBOLS).toEqual(FINAL_TICKER_SYMBOLS);
    // No symbol may regress to a feed that renders blank / "No data here yet"
    // on the public WC datafeed (CME/CBOE futures and TVC:VIX were proven dead).
    expect(TICKER_SYMBOLS).not.toEqual(expect.arrayContaining(["CME_MINI:ES1!", "CME_MINI:NQ1!", "CBOE:VIX", "TVC:VIX"]));
  });

  it("updates the official theme attribute in place when the theme changes — no element remount", () => {
    function Harness() {
      const [theme, setTheme] = useState<"light" | "dark">("light");
      return (
        <>
          <button onClick={() => setTheme((current) => (current === "light" ? "dark" : "light"))}>Toggle</button>
          <TickerTape symbols={TICKER_SYMBOLS} colorTheme={theme} />
        </>
      );
    }
    renderWithTheme(<Harness />);
    const first = document.querySelector("tv-ticker-tape")!;
    expect(first.getAttribute("theme")).toBe("light");

    fireEvent.click(screen.getByRole("button", { name: "Toggle" }));
    const current = document.querySelector("tv-ticker-tape")!;
    expect(current.getAttribute("theme")).toBe("dark");
    // Same node, still exactly one element: theme changes never tear down the tape.
    expect(current).toBe(first);
    expect(document.querySelectorAll("tv-ticker-tape")).toHaveLength(1);
  });

  it("shows a restrained fallback when the TradingView module cannot load", async () => {
    renderWithTheme(<TickerTape symbols={TICKER_SYMBOLS} colorTheme="light" />);
    // jsdom cannot import the cross-origin ES module, so the loader fails and
    // the host surfaces its error state instead of the page crashing/blanking.
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Market tape temporarily unavailable"));
    expect(screen.queryByText(/S&P 500/)).not.toBeInTheDocument();
  });
});

describe("MarketOverview (web component)", () => {
  it("mounts a tv-market-overview element with the JSON sections config", () => {
    renderWithTheme(<MarketOverview sections={MARKET_OVERVIEW_SECTIONS} colorTheme="light" />);
    const el = document.querySelector("tv-market-overview");
    expect(el).not.toBeNull();
    expect(el!.getAttribute("symbol-sectors")).toBe(JSON.stringify(MARKET_OVERVIEW_SECTIONS));
    expect(el!.getAttribute("mode")).toBe("custom");
    expect(el!.getAttribute("time-frame")).toBe("12M");
    expect(el!.getAttribute("theme")).toBe("light");
    expect(el!.hasAttribute("color-theme")).toBe(false);
  });

  it("updates the official theme attribute in place when the theme changes", () => {
    function Harness() {
      const [theme, setTheme] = useState<"light" | "dark">("light");
      return (
        <>
          <button onClick={() => setTheme((current) => (current === "light" ? "dark" : "light"))}>Toggle</button>
          <MarketOverview sections={MARKET_OVERVIEW_SECTIONS} colorTheme={theme} />
        </>
      );
    }

    renderWithTheme(<Harness />);
    const first = document.querySelector("tv-market-overview")!;
    expect(first.getAttribute("theme")).toBe("light");

    fireEvent.click(screen.getByRole("button", { name: "Toggle" }));
    const current = document.querySelector("tv-market-overview")!;
    expect(current.getAttribute("theme")).toBe("dark");
    expect(current).toBe(first);
  });

  it("only contains symbols verified to render on the public datafeed", () => {
    const all = MARKET_OVERVIEW_SECTIONS.flatMap((section) => section.symbols);
    expect(all).not.toEqual(expect.arrayContaining(["CME_MINI:ES1!", "CME_MINI:NQ1!", "CBOE:VIX", "TVC:VIX"]));
    expect(all).toEqual(expect.arrayContaining(["FOREXCOM:SPXUSD", "FOREXCOM:NSXUSD", "FOREXCOM:DJI"]));
  });
});

describe("EconomicCalendar (iframe widget)", () => {
  it("injects the official embed script with the corrected calendar config", () => {
    renderWithTheme(<EconomicCalendar lazy={false} />);
    const script = document.querySelector("script[data-tv-iframe-widget='events']");
    expect(script).not.toBeNull();
    expect(script!.getAttribute("src")).toBe(
      "https://s3.tradingview.com/external-embedding/embed-widget-events.js",
    );
    const config = JSON.parse(script!.textContent ?? "{}") as Record<string, unknown>;
    expect(config.container_id).toBe("tradingview-events");
    // US + Eurozone only (no UK), high importance only — the events that can
    // materially move US or European markets. Lowercase ids, not "US,EU".
    expect(config.countryFilter).toBe("us,eu");
    expect(config.importanceFilter).toBe("1"); // official scale: -1 low, 0 medium, 1 high
    expect(config.currencyFilter).toBeUndefined(); // unsupported key removed
    expect(config.colorTheme).toBe("light");
    expect(config.locale).toBe("en");
  });

  it("shows a restrained fallback when the widget script fails to load", async () => {
    renderWithTheme(<EconomicCalendar lazy={false} />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading market data…");
    document.querySelector("script[data-tv-iframe-widget='events']")!.dispatchEvent(new Event("error"));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Market widget temporarily unavailable"),
    );
    // No fabricated calendar entries are substituted for the failed widget.
    expect(screen.queryByText(/EUR|USD/)).not.toBeInTheDocument();
  });

  it("fails closed if the widget iframe never renders", async () => {
    vi.useFakeTimers();
    renderWithTheme(<EconomicCalendar lazy={false} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(21_000);
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Market widget temporarily unavailable");
  });
});

describe("TopStories (iframe widget)", () => {
  it("injects the official embed script using the all-symbols feed", () => {
    renderWithTheme(<TopStories lazy={false} />);
    const script = document.querySelector("script[data-tv-iframe-widget='timeline']");
    expect(script).not.toBeNull();
    expect(script!.getAttribute("src")).toBe(
      "https://s3.tradingview.com/external-embedding/embed-widget-timeline.js",
    );
    const config = JSON.parse(script!.textContent ?? "{}") as Record<string, unknown>;
    expect(config.container_id).toBe("tradingview-timeline");
    expect(config.feedMode).toBe("all_symbols"); // not market:"stock"
    expect(config.displayMode).toBe("regular");
    expect(config.colorTheme).toBe("light");
  });

  it("still loads lazy widgets when IntersectionObserver is unavailable", () => {
    renderWithTheme(<TopStories lazy />);
    expect(document.querySelector("script[data-tv-iframe-widget='timeline']")).not.toBeNull();
  });
});

describe("theme → iframe widget", () => {
  it("re-injects the widget script with the new colorTheme when the theme changes", async () => {
    renderWithTheme(
      <>
        <ThemeToggle />
        <TopStories lazy={false} />
      </>,
    );
    const script = () => document.querySelector("script[data-tv-iframe-widget='timeline']");
    await waitFor(() => expect(JSON.parse(script()!.textContent ?? "{}").colorTheme).toBe("light"));

    fireEvent.click(screen.getByRole("button", { name: "Switch to dark mode" }));
    await waitFor(() => expect(JSON.parse(script()!.textContent ?? "{}").colorTheme).toBe("dark"));
    // Exactly one script stays in the DOM after the remount — no duplicates.
    expect(document.querySelectorAll("script[data-tv-iframe-widget='timeline']")).toHaveLength(1);
  });

  it("keeps the economic calendar synchronized with the shell theme", async () => {
    renderWithTheme(
      <>
        <ThemeToggle />
        <EconomicCalendar lazy={false} />
      </>,
    );
    const script = () => document.querySelector("script[data-tv-iframe-widget='events']");
    await waitFor(() => expect(JSON.parse(script()!.textContent ?? "{}").colorTheme).toBe("light"));

    fireEvent.click(screen.getByRole("button", { name: "Switch to dark mode" }));
    await waitFor(() => expect(JSON.parse(script()!.textContent ?? "{}").colorTheme).toBe("dark"));
    expect(document.querySelectorAll("script[data-tv-iframe-widget='events']")).toHaveLength(1);
  });
});
