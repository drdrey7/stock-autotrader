import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { ScreenerApiResponse, ScreenerRow } from "@stock-autotrader/contracts";
import ScreenerPage from "./ScreenerPage";

const row = (symbol: string, price: number | null, changePct: number | null, state: ScreenerRow["state"], supportLevels: ScreenerRow["supportLevels"] = []): ScreenerRow => ({
  symbol,
  company: `${symbol} Co`,
  price,
  changeAbs: changePct === null ? null : changePct,
  changePct,
  dayHigh: null,
  dayLow: null,
  dayOpen: null,
  previousClose: null,
  provider: "finnhub-quote",
  asOf: "2026-08-13T14:00:00.000Z",
  updatedAt: "2026-08-13T14:00:00.000Z",
  state,
  sma200w: null,
  distanceToSma200wPct: null,
  sma200wState: "Unavailable",
  sma200wHistoryWeeks: null,
  sma200wAsOf: null,
  supportLevels,
  intrinsicValue: null,
  logoUrl: null,
});

const makeResponse = (rows: ScreenerRow[], marketState = "regular"): ScreenerApiResponse => {
  const counts = rows.reduce(
    (acc, item) => {
      if (item.state === "Live") acc.live += 1;
      else if (item.state === "Cached") acc.cached += 1;
      else if (item.state === "Unavailable") acc.unavailable += 1;
      else acc.stale += 1;
      return acc;
    },
    { total: rows.length, live: 0, cached: 0, stale: 0, unavailable: 0 },
  );
  return {
    universe: { version: 1, total: 50 },
    marketState: marketState as ScreenerApiResponse["marketState"],
    quotes: {
      state: counts.stale === 0 && counts.live > 0 ? "Live" : counts.stale === 0 ? "Cached" : "Stale",
      provider: "finnhub-quote",
      lastSuccessAt: "2026-08-13T14:00:00.000Z",
      lastAttemptAt: "2026-08-13T14:00:00.000Z",
      error: null,
      counts,
    },
    rows,
    asOf: "2026-08-13T14:00:00.000Z",
  };
};

