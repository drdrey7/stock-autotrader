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
      colorTheme: "light",
      hasTopBar: false,
      isDataSetEnabled: false,
      isZoomEnabled: true,
      hasSymbolTooltip: true,
      width: "100%",
      height: "100%",
    });
    expect(screen.getByRole("link", { name: "Stock Heatmap" })).toHaveAttribute(
      "href",
      "https://www.tradingview.com/heatmap/stock/",
    );
  });

  it("rebuilds the iframe widget with the active shell theme", async () => {
    renderHeatmap();
    await waitFor(() => expect(heatmapConfig().colorTheme).toBe("light"));

    fireEvent.click(screen.getByRole("button", { name: "Switch to dark mode" }));

    await waitFor(() => expect(heatmapConfig().colorTheme).toBe("dark"));
    expect(document.querySelectorAll("script[data-tv-stock-heatmap='true']")).toHaveLength(1);
  });
});
