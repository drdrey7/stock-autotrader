import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearEarningsMonthCache, useEarningsMonth } from "./useEarnings";

function event(symbol: string, scheduledDate: string) {
  return {
    symbol,
    company: `${symbol} Co`,
    date: scheduledDate,
    scheduledDate,
    timing: "AMC",
    status: "reported",
    overallResult: "Beat",
  };
}

function response(symbol: string, scheduledDate: string): Response {
  return new Response(JSON.stringify({
    events: [event(symbol, scheduledDate)],
    summary: { today: 0, thisWeek: 0, next30Days: 0 },
  }), { status: 200 });
}

function MonthProbe({ year, month, onState }: {
  year: number;
  month: number;
  onState: (state: ReturnType<typeof useEarningsMonth>) => void;
}) {
  const state = useEarningsMonth({ year, month });
  onState(state);
  return <div>{state.earnings.map((item) => item.symbol).join(",")}</div>;
}

describe("useEarningsMonth stale-while-revalidate cache", () => {
  afterEach(() => {
    cleanup();
    clearEarningsMonthCache();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    clearEarningsMonthCache();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-08-17T16:00:00.000Z"));
  });

  it("keeps a fresh current-month cache hit instant without another request", async () => {
    const fetched: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      fetched.push(String(input));
      const url = String(input);
      return url.includes("2026-08-01")
        ? response("AAPL", "2026-08-05")
        : response("MSFT", "2026-07-15");
    }));

    let latest: ReturnType<typeof useEarningsMonth> | null = null;
    const { rerender } = render(
      <MonthProbe year={2026} month={7} onState={(state) => { latest = state; }} />,
    );
    await waitFor(() => expect(latest?.earnings[0]?.symbol).toBe("AAPL"));

    rerender(<MonthProbe year={2026} month={6} onState={(state) => { latest = state; }} />);
    await waitFor(() => expect(latest?.earnings[0]?.symbol).toBe("MSFT"));

    await act(async () => {
      vi.setSystemTime(new Date("2026-08-17T16:30:00.000Z"));
      rerender(<MonthProbe year={2026} month={7} onState={(state) => { latest = state; }} />);
    });
    await waitFor(() => expect(latest?.earnings[0]?.symbol).toBe("AAPL"));

    expect(fetched.filter((url) => url.includes("2026-08-01"))).toHaveLength(1);
    expect(latest!.loading).toBe(false);
  });

  it("renders stale current-month data immediately and refreshes it in the background", async () => {
    let augustRequests = 0;
    let resolveRefresh: ((value: Response) => void) | null = null;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("2026-08-01")) {
        augustRequests += 1;
        if (augustRequests === 1) return response("AAPL", "2026-08-05");
        return new Promise<Response>((resolve) => { resolveRefresh = resolve; });
      }
      return response("JUL", "2026-07-15");
    }));

    let latest: ReturnType<typeof useEarningsMonth> | null = null;
    const { rerender } = render(
      <MonthProbe year={2026} month={7} onState={(state) => { latest = state; }} />,
    );
    await waitFor(() => expect(latest?.earnings[0]?.symbol).toBe("AAPL"));

    rerender(<MonthProbe year={2026} month={6} onState={(state) => { latest = state; }} />);
    await waitFor(() => expect(latest?.earnings[0]?.symbol).toBe("JUL"));

    await act(async () => {
      vi.setSystemTime(new Date("2026-08-17T17:01:00.000Z"));
      rerender(<MonthProbe year={2026} month={7} onState={(state) => { latest = state; }} />);
    });

    // Stale-while-revalidate: old data stays visible and there is no loading flash.
    expect(latest!.earnings[0]?.symbol).toBe("AAPL");
    expect(latest!.loading).toBe(false);
    expect(augustRequests).toBe(2);

    await act(async () => {
      resolveRefresh?.(response("NVDA", "2026-08-20"));
    });
    await waitFor(() => expect(latest?.earnings[0]?.symbol).toBe("NVDA"));
  });

  it("keeps stale last-known-good data when background revalidation fails", async () => {
    let augustRequests = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("2026-08-01")) {
        augustRequests += 1;
        return augustRequests === 1
          ? response("AAPL", "2026-08-05")
          : new Response("upstream failure", { status: 503 });
      }
      return response("JUL", "2026-07-15");
    }));

    let latest: ReturnType<typeof useEarningsMonth> | null = null;
    const { rerender } = render(
      <MonthProbe year={2026} month={7} onState={(state) => { latest = state; }} />,
    );
    await waitFor(() => expect(latest?.earnings[0]?.symbol).toBe("AAPL"));
    rerender(<MonthProbe year={2026} month={6} onState={(state) => { latest = state; }} />);
    await waitFor(() => expect(latest?.earnings[0]?.symbol).toBe("JUL"));

    await act(async () => {
      vi.setSystemTime(new Date("2026-08-17T17:01:00.000Z"));
      rerender(<MonthProbe year={2026} month={7} onState={(state) => { latest = state; }} />);
    });
    await waitFor(() => expect(augustRequests).toBe(2));

    expect(latest!.earnings[0]?.symbol).toBe("AAPL");
    expect(latest!.available).toBe(false);
    expect(latest!.loading).toBe(false);
    expect(latest!.stale).toBe(true);
  });

  it("treats closed historical months as cache-stable even after a long time", async () => {
    const fetched: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      fetched.push(String(input));
      const url = String(input);
      return url.includes("2026-07-01")
        ? response("JUL", "2026-07-15")
        : response("JUN", "2026-06-15");
    }));

    let latest: ReturnType<typeof useEarningsMonth> | null = null;
    const { rerender } = render(
      <MonthProbe year={2026} month={6} onState={(state) => { latest = state; }} />,
    );
    await waitFor(() => expect(latest?.earnings[0]?.symbol).toBe("JUL"));
    rerender(<MonthProbe year={2026} month={5} onState={(state) => { latest = state; }} />);
    await waitFor(() => expect(latest?.earnings[0]?.symbol).toBe("JUN"));

    await act(async () => {
      vi.setSystemTime(new Date("2026-08-27T16:00:00.000Z"));
      rerender(<MonthProbe year={2026} month={6} onState={(state) => { latest = state; }} />);
    });
    await waitFor(() => expect(latest?.earnings[0]?.symbol).toBe("JUL"));

    expect(fetched.filter((url) => url.includes("2026-07-01"))).toHaveLength(1);
  });

  it("revalidates a current month left open once its one-hour TTL expires", async () => {
    let augustRequests = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (!String(input).includes("2026-08-01")) throw new Error("unexpected month");
      augustRequests += 1;
      return augustRequests === 1
        ? response("AAPL", "2026-08-05")
        : response("NVDA", "2026-08-20");
    }));

    let latest: ReturnType<typeof useEarningsMonth> | null = null;
    render(<MonthProbe year={2026} month={7} onState={(state) => { latest = state; }} />);
    await waitFor(() => expect(latest?.earnings[0]?.symbol).toBe("AAPL"));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60 * 60_000);
    });

    await waitFor(() => expect(augustRequests).toBe(2));
    await waitFor(() => expect(latest?.earnings[0]?.symbol).toBe("NVDA"));
  });

  it("does not let a stale background refresh overwrite a newer selected month", async () => {
    let augustRequests = 0;
    let resolveRefresh: ((value: Response) => void) | null = null;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("2026-08-01")) {
        augustRequests += 1;
        if (augustRequests === 1) return response("AAPL", "2026-08-05");
        return new Promise<Response>((resolve) => { resolveRefresh = resolve; });
      }
      return response("JUL", "2026-07-15");
    }));

    let latest: ReturnType<typeof useEarningsMonth> | null = null;
    const { rerender } = render(
      <MonthProbe year={2026} month={7} onState={(state) => { latest = state; }} />,
    );
    await waitFor(() => expect(latest?.earnings[0]?.symbol).toBe("AAPL"));

    await act(async () => {
      vi.setSystemTime(new Date("2026-08-17T17:01:00.000Z"));
      rerender(<MonthProbe year={2026} month={6} onState={(state) => { latest = state; }} />);
    });
    await waitFor(() => expect(latest?.earnings[0]?.symbol).toBe("JUL"));

    // Re-enter August to start the stale refresh, then leave before it resolves.
    rerender(<MonthProbe year={2026} month={7} onState={(state) => { latest = state; }} />);
    await waitFor(() => expect(augustRequests).toBe(2));
    rerender(<MonthProbe year={2026} month={6} onState={(state) => { latest = state; }} />);
    await waitFor(() => expect(latest?.earnings[0]?.symbol).toBe("JUL"));

    await act(async () => {
      resolveRefresh?.(response("NVDA", "2026-08-20"));
    });

    expect(latest!.earnings[0]?.symbol).toBe("JUL");
  });

  it("keeps the month cache bounded to eight entries", async () => {
    const fetched: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      fetched.push(url);
      const match = /from=(\d{4}-\d{2})-01/.exec(url);
      const monthKey = match?.[1] ?? "unknown";
      return response(monthKey, `${monthKey}-15`);
    }));

    let latest: ReturnType<typeof useEarningsMonth> | null = null;
    const { rerender } = render(
      <MonthProbe year={2025} month={10} onState={(state) => { latest = state; }} />,
    );
    await waitFor(() => expect(latest?.available).toBe(true));

    // Fill nine distinct closed historical months. The first must be evicted.
    for (let offset = 1; offset < 9; offset += 1) {
      const date = new Date(2025, 10 - offset, 1);
      rerender(
        <MonthProbe year={date.getFullYear()} month={date.getMonth()} onState={(state) => { latest = state; }} />,
      );
      await waitFor(() => expect(latest?.earnings[0]?.symbol).toBe(
        `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`,
      ));
    }

    rerender(<MonthProbe year={2025} month={10} onState={(state) => { latest = state; }} />);
    await waitFor(() => expect(latest?.earnings[0]?.symbol).toBe("2025-11"));

    expect(fetched.filter((url) => url.includes("from=2025-11-01"))).toHaveLength(2);
  });
});