const rows50 = (): ScreenerRow[] =>
  Array.from({ length: 50 }, (_, index) =>
    row(
      `S${String(index).padStart(2, "0")}`,
      100 + index,
      index % 2 === 0 ? 1 + index : -(1 + index),
      "Live",
    ));

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    if (String(input) === "/api/screener") {
      return new Response(JSON.stringify(makeResponse(rows50())), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("{}", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ScreenerPage", () => {
  it("renders the heading and all 50 rows once /api/screener resolves", async () => {
    render(<ScreenerPage />);
    expect(screen.getByRole("heading", { name: "Screener" })).toBeInTheDocument();
    expect(await screen.findByRole("table")).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByRole("row")).toHaveLength(51)); // header + 50
    expect(screen.getByText("S00")).toBeInTheDocument();
    expect(screen.getByText("S49")).toBeInTheDocument();
  });

  it("only fetches our API, never a Finnhub URL", async () => {
    render(<ScreenerPage />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const urls = fetchMock.mock.calls.map(([input]) => String(input));
    expect(urls.every((url) => url.startsWith("/api/"))).toBe(true);
    expect(urls.some((url) => url.includes("finnhub") || url.includes("ws://") || url.includes("wss://"))).toBe(false);
  });

  it("searches by ticker or company", async () => {
    render(<ScreenerPage />);
    await screen.findByRole("table");
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "S42" } });
    expect(screen.queryByText("S00")).not.toBeInTheDocument();
    expect(screen.getByText("S42")).toBeInTheDocument();
  });

  it("filters gainers and losers via Filters menu", async () => {
    render(<ScreenerPage />);
    await screen.findByRole("table");
    // Open filters menu
    fireEvent.click(screen.getByRole("button", { name: /Filters/i }));
    // Click Gainers
    fireEvent.click(screen.getByRole("menuitem", { name: "Gainers" }));
    await waitFor(() => expect(screen.queryByText("S01")).not.toBeInTheDocument());
    expect(screen.getByText("S00")).toBeInTheDocument();
    // Open filters menu again
    fireEvent.click(screen.getByRole("button", { name: /Filters/i }));
    // Click Losers
    fireEvent.click(screen.getByRole("menuitem", { name: "Losers" }));
    await waitFor(() => expect(screen.queryByText("S00")).not.toBeInTheDocument());
    expect(screen.getByText("S01")).toBeInTheDocument();
  });

  it("shows an honest empty state when there are no matching rows", async () => {
    render(<ScreenerPage />);
    await screen.findByRole("table");
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "ZZZ" } });
    expect(screen.getByText("No matching stocks.")).toBeInTheDocument();
  });

  it("renders loading, then an error state distinct from data on initial fetch failure", async () => {
    fetchMock.mockImplementation(async () => new Response(null, { status: 503 }));
    render(<ScreenerPage />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading quotes");
    expect(await screen.findByRole("alert")).toHaveTextContent(/temporarily unavailable/i);
  });

  it("renders a pre-PR2 production payload (SMA fields OMITTED) — '—' placeholders, no crash", async () => {
    const omit = (keys: string[], raw: Record<string, unknown>) => {
      const copy = { ...raw };
      for (const key of keys) delete copy[key];
      return copy;
    };
    const oldPayload = rows50().map((r) =>
      omit(
        ["sma200w", "distanceToSma200wPct", "sma200wState", "sma200wHistoryWeeks", "sma200wAsOf", "supportLevels"],
        r as unknown as Record<string, unknown>,
      ));
    fetchMock.mockImplementation(async () =>
      new Response(JSON.stringify({ ...makeResponse([]), rows: oldPayload }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    render(<ScreenerPage />);
    await screen.findByRole("table");
    await waitFor(() => expect(screen.getAllByRole("row")).toHaveLength(51));
    expect(screen.queryByText(/Page unavailable/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/temporarily unavailable/i)).not.toBeInTheDocument();
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(100);
  });

  it("renders S1-S4 columns headers and triggered pills", async () => {
    const metaRow = row("META", 500, 1.5, "Live", [
      { level: 1, price: 635, method: "manual", asOf: "2026-08-03", triggered: true },
      { level: 2, price: 580, method: "manual", asOf: "2026-08-03", triggered: true },
      { level: 3, price: 532, method: "manual", asOf: "2026-08-03", triggered: true },
      { level: 4, price: 481, method: "manual", asOf: "2026-08-03", triggered: false },
    ]);
    fetchMock.mockImplementation(async () =>
      new Response(JSON.stringify(makeResponse([metaRow])), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    render(<ScreenerPage />);
    await screen.findByRole("table");
    // Headers
    expect(screen.getByText("S1")).toBeInTheDocument();
    expect(screen.getByText("S2")).toBeInTheDocument();
    expect(screen.getByText("S3")).toBeInTheDocument();
    expect(screen.getByText("S4")).toBeInTheDocument();
    // 3 green pills
    const pills = document.querySelectorAll(".scr-support-pill");
    expect(pills.length).toBe(3);
    expect(screen.getByText("635")).toBeInTheDocument();
    expect(screen.getByText("580")).toBeInTheDocument();
    expect(screen.getByText("532")).toBeInTheDocument();
    expect(screen.getByText("481")).toBeInTheDocument();
  });

  it("renders '—' for stocks without support levels", async () => {
    const noSupport = row("XYZ", 100, 1.0, "Live");
    fetchMock.mockImplementation(async () =>
      new Response(JSON.stringify(makeResponse([noSupport])), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    render(<ScreenerPage />);
    await screen.findByRole("table");
    expect(screen.getByText("XYZ")).toBeInTheDocument();
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(4);
  });

  it("renders IV and IV Dist columns with correct values", async () => {
    const ivRow = row("AAPL", 200, -1.5, "Live", []);
    ivRow.intrinsicValue = {
      low: null,
      base: 251.12,
      high: null,
      method: "manual",
      asOf: "2026-08-03",
      distancePct: (200 / 251.12 - 1) * 100,
    };
    fetchMock.mockImplementation(async () =>
      new Response(JSON.stringify(makeResponse([ivRow])), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    render(<ScreenerPage />);
    await screen.findByRole("table");
    expect(screen.getByText("IV")).toBeInTheDocument();
    expect(screen.getByText("IV Dist")).toBeInTheDocument();
    expect(screen.getByText("251.12")).toBeInTheDocument();
    const ivDistCell = document.querySelector(".scr-up");
    expect(ivDistCell).not.toBeNull();
    expect(ivDistCell!.textContent).toContain("-20");
  });

  it("renders IV Dist positive value (red)", async () => {
    const ivRow = row("AAPL", 300, 2.0, "Live", []);
    ivRow.intrinsicValue = {
      low: null,
      base: 251.12,
      high: null,
      method: "manual",
      asOf: "2026-08-03",
      distancePct: (300 / 251.12 - 1) * 100,
    };
    fetchMock.mockImplementation(async () =>
      new Response(JSON.stringify(makeResponse([ivRow])), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    render(<ScreenerPage />);
    await screen.findByRole("table");
    const ivDistCell = document.querySelector(".scr-down");
    expect(ivDistCell).not.toBeNull();
    expect(ivDistCell!.textContent).toContain("+19");
  });

  it("renders IV Dist zero (neutral)", async () => {
    const ivRow = row("AAPL", 251.12, 0.0, "Live", []);
    ivRow.intrinsicValue = {
      low: null,
      base: 251.12,
      high: null,
      method: "manual",
      asOf: "2026-08-03",
      distancePct: 0,
    };
    fetchMock.mockImplementation(async () =>
      new Response(JSON.stringify(makeResponse([ivRow])), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    render(<ScreenerPage />);
    await screen.findByRole("table");
    const cells = document.querySelectorAll("td");
    const zeroCell = Array.from(cells).find(
      (c) => c.textContent === "0.00%" && c.classList.contains("scr-align-right"),
    );
    expect(zeroCell).not.toBeNull();
    expect(zeroCell!.textContent).toBe("0.00%");
  });

  it("renders IV Dist = '—' when no price", async () => {
    const ivRow = row("AAPL", null, null, "Unavailable", []);
    ivRow.intrinsicValue = {
      low: null,
      base: 251.12,
      high: null,
      method: "manual",
      asOf: "2026-08-03",
      distancePct: null,
    };
    fetchMock.mockImplementation(async () =>
      new Response(JSON.stringify(makeResponse([ivRow])), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    render(<ScreenerPage />);
    await screen.findByRole("table");
    expect(screen.getByText("251.12")).toBeInTheDocument();
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(1);
  });

  it("renders IV = '—' when no intrinsic value", async () => {
    const noIV = row("MSFT", 400, 1.0, "Live", []);
    fetchMock.mockImplementation(async () =>
      new Response(JSON.stringify(makeResponse([noIV])), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    render(<ScreenerPage />);
    await screen.findByRole("table");
    expect(screen.getByText("MSFT")).toBeInTheDocument();
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(2);
  });

  it("renders Market Open badge when marketState is regular", async () => {
    render(<ScreenerPage />);
    await screen.findByRole("table");
    expect(screen.getByText("Market Open")).toBeInTheDocument();
  });

  it("renders Market Closed badge when marketState is closed", async () => {
    fetchMock.mockImplementation(async () =>
      new Response(JSON.stringify(makeResponse([row("A", 100, 1, "Live")], "closed")), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    render(<ScreenerPage />);
    await screen.findByRole("table");
    expect(screen.getByText("Market Closed")).toBeInTheDocument();
  });

  it("does not render old summary chips (Fresh, Stale, etc.)", async () => {
    render(<ScreenerPage />);
    await screen.findByRole("table");
    expect(screen.queryByText(/Fresh/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Stale/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Cached/i)).not.toBeInTheDocument();
  });

  it("does not render old sort preset select", async () => {
    render(<ScreenerPage />);
    await screen.findByRole("table");
    expect(screen.queryByLabelText(/SMA sort preset/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Closest to 200W/i)).not.toBeInTheDocument();
  });

  it("renders exactly 11 columns in correct order", async () => {
    render(<ScreenerPage />);
    await screen.findByRole("table");
    const headers = screen.getAllByRole("columnheader").map((h) => h.textContent?.replace(/[↑↓]/g, "").trim());
    expect(headers).toEqual([
      "Company", "Price", "1D", "IV", "IV Dist", "200W SMA", "SMA Dist", "S1", "S2", "S3", "S4",
    ]);
  });

  it("does not render Chg $ or Status columns", async () => {
    render(<ScreenerPage />);
    await screen.findByRole("table");
    const headers = screen.getAllByRole("columnheader").map((h) => h.textContent?.trim());
    expect(headers).not.toContain("Chg $");
    expect(headers).not.toContain("Status");
    expect(headers).not.toContain("Chg %");
    expect(headers).not.toContain("Dist");
  });

  it("S1-S4 headers are not sortable (no button)", async () => {
    render(<ScreenerPage />);
    await screen.findByRole("table");
    const s1 = screen.getByText("S1").closest("th");
    expect(s1?.querySelector("button")).toBeNull();
    const s4 = screen.getByText("S4").closest("th");
    expect(s4?.querySelector("button")).toBeNull();
  });

  it("Company header is sortable", async () => {
    render(<ScreenerPage />);
    await screen.findByRole("table");
    const companyHeader = screen.getByText("Company").closest("th");
    expect(companyHeader?.querySelector("button")).not.toBeNull();
  });
});
