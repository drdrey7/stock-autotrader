import { cleanup, render, waitFor, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearEarningsMonthCache,
  earningsApiPath,
  marketTodayKey,
  monthCacheKey,
  monthDateRange,
  pastEarningsRange,
  shiftMarketDateKey,
  summaryEarningsRange,
  useEarningsMonth,
  usePastEarnings,
  useEarningsSummary,
  EARNINGS_CLIENT_PAST_DAYS,
  EARNINGS_CLIENT_SUMMARY_FORWARD_DAYS,
} from "./useEarnings";

function event(partial: Record<string, unknown>) {
  return {
    company: "Test Co",
    timing: "AMC",
    status: "reported",
    overallResult: "Beat",
    ...partial,
  };
}

function MonthProbe({ year, month, onState }: {
  year: number;
  month: number;
  onState: (state: ReturnType<typeof useEarningsMonth>) => void;
}) {
  const state = useEarningsMonth({ year, month });
  onState(state);
  return <div data-testid="month-count">{state.earnings.length}</div>;
}

function PastProbe({ onState }: { onState: (state: ReturnType<typeof usePastEarnings>) => void }) {
  const state = usePastEarnings();
  onState(state);
  return <div data-testid="past-count">{state.earnings.length}</div>;
}

describe("earnings pure date ranges", () => {
  it("builds first/last day for the current month", () => {
    expect(monthDateRange({ year: 2026, month: 7 })).toEqual({ from: "2026-08-01", to: "2026-08-31" });
    expect(monthCacheKey({ year: 2026, month: 7 })).toBe("2026-08");
  });

  it("handles February leap years", () => {
    expect(monthDateRange({ year: 2024, month: 1 })).toEqual({ from: "2024-02-01", to: "2024-02-29" });
    expect(monthDateRange({ year: 2025, month: 1 })).toEqual({ from: "2025-02-01", to: "2025-02-28" });
  });

  it("covers Past Earnings Dec→Jan rolling 30 days", () => {
    const today = marketTodayKey(Date.parse("2027-01-15T17:00:00.000Z"));
    expect(today).toBe("2027-01-15");
    expect(pastEarningsRange(today)).toEqual({ from: "2026-12-17", to: "2027-01-15" });
    expect(EARNINGS_CLIENT_PAST_DAYS).toBe(30);
    expect(earningsApiPath(pastEarningsRange(today))).toBe("/api/earnings?from=2026-12-17&to=2027-01-15");
  });

  it("builds summary from Monday week start through +30 days", () => {
    // 2026-08-12 is Wednesday ET → week starts Monday 2026-08-10
    const today = marketTodayKey(Date.parse("2026-08-12T16:00:00.000Z"));
    expect(today).toBe("2026-08-12");
    const range = summaryEarningsRange(today);
    expect(range.from).toBe("2026-08-10");
    expect(range.to).toBe(shiftMarketDateKey(today, EARNINGS_CLIENT_SUMMARY_FORWARD_DAYS));
    expect(range.to).toBe("2026-09-11");
  });
});

