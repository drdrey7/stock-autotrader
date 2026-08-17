import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  earningsApiPath,
  earningsApiQueryRange,
  marketTodayKey,
  shiftMarketDateKey,
  useEarnings,
  EARNINGS_CLIENT_FUTURE_DAYS,
  EARNINGS_CLIENT_PAST_DAYS,
} from "./useEarnings";

function EarningsProbe({ onState }: { onState: (state: ReturnType<typeof useEarnings>) => void }) {
  const state = useEarnings();
  onState(state);
  return (
    <div>
      <span data-testid="available">{String(state.earningsAvailable)}</span>
      <span data-testid="count">{state.earnings.length}</span>
      <ul>
        {state.earnings.map((event) => (
          <li key={`${event.symbol}-${event.scheduledDate}`}>{event.symbol}:{event.scheduledDate}:{event.status}</li>
        ))}
      </ul>
    </div>
  );
}

describe("earningsApiQueryRange year-boundary", () => {
  it("covers a full rolling 30-day past window into December when today is mid-January", () => {
    // 2027-01-15 17:00 UTC = 2027-01-15 12:00 America/New_York
    const today = marketTodayKey(Date.parse("2027-01-15T17:00:00.000Z"));
    expect(today).toBe("2027-01-15");
    const range = earningsApiQueryRange(today);
    expect(range.from).toBe("2026-12-17");
    expect(range.to).toBe(shiftMarketDateKey(today, EARNINGS_CLIENT_FUTURE_DAYS));
    expect(range.to).toBe("2027-03-16");
    // Inclusive past window = PAST_EARNINGS_DAYS days.
    expect(EARNINGS_CLIENT_PAST_DAYS).toBe(30);
    expect(EARNINGS_CLIENT_FUTURE_DAYS).toBe(60);
    // Max span is well under the Worker EARNINGS_QUERY_MAX_DAYS (450).
    const spanDays = EARNINGS_CLIENT_PAST_DAYS + EARNINGS_CLIENT_FUTURE_DAYS;
    expect(spanDays).toBeLessThanOrEqual(450);
  });

  it("keeps non-January ranges on the same year for a normal mid-year day", () => {
    const today = marketTodayKey(Date.parse("2026-08-16T16:00:00.000Z"));
    expect(today).toBe("2026-08-16");
    const range = earningsApiQueryRange(today);
    expect(range.from).toBe("2026-07-18");
    expect(range.to).toBe("2026-10-15");
    expect(earningsApiPath(today)).toBe("/api/earnings?from=2026-07-18&to=2026-10-15");
  });
});

describe("useEarnings explicit API range", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // Freeze to 2027-01-15 New York so Past Earnings needs December rows.
    vi.setSystemTime(new Date("2027-01-15T17:00:00.000Z"));
  });

  it("requests from=December when market today is mid-January and keeps Dec reports in Past window", async () => {
    const fetched: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      fetched.push(url);
      expect(url).toBe("/api/earnings?from=2026-12-17&to=2027-03-16");
      return new Response(JSON.stringify({
        events: [
          {
            symbol: "AAPL",
            company: "Apple Inc",
            date: "2026-12-20",
            scheduledDate: "2026-12-20",
            status: "reported",
            timing: "AMC",
            overallResult: "Beat",
            epsEstimate: 1.5,
            epsActual: 1.6,
          },
          {
            symbol: "OLD",
            company: "Too Old Inc",
            date: "2026-12-10",
            scheduledDate: "2026-12-10",
            status: "reported",
            timing: "BMO",
            overallResult: "Miss",
          },
          {
            symbol: "MSFT",
            company: "Microsoft Corporation",
            date: "2027-01-10",
            scheduledDate: "2027-01-10",
            status: "reported",
            timing: "AMC",
            overallResult: "Beat",
          },
          {
            symbol: "NVDA",
            company: "NVIDIA Corporation",
            date: "2027-02-01",
            scheduledDate: "2027-02-01",
            status: "scheduled",
            timing: "AMC",
          },
        ],
        summary: { today: 0, thisWeek: 0, next30Days: 1 },
        from: "2026-12-17",
        to: "2027-03-16",
      }), { status: 200 });
    }));

    let latest: ReturnType<typeof useEarnings> | null = null;
    render(<EarningsProbe onState={(state) => { latest = state; }} />);

    await waitFor(() => expect(latest?.earningsAvailable).toBe(true));
    expect(fetched).toEqual(["/api/earnings?from=2026-12-17&to=2027-03-16"]);

    const symbols = latest!.earnings.map((event) => event.symbol);
    expect(symbols).toEqual(expect.arrayContaining(["AAPL", "MSFT", "NVDA", "OLD"]));

    // Mirror Past Earnings client filter: rolling 30 days ending market today.
    const today = marketTodayKey();
    const windowStart = shiftMarketDateKey(today, -(EARNINGS_CLIENT_PAST_DAYS - 1));
    expect(windowStart).toBe("2026-12-17");
    const past = latest!.earnings.filter((event) => (
      event.scheduledDate !== null
      && event.scheduledDate <= today
      && event.scheduledDate >= windowStart
      && event.status !== "scheduled"
    ));
    expect(past.map((event) => event.symbol).sort()).toEqual(["AAPL", "MSFT"]);
    expect(past.some((event) => event.symbol === "OLD")).toBe(false);
    expect(past.some((event) => event.scheduledDate === "2026-12-20")).toBe(true);
  });
});
