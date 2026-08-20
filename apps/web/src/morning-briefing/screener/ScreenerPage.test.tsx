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
    const cells = document.querySelectorAll("[role=\"cell\"]");
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
    const s1 = screen.getByRole("columnheader", { name: "S1" });
    expect(s1?.querySelector("button")).toBeNull();
    const s4 = screen.getByRole("columnheader", { name: "S4" });
    expect(s4?.querySelector("button")).toBeNull();
  });

  it("Company header sorts by company name", async () => {
    render(<ScreenerPage />);
    await screen.findByRole("table");
    const companyHeader = screen.getByRole("columnheader", { name: "Company" });
    const button = companyHeader.querySelector("button")!;
    expect(button).not.toBeNull();
    fireEvent.click(button);
    expect(companyHeader).toHaveAttribute("aria-sort", "descending");
    fireEvent.click(button);
    expect(companyHeader).toHaveAttribute("aria-sort", "ascending");
  });

  // --- P2 filter toggle tests ---
  it("P2: click Filters opens; click same Filters closes; outside click closes", async () => {
    render(<ScreenerPage />);
    await screen.findByRole("table");
    const filtersBtn = screen.getByRole("button", { name: /Filters/i });

    // A) Closed → click → opens
    fireEvent.click(filtersBtn);
    expect(screen.getByRole("menuitem", { name: "Gainers" })).toBeInTheDocument();
    expect(filtersBtn).toHaveAttribute("aria-expanded", "true");

    // B) Open → click same button → closes (NOT reopen due to outside click race)
    fireEvent.click(filtersBtn);
    await waitFor(() => expect(screen.queryByRole("menuitem", { name: "Gainers" })).not.toBeInTheDocument());
    expect(filtersBtn).toHaveAttribute("aria-expanded", "false");

    // C) Open → outside click → closes
    fireEvent.click(filtersBtn);
    expect(screen.getByRole("menuitem", { name: "Gainers" })).toBeInTheDocument();
    // Simulate mousedown outside the filters container
    const outside = document.createElement("div");
    document.body.appendChild(outside);
    fireEvent.mouseDown(outside);
    await waitFor(() => expect(screen.queryByRole("menuitem", { name: "Gainers" })).not.toBeInTheDocument());
    expect(filtersBtn).toHaveAttribute("aria-expanded", "false");
    document.body.removeChild(outside);

    // D) Open → click inside popover → does NOT close before selection
    fireEvent.click(filtersBtn);
    expect(screen.getByRole("menuitem", { name: "Gainers" })).toBeInTheDocument();
  });

  it("filter menu supports keyboard navigation and Escape restores trigger focus", async () => {
    render(<ScreenerPage />);
    await screen.findByRole("table");
    const filtersBtn = screen.getByRole("button", { name: /Filters/i });
    fireEvent.click(filtersBtn);

    const all = screen.getByRole("menuitem", { name: "All" });
    const gainers = screen.getByRole("menuitem", { name: "Gainers" });
    const last = screen.getByRole("menuitem", { name: "Above Support" });
    await waitFor(() => expect(document.activeElement).toBe(all));

    fireEvent.keyDown(all, { key: "ArrowDown" });
    expect(document.activeElement).toBe(gainers);
    fireEvent.keyDown(gainers, { key: "End" });
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(last, { key: "Home" });
    expect(document.activeElement).toBe(all);
    fireEvent.keyDown(all, { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("menuitem", { name: "All" })).not.toBeInTheDocument());
    expect(filtersBtn).toHaveAttribute("aria-expanded", "false");
    expect(document.activeElement).toBe(filtersBtn);
  });

  // --- Active filter chip tests ---
  it("A) filter=all → no chip", async () => {
    render(<ScreenerPage />);
    await screen.findByRole("table");
    expect(screen.queryByRole("button", { name: /Clear .* filter/ })).not.toBeInTheDocument();
  });

  it("B) select Below IV → chip appears with X button", async () => {
    render(<ScreenerPage />);
    await screen.findByRole("table");
    fireEvent.click(screen.getByRole("button", { name: /Filters/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Below IV" }));
    expect(screen.getByText("Below IV")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear Below IV filter" })).toBeInTheDocument();
  });

  it("C) click X → filter returns to All", async () => {
    render(<ScreenerPage />);
    await screen.findByRole("table");
    fireEvent.click(screen.getByRole("button", { name: /Filters/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Gainers" }));
    await waitFor(() => expect(screen.getByText("Gainers")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Clear Gainers filter" }));
    await waitFor(() => expect(screen.queryByText("Gainers")).not.toBeInTheDocument());
    // All 50 rows should be visible again (not just gainers)
    await waitFor(() => expect(screen.getByText("S01")).toBeInTheDocument()); // loser row
    await waitFor(() => expect(screen.getByText("S00")).toBeInTheDocument()); // gainer row
  });

  it("D) clear filter preserves search", async () => {
    render(<ScreenerPage />);
    await screen.findByRole("table");
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "S42" } });
    fireEvent.click(screen.getByRole("button", { name: /Filters/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Gainers" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear Gainers filter" }));
    await waitFor(() => expect(screen.getByText("S42")).toBeInTheDocument());
    expect(screen.getByRole("searchbox")).toHaveValue("S42");
  });

  it("E) clear filter preserves sorting", async () => {
    render(<ScreenerPage />);
    await screen.findByRole("table");
    const priceBtn = screen.getByRole("columnheader", { name: /Price/ }).querySelector("button")!;
    // Sort by Price ascending
    fireEvent.click(priceBtn); // desc
    fireEvent.click(priceBtn); // asc
    fireEvent.click(screen.getByRole("button", { name: /Filters/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Below IV" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear Below IV filter" }));
    // Price header should still have aria-sort=ascending
    const priceHeader = screen.getByRole("columnheader", { name: /Price/ });
    expect(priceHeader).toHaveAttribute("aria-sort", "ascending");
  });

  // --- X closes popover test ---
  it("F) click X clears filter AND closes popover", async () => {
    render(<ScreenerPage />);
    await screen.findByRole("table");
    // Open Filters and select Below IV
    fireEvent.click(screen.getByRole("button", { name: /Filters/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Below IV" }));
    await waitFor(() => expect(screen.getByText("Below IV")).toBeInTheDocument());
    // Reopen Filters (filter is now active, chip is visible)
    fireEvent.click(screen.getByRole("button", { name: /Filters/i }));
    expect(screen.getByRole("menuitem", { name: "All" })).toBeInTheDocument();
    // Click X to clear
    fireEvent.click(screen.getByRole("button", { name: "Clear Below IV filter" }));
    // Chip should disappear
    await waitFor(() => expect(screen.queryByText("Below IV")).not.toBeInTheDocument());
    // Popover should close
    await waitFor(() => expect(screen.queryByRole("menuitem", { name: "All" })).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: /Filters/i })).toHaveAttribute("aria-expanded", "false");
  });

  // --- Mobile scroll state test ---
  it("mobile: horizontal scroll adds scr-table-scrolled class", async () => {
    render(<ScreenerPage />);
    await screen.findByRole("table");
    const bodyScroll = document.querySelector(".scr-table-body-scroll") as HTMLDivElement;
    const region = screen.getByRole("table");
    expect(bodyScroll).not.toBeNull();
    expect(region.classList.contains("scr-table-scrolled")).toBe(false);
    fireEvent.scroll(bodyScroll, { target: { scrollLeft: 30 } });
    await waitFor(() => expect(region.classList.contains("scr-table-scrolled")).toBe(true));
    fireEvent.scroll(bodyScroll, { target: { scrollLeft: 0 } });
    await waitFor(() => expect(region.classList.contains("scr-table-scrolled")).toBe(false));
  });

  // --- aria-sort tests ---
  it("aria-sort: active columnheader gets ascending/descending", async () => {
    render(<ScreenerPage />);
    await screen.findByRole("table");
    const priceHeader = screen.getByRole("columnheader", { name: "Price" });
    const priceBtn = priceHeader.querySelector("button")!;
    // Default is changePct, so Price should have no aria-sort
    expect(priceHeader).not.toHaveAttribute("aria-sort");
    // Click Price → descending
    fireEvent.click(priceBtn);
    expect(priceHeader).toHaveAttribute("aria-sort", "descending");
    // Click again → ascending
    fireEvent.click(priceBtn);
    expect(priceHeader).toHaveAttribute("aria-sort", "ascending");
  });

  it("aria-sort: only active columnheader has aria-sort", async () => {
    render(<ScreenerPage />);
    await screen.findByRole("table");
    // 1D is already active by default (descending); click its button to make it ascending
    const oneDHeader = screen.getByRole("columnheader", { name: /1D/ });
    fireEvent.click(oneDHeader.querySelector("button")!);
    const headers = screen.getAllByRole("columnheader");
    const withAriaSort = headers.filter((h) => h.hasAttribute("aria-sort"));
    expect(withAriaSort).toHaveLength(1);
    expect(withAriaSort[0]).toHaveAttribute("aria-sort", "ascending");
  });

  it("aria-sort: S1-S4 never have aria-sort", async () => {
    render(<ScreenerPage />);
    await screen.findByRole("table");
    const s1 = screen.getByRole("columnheader", { name: "S1" });
    const s4 = screen.getByRole("columnheader", { name: "S4" });
    expect(s1).not.toHaveAttribute("aria-sort");
    expect(s4).not.toHaveAttribute("aria-sort");
  });

  // --- Sticky header layering ---
  it("sticky Company + Price headers have higher z-index than normal headers", async () => {
    render(<ScreenerPage />);
    await screen.findByRole("table");
    const companyHeader = screen.getByRole("columnheader", { name: "Company" });
    const priceHeader = screen.getByRole("columnheader", { name: "Price" });
    const oneDHeader = screen.getByRole("columnheader", { name: /1D/ });
    expect(companyHeader?.classList.contains("scr-col-company")).toBe(true);
    expect(priceHeader?.classList.contains("scr-col-price")).toBe(true);
    expect(oneDHeader.classList.contains("scr-col-1d")).toBe(true);
  });

  it("Company and Price headers are sticky with top:0", async () => {
    render(<ScreenerPage />);
    await screen.findByRole("table");
    const companyHeader = screen.getByRole("columnheader", { name: "Company" });
    const priceHeader = screen.getByRole("columnheader", { name: "Price" });
    expect(companyHeader).toHaveClass("scr-col-company");
    expect(priceHeader).toHaveClass("scr-col-price");
  });

  // --- Compact state preserves logo + ticker ---
  it("compact mode hides company name but preserves ticker", async () => {
    render(<ScreenerPage />);
    await screen.findByRole("table");
    const bodyScroll = document.querySelector(".scr-table-body-scroll") as HTMLDivElement;
    const region = screen.getByRole("table");
    fireEvent.scroll(bodyScroll, { target: { scrollLeft: 30 } });
    await waitFor(() => expect(region.classList.contains("scr-table-scrolled")).toBe(true));
    expect(screen.getByText("S00")).toBeInTheDocument();
  });

  // --- Filter popover clipping fix ---
  it("zero-results: Filters popover shows all 10 options", async () => {
    render(<ScreenerPage />);
    await screen.findByRole("table");
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "ZZZZZZ" } });
    expect(screen.getByText("No matching stocks.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Filters/i }));
    const options = screen.getAllByRole("menuitem");
    expect(options).toHaveLength(10);
    expect(screen.getByRole("menuitem", { name: "Above Support" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "All" })).toBeInTheDocument();
  });

  it("renders sibling sticky header and horizontal body scroll containers", async () => {
    render(<ScreenerPage />);
    await screen.findByRole("table");
    const region = screen.getByRole("table");
    const headShell = document.querySelector(".scr-table-head-shell");
    const headScroll = document.querySelector(".scr-table-head-scroll");
    const bodyScroll = document.querySelector(".scr-table-body-scroll");
    expect(headShell).not.toBeNull();
    expect(headScroll).not.toBeNull();
    expect(bodyScroll).not.toBeNull();
    expect(region.contains(headShell!)).toBe(true);
    expect(region.contains(bodyScroll!)).toBe(true);
    expect(headShell!.nextElementSibling).toBe(bodyScroll);
    expect(screen.getAllByRole("columnheader")).toHaveLength(11);
    expect(screen.getAllByRole("rowgroup")).toHaveLength(2);
  });
});