describe("useEarningsMonth fetch-on-month", () => {
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
    vi.setSystemTime(new Date("2026-08-16T16:00:00.000Z"));
  });

  it("fetches only the selected month range", async () => {
    const fetched: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      fetched.push(String(input));
      return new Response(JSON.stringify({
        events: [event({ symbol: "AAPL", date: "2026-08-05", scheduledDate: "2026-08-05" })],
        summary: { today: 0, thisWeek: 0, next30Days: 0 },
      }), { status: 200 });
    }));

    let latest: ReturnType<typeof useEarningsMonth> | null = null;
    render(<MonthProbe year={2026} month={7} onState={(state) => { latest = state; }} />);
    await waitFor(() => expect(latest?.available).toBe(true));
    expect(fetched).toEqual(["/api/earnings?from=2026-08-01&to=2026-08-31"]);
    expect(latest!.earnings.map((row) => row.symbol)).toEqual(["AAPL"]);
  });

  it("fetches July then June when navigating previous months", async () => {
    const fetched: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      fetched.push(String(input));
      const url = String(input);
      const symbol = url.includes("2026-07-01") ? "MSFT" : url.includes("2026-06-01") ? "NVDA" : "AAPL";
      const date = url.includes("2026-07-01") ? "2026-07-15" : url.includes("2026-06-01") ? "2026-06-10" : "2026-08-05";
      return new Response(JSON.stringify({
        events: [event({ symbol, date, scheduledDate: date })],
        summary: { today: 0, thisWeek: 0, next30Days: 0 },
      }), { status: 200 });
    }));

    let period = { year: 2026, month: 7 };
    let latest: ReturnType<typeof useEarningsMonth> | null = null;
    const { rerender } = render(
      <MonthProbe year={period.year} month={period.month} onState={(state) => { latest = state; }} />,
    );
    await waitFor(() => expect(latest?.available).toBe(true));
    expect(fetched.at(-1)).toBe("/api/earnings?from=2026-08-01&to=2026-08-31");

    period = { year: 2026, month: 6 };
    rerender(<MonthProbe year={period.year} month={period.month} onState={(state) => { latest = state; }} />);
    await waitFor(() => expect(latest?.earnings.some((row) => row.symbol === "MSFT")).toBe(true));
    expect(fetched).toContain("/api/earnings?from=2026-07-01&to=2026-07-31");

    period = { year: 2026, month: 5 };
    rerender(<MonthProbe year={period.year} month={period.month} onState={(state) => { latest = state; }} />);
    await waitFor(() => expect(latest?.earnings.some((row) => row.symbol === "NVDA")).toBe(true));
    expect(fetched).toContain("/api/earnings?from=2026-06-01&to=2026-06-30");
  });

  it("serves August from cache when returning Aug → Jul → Aug", async () => {
    const fetched: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      fetched.push(String(input));
      return new Response(JSON.stringify({ events: [], summary: { today: 0, thisWeek: 0, next30Days: 0 } }), { status: 200 });
    }));

    let period = { year: 2026, month: 7 };
    let latest: ReturnType<typeof useEarningsMonth> | null = null;
    const { rerender } = render(
      <MonthProbe year={period.year} month={period.month} onState={(state) => { latest = state; }} />,
    );
    await waitFor(() => expect(latest?.loading).toBe(false));
    expect(fetched.filter((url) => url.includes("2026-08-01"))).toHaveLength(1);

    period = { year: 2026, month: 6 };
    rerender(<MonthProbe year={period.year} month={period.month} onState={(state) => { latest = state; }} />);
    await waitFor(() => expect(fetched.some((url) => url.includes("2026-07-01"))).toBe(true));

    period = { year: 2026, month: 7 };
    rerender(<MonthProbe year={period.year} month={period.month} onState={(state) => { latest = state; }} />);
    await waitFor(() => expect(latest?.loading).toBe(false));
    // August was cached — no second August fetch.
    expect(fetched.filter((url) => url.includes("2026-08-01"))).toHaveLength(1);
  });

  it("does not let a stale slower month overwrite a newer selection", async () => {
    let resolveJuly: ((value: Response) => void) | null = null;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("2026-07-01")) {
        return new Promise<Response>((resolve) => {
          resolveJuly = resolve;
        });
      }
      return new Response(JSON.stringify({
        events: [event({ symbol: "JUN", date: "2026-06-05", scheduledDate: "2026-06-05" })],
        summary: { today: 0, thisWeek: 0, next30Days: 0 },
      }), { status: 200 });
    }));

    let period = { year: 2026, month: 6 }; // July
    let latest: ReturnType<typeof useEarningsMonth> | null = null;
    const { rerender } = render(
      <MonthProbe year={period.year} month={period.month} onState={(state) => { latest = state; }} />,
    );

    // Immediately navigate to June before July resolves.
    period = { year: 2026, month: 5 };
    rerender(<MonthProbe year={period.year} month={period.month} onState={(state) => { latest = state; }} />);
    await waitFor(() => expect(latest?.earnings.some((row) => row.symbol === "JUN")).toBe(true));

    await act(async () => {
      resolveJuly?.(new Response(JSON.stringify({
        events: [event({ symbol: "JUL", date: "2026-07-05", scheduledDate: "2026-07-05" })],
        summary: { today: 0, thisWeek: 0, next30Days: 0 },
      }), { status: 200 }));
    });

    // Still June — stale July must not win.
    await waitFor(() => expect(latest?.earnings.some((row) => row.symbol === "JUN")).toBe(true));
    expect(latest!.earnings.some((row) => row.symbol === "JUL")).toBe(false);
  });

  it("treats an empty historical month as available empty state", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      events: [],
      summary: { today: 0, thisWeek: 0, next30Days: 0 },
    }), { status: 200 })));

    let latest: ReturnType<typeof useEarningsMonth> | null = null;
    render(<MonthProbe year={2025} month={0} onState={(state) => { latest = state; }} />);
    await waitFor(() => expect(latest?.available).toBe(true));
    expect(latest!.earnings).toEqual([]);
    expect(latest!.loading).toBe(false);
  });
});

