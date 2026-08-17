import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearEarningsMonthCache,
  getEarningsMonthCacheStats,
  useEarningsMonth,
} from "./useEarnings";

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

describe("useEarningsMonth SWR hardening", () => {
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

  it("persists stale unavailable state across navigation after revalidation fails", async () => {
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
    await waitFor(() => expect(latest?.available).toBe(false));
    expect(latest!.earnings[0]?.symbol).toBe("AAPL");
    expect(latest!.stale).toBe(true);

    // Navigate away and return inside the retry cooldown. The cached source
    // status remains unavailable and no third request is allowed yet.
    rerender(<MonthProbe year={2026} month={6} onState={(state) => { latest = state; }} />);
    await waitFor(() => expect(latest?.earnings[0]?.symbol).toBe("JUL"));
    await act(async () => {
      vi.setSystemTime(new Date("2026-08-17T17:06:00.000Z"));
      rerender(<MonthProbe year={2026} month={7} onState={(state) => { latest = state; }} />);
    });
    await waitFor(() => expect(latest?.earnings[0]?.symbol).toBe("AAPL"));
    expect(latest!.available).toBe(false);
    expect(latest!.stale).toBe(true);
    expect(augustRequests).toBe(2);
    expect(getEarningsMonthCacheStats().activeRequests).toBe(0);
  });

  it("backs off failed stale revalidation and retries only after the cooldown", async () => {
    let augustRequests = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (!String(input).includes("2026-08-01")) throw new Error("unexpected month");
      augustRequests += 1;
      return augustRequests === 1
        ? response("AAPL", "2026-08-05")
        : new Response("upstream failure", { status: 503 });
    }));

    let latest: ReturnType<typeof useEarningsMonth> | null = null;
    render(<MonthProbe year={2026} month={7} onState={(state) => { latest = state; }} />);
    await waitFor(() => expect(latest?.earnings[0]?.symbol).toBe("AAPL"));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60 * 60_000);
    });
    await waitFor(() => expect(augustRequests).toBe(2));
    await waitFor(() => expect(latest?.available).toBe(false));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * 60_000);
    });
    expect(augustRequests).toBe(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000);
    });
    await waitFor(() => expect(augustRequests).toBe(3));
    expect(latest!.earnings[0]?.symbol).toBe("AAPL");
    expect(latest!.stale).toBe(true);
  });

  it("clears stale and restores availability after a successful background revalidation", async () => {
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

    await waitFor(() => expect(augustRequests).toBe(2));
    expect(latest!.earnings[0]?.symbol).toBe("AAPL");
    expect(latest!.stale).toBe(true);

    await act(async () => {
      resolveRefresh?.(response("NVDA", "2026-08-20"));
    });
    await waitFor(() => expect(latest?.earnings[0]?.symbol).toBe("NVDA"));
    expect(latest!.stale).toBe(false);
    expect(latest!.available).toBe(true);
    expect(getEarningsMonthCacheStats().activeRequests).toBe(0);
  });

  it("keeps cache bounded and request bookkeeping ephemeral", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const match = /from=(\d{4}-\d{2})-01/.exec(url);
      const monthKey = match?.[1] ?? "unknown";
      return response(monthKey, `${monthKey}-15`);
    }));

    let latest: ReturnType<typeof useEarningsMonth> | null = null;
    const { rerender } = render(
      <MonthProbe year={2025} month={10} onState={(state) => { latest = state; }} />,
    );
    await waitFor(() => expect(latest?.available).toBe(true));

    for (let offset = 1; offset < 9; offset += 1) {
      const date = new Date(2025, 10 - offset, 1);
      rerender(
        <MonthProbe year={date.getFullYear()} month={date.getMonth()} onState={(state) => { latest = state; }} />,
      );
      await waitFor(() => expect(latest?.earnings[0]?.symbol).toBe(
        `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`,
      ));
    }

    expect(getEarningsMonthCacheStats()).toEqual({ cacheEntries: 8, activeRequests: 0 });
  });
});
