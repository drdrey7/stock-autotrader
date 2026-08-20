import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ScreenerApiResponse, ScreenerRow } from "@stock-autotrader/contracts";
import { useScreener } from "./useScreener";

const row = (symbol: string): ScreenerRow => ({
  symbol,
  company: `${symbol} Co`,
  price: 100,
  changeAbs: 1,
  changePct: 1,
  dayHigh: null,
  dayLow: null,
  dayOpen: null,
  previousClose: null,
  provider: "finnhub-quote",
  asOf: "2026-08-13T14:00:00.000Z",
  updatedAt: "2026-08-13T14:00:00.000Z",
  state: "Live",
  sma200w: null,
  distanceToSma200wPct: null,
  sma200wState: "Unavailable",
  sma200wHistoryWeeks: null,
  sma200wAsOf: null,
  supportLevels: [],
});

const response = (): ScreenerApiResponse => ({
  universe: { version: 1, total: 1 },
  marketState: "regular",
  quotes: {
    state: "Live",
    provider: "finnhub-quote",
    lastSuccessAt: "2026-08-13T14:00:00.000Z",
    lastAttemptAt: "2026-08-13T14:00:00.000Z",
    error: null,
    counts: { total: 1, live: 1, cached: 0, stale: 0, unavailable: 0 },
  },
  rows: [row("S00")],
  asOf: "2026-08-13T14:00:00.000Z",
});

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("useScreener", () => {
  it("loads /api/screener once and exposes the resolved data", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(response()), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const { result } = renderHook(() => useScreener(60_000));
    expect(result.current.loading).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBe(false);
    expect(result.current.data?.universe.total).toBe(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/screener", expect.anything());
  });

  it("reports error when the API fails on the initial load", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 503 }));
    const { result } = renderHook(() => useScreener(60_000));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(result.current.error).toBe(true);
    expect(result.current.data).toBeNull();
  });

  it("retains the last known data across a failed background refresh", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let calls = 0;
    fetchMock.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify(response()), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(null, { status: 503 });
    });
    const { result } = renderHook(() => useScreener(60_000));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(result.current.error).toBe(false);
    expect(result.current.data?.rows).toHaveLength(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(result.current.error).toBe(true);
    // Last known rows remain serviceable — never a silent empty/stale read.
    expect(result.current.data?.rows).toHaveLength(1);
  });

  it("refreshes on the configured interval", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fetchMock.mockResolvedValue(new Response(JSON.stringify(response()), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    renderHook(() => useScreener(30_000));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const afterFirst = fetchMock.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(fetchMock.mock.calls.length).toBe(afterFirst + 1);
  });
});
