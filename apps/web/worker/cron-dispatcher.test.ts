import { describe, expect, it } from "vitest";
import {
  EARNINGS_CALENDAR_CRON,
  EARNINGS_MONITOR_CRON,
  jobsForProductionCron,
  isSentimentDispatchTime,
  PRODUCTION_CRON_TRIGGERS,
} from "./cron-dispatcher";

describe("production cron dispatcher", () => {
  it("declares exactly the two production trigger entries", () => {
    expect(PRODUCTION_CRON_TRIGGERS).toEqual([
      "*/15 * * * *",
      "0 6 * * *",
    ]);
  });

  it("runs monitor and market context on every 15-minute invocation", () => {
    expect(jobsForProductionCron(EARNINGS_MONITOR_CRON, new Date("2026-08-15T03:15:00Z")))
      .toEqual(["earnings-monitor", "market-context"]);
  });

  it("adds sentiment only at the two weekday UTC schedule times", () => {
    for (const hour of [14, 19]) {
      const scheduledTime = new Date(`2026-08-13T${hour.toString().padStart(2, "0")}:00:00Z`);
      expect(isSentimentDispatchTime(scheduledTime)).toBe(true);
      expect(jobsForProductionCron(EARNINGS_MONITOR_CRON, scheduledTime))
        .toEqual(["earnings-monitor", "market-context", "sentiment"]);
    }
    expect(isSentimentDispatchTime(new Date("2026-08-13T14:15:00Z"))).toBe(false);
    expect(isSentimentDispatchTime(new Date("2026-08-15T14:00:00Z"))).toBe(false);
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
