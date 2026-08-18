import { describe, expect, it } from "vitest";
import {
  EARNINGS_CALENDAR_CRON,
  EARNINGS_MONITOR_CRON,
  jobsForProductionCron,
  isSentimentDispatchTime,
  PRODUCTION_CRON_TRIGGERS,
  SENTIMENT_WINDOW_END_MINUTES,
  SENTIMENT_WINDOW_START_MINUTES,
} from "./cron-dispatcher";

describe("production cron dispatcher", () => {
  it("declares exactly the two production trigger entries", () => {
    expect(PRODUCTION_CRON_TRIGGERS).toEqual([
      "*/15 * * * *",
      "0 6 * * *",
    ]);
  });

  it("no longer schedules quotes on the per-minute trigger (WS ingestor owns quotes)", () => {
    // The Finnhub WebSocket ingestor (apps/quote-ingestor, VPS) writes
    // latest_quotes directly; the REST shard job is not dispatched by any
    // trigger and no per-minute Cloudflare trigger exists.
    expect(PRODUCTION_CRON_TRIGGERS).not.toContain("* * * * *");
    expect(jobsForProductionCron("* * * * *", new Date("2026-08-13T14:00:00Z")))
      .toEqual([]);
  });

  it("runs monitor and market context on every 15-minute invocation", () => {
    expect(jobsForProductionCron(EARNINGS_MONITOR_CRON, new Date("2026-08-15T03:15:00Z")))
      .toEqual(["earnings-monitor", "market-context"]);
  });

  it("dispatches sentiment on 30-minute slots inside the US session (America/New_York)", () => {
    // 2026-08-13 is a Thursday. 14:00 UTC = 10:00 ET (EDT).
    expect(isSentimentDispatchTime(new Date("2026-08-13T14:00:00Z"))).toBe(true);
    expect(isSentimentDispatchTime(new Date("2026-08-13T14:30:00Z"))).toBe(true);
    // Quarter-hour slots (15/45) skip sentiment: no unnecessary CNN request.
    expect(isSentimentDispatchTime(new Date("2026-08-13T14:15:00Z"))).toBe(false);
    expect(isSentimentDispatchTime(new Date("2026-08-13T14:45:00Z"))).toBe(false);
    // Before the session open and after the post-close window: skipped.
    // 13:15 UTC = 09:15 ET (EDT) — pre-market.
    expect(isSentimentDispatchTime(new Date("2026-08-13T13:15:00Z"))).toBe(false);
    expect(isSentimentDispatchTime(new Date("2026-08-13T21:00:00Z"))).toBe(false);
    expect(SENTIMENT_WINDOW_START_MINUTES).toBe(9 * 60 + 30);
    expect(SENTIMENT_WINDOW_END_MINUTES).toBe(16 * 60 + 30);
  });

  it("skips sentiment on weekends and US market holidays", () => {
    // Saturday 2026-08-15.
    expect(isSentimentDispatchTime(new Date("2026-08-15T14:00:00Z"))).toBe(false);
    // Sunday 2026-08-16.
    expect(isSentimentDispatchTime(new Date("2026-08-16T14:00:00Z"))).toBe(false);
    // Observed Independence Day: Friday 2026-07-03 14:30 UTC = 10:30 ET.
    expect(isSentimentDispatchTime(new Date("2026-07-03T14:30:00Z"))).toBe(false);
  });

  it("is DST-safe: the same UTC hour maps to a different local slot across seasons", () => {
    // January (EST, UTC-5): 14:30 UTC = 09:30 ET — open, valid slot.
    expect(isSentimentDispatchTime(new Date("2026-01-12T14:30:00Z"))).toBe(true);
    // July (EDT, UTC-4): 14:30 UTC = 10:30 ET — also valid.
    expect(isSentimentDispatchTime(new Date("2026-07-13T14:30:00Z"))).toBe(true);
    // January: 13:30 UTC = 08:30 ET — pre-market, skipped; the same UTC time
    // in July is 09:30 ET — open, dispatched. Same UTC hour, different local
    // decision proves the dispatcher uses New York time, not UTC.
    expect(isSentimentDispatchTime(new Date("2026-01-12T13:30:00Z"))).toBe(false);
    expect(isSentimentDispatchTime(new Date("2026-07-13T13:30:00Z"))).toBe(true);
  });

  it("runs only the calendar job at 06:00 UTC", () => {
    expect(jobsForProductionCron(EARNINGS_CALENDAR_CRON, new Date("2026-08-13T06:00:00Z")))
      .toEqual(["earnings-calendar"]);
  });

  it("ignores unconfigured trigger expressions", () => {
    expect(jobsForProductionCron("0 14,19 * * mon-fri", new Date("2026-08-13T14:00:00Z")))
      .toEqual([]);
  });
});