describe("usePastEarnings", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2027-01-15T17:00:00.000Z"));
  });

  it("requests Dec→Jan window and keeps only non-scheduled events inside it", async () => {
    const fetched: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      fetched.push(String(input));
      return new Response(JSON.stringify({
        events: [
          event({ symbol: "AAPL", date: "2026-12-20", scheduledDate: "2026-12-20", status: "reported" }),
          event({ symbol: "OLD", date: "2026-12-10", scheduledDate: "2026-12-10", status: "reported" }),
          event({ symbol: "MSFT", date: "2027-01-10", scheduledDate: "2027-01-10", status: "reported" }),
          event({ symbol: "NVDA", date: "2027-02-01", scheduledDate: "2027-02-01", status: "scheduled" }),
        ],
        summary: { today: 0, thisWeek: 0, next30Days: 1 },
      }), { status: 200 });
    }));

    let latest: ReturnType<typeof usePastEarnings> | null = null;
    render(<PastProbe onState={(state) => { latest = state; }} />);
    await waitFor(() => expect(latest?.available).toBe(true));
    expect(fetched).toEqual(["/api/earnings?from=2026-12-17&to=2027-01-15"]);
    expect(latest!.earnings.map((row) => row.symbol).sort()).toEqual(["AAPL", "MSFT"]);
    expect(latest!.earnings.some((row) => row.symbol === "OLD")).toBe(false);
    expect(latest!.earnings.some((row) => row.symbol === "NVDA")).toBe(false);
  });
});

describe("useEarningsSummary independence", () => {
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
    vi.setSystemTime(new Date("2026-08-16T16:00:00.000Z"));
  });

  it("keeps TODAY/THIS WEEK/NEXT 30 from the current window while a historical month is viewed", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("from=2026-06-01")) {
        return new Response(JSON.stringify({
          events: [event({ symbol: "OLD", date: "2026-06-05", scheduledDate: "2026-06-05" })],
          summary: { today: 99, thisWeek: 99, next30Days: 99 },
        }), { status: 200 });
      }
      // Summary / past window.
      return new Response(JSON.stringify({
        events: [event({ symbol: "NOW", date: "2026-08-16", scheduledDate: "2026-08-16", status: "scheduled" })],
        summary: { today: 1, thisWeek: 2, next30Days: 3 },
      }), { status: 200 });
    }));

    let summary: ReturnType<typeof useEarningsSummary> | null = null;
    let month: ReturnType<typeof useEarningsMonth> | null = null;
    function Both() {
      summary = useEarningsSummary();
      month = useEarningsMonth({ year: 2026, month: 5 });
      return null;
    }
    render(<Both />);
    await waitFor(() => expect(summary?.available).toBe(true));
    await waitFor(() => expect(month?.available).toBe(true));
    expect(summary).toMatchObject({ today: 1, thisWeek: 2, next30Days: 3 });
    expect(month!.earnings.map((row) => row.symbol)).toEqual(["OLD"]);
  });
});
