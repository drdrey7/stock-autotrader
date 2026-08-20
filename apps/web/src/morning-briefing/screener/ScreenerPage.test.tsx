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
});

const makeResponse = (rows: ScreenerRow[]): ScreenerApiResponse => {
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
    marketState: "regular",
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

  it("filters gainers and losers", async () => {
    render(<ScreenerPage />);
    await screen.findByRole("table");
    fireEvent.click(screen.getByRole("tab", { name: "Gainers" }));
    await waitFor(() => expect(screen.queryByText("S01")).not.toBeInTheDocument());
    expect(screen.getByText("S00")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Losers" }));
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

  it("labels Cached rows neutrally — never 'Market closed' during the open grace", async () => {
    const cached: ScreenerRow = row("ZZZ", 100, null, "Cached");
    fetchMock.mockImplementation(async () =>
      new Response(JSON.stringify(makeResponse([cached])), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    render(<ScreenerPage />);
    // "Cached" appears in the row status cell (and possibly the summary chip).
    expect(await screen.findAllByText("Cached")).toHaveLength(2);
    expect(screen.queryByText("Market closed")).not.toBeInTheDocument();
  });

  it("renders a pre-PR2 production payload (SMA fields OMITTED) — '—' placeholders, no crash", async () => {
    // Cloudflare PR preview proxies /api/* to the PRODUCTION worker, which
    // returns the OLD shape: rows have NO sma200w/distanceToSma200wPct/
    // sma200wState/sma200wHistoryWeeks/sma200wAsOf. Never .toFixed(undefined).
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
    await waitFor(() => expect(screen.getAllByRole("row")).toHaveLength(51)); // header + 50
    // SMA cells degrade to the em-dash placeholder; no "Page unavailable".
    expect(screen.queryByText(/Page unavailable/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/temporarily unavailable/i)).not.toBeInTheDocument();
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(100); // 2 SMA cols x 50 rows
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
    // 4 dash cells for the S1-S4 columns
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(4);
  });
});