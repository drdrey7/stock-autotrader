import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider, ThemeToggle } from "../../shell/theme";
import { StockHeatmap } from "./StockHeatmap";

beforeEach(() => {
  localStorage.clear();
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
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderHeatmap() {
  return render(
    <ThemeProvider>
      <ThemeToggle />
      <StockHeatmap />
    </ThemeProvider>,
  );
}

function heatmapConfig() {
  const script = document.querySelector("script[data-tv-stock-heatmap='true']");
  return JSON.parse(script?.textContent ?? "{}");
}

describe("StockHeatmap", () => {
  it("uses the official clean S&P 500 heatmap configuration", async () => {
    renderHeatmap();
    await waitFor(() => expect(document.querySelector("script[data-tv-stock-heatmap='true']")).not.toBeNull());

    expect(heatmapConfig()).toMatchObject({
      dataSource: "SPX500",
      blockSize: "market_cap_basic",
      blockColor: "change",
      grouping: "sector",
      colorTheme: "dark",
      hasTopBar: false,
      isDataSetEnabled: false,
      isZoomEnabled: true,
      hasSymbolTooltip: true,
      isMonoSize: false,
      width: "100%",
      height: "100%",
    });
    expect(screen.getByRole("link", { name: "Stock Heatmap" })).toHaveAttribute(
      "href",
      "https://www.tradingview.com/heatmap/stock/",
    );
  });

  it("changes performance and sizing from the visible controls", async () => {
    renderHeatmap();
    await waitFor(() => expect(heatmapConfig().blockColor).toBe("change"));

    fireEvent.click(screen.getByRole("button", { name: "Switch to YTD performance" }));
    await waitFor(() => expect(heatmapConfig().blockColor).toBe("Perf.YTD"));
    expect(screen.getByRole("button", { name: "Switch to 1D performance" })).toHaveTextContent("YTD performance");

    fireEvent.click(screen.getByRole("button", { name: "Switch to equal-size tiles" }));
    await waitFor(() => expect(heatmapConfig().isMonoSize).toBe(true));
    expect(screen.getByRole("button", { name: "Switch to market-cap sizing" })).toHaveTextContent("Equal size");
  });

  it("offers an explicit touch interaction mode without trapping page scroll by default", () => {
    renderHeatmap();
    const root = document.querySelector(".tv-stock-heatmap")!;
    const toggle = screen.getByRole("button", { name: "Enable heatmap interaction" });

    expect(root).not.toHaveClass("is-touch-interactive");
    expect(toggle).toHaveTextContent("Interact");

    fireEvent.click(toggle);
    expect(root).toHaveClass("is-touch-interactive");
    expect(screen.getByRole("button", { name: "Disable heatmap interaction" })).toHaveTextContent("Done");
  });

  it("rebuilds the iframe widget with the active shell theme", async () => {
    renderHeatmap();
    await waitFor(() => expect(heatmapConfig().colorTheme).toBe("dark"));

    fireEvent.click(screen.getByRole("button", { name: "Switch to light mode" }));

    await waitFor(() => expect(heatmapConfig().colorTheme).toBe("light"));
    expect(document.querySelectorAll("script[data-tv-stock-heatmap='true']")).toHaveLength(1);
  });
});
