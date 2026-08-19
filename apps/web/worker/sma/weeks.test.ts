import { describe, expect, it } from "vitest";
import { isoMonday, isoWeekOfDate, isoWeekOfDateKey, isoWeekOfNyInstant, weekDiffDays } from "./weeks";

describe("isoWeekOfDate", () => {
  it("computes known ISO weeks", () => {
    expect(isoWeekOfDate(2026, 8, 14)).toEqual({ year: 2026, week: 33 }); // Friday
    expect(isoWeekOfDate(2026, 8, 10)).toEqual({ year: 2026, week: 33 }); // Monday same week
    expect(isoWeekOfDate(2026, 8, 17)).toEqual({ year: 2026, week: 34 }); // next Monday
  });

  it("handles year boundaries", () => {
    expect(isoWeekOfDate(2025, 12, 29)).toEqual({ year: 2026, week: 1 }); // Monday
    expect(isoWeekOfDate(2026, 1, 1)).toEqual({ year: 2026, week: 1 }); // Thursday
    expect(isoWeekOfDate(2027, 1, 1)).toEqual({ year: 2026, week: 53 }); // Friday -> 2026-W53
  });
});

describe("isoWeekOfNyInstant", () => {
  it("maps UTC instants to the NY calendar week (DST-safe)", () => {
    // 2026-08-14 23:30 UTC = 19:30 NY (EDT) same day -> week 33.
    expect(isoWeekOfNyInstant(new Date("2026-08-14T23:30:00Z"))).toEqual({ year: 2026, week: 33 });
    // 2026-08-15 02:00 UTC = 22:00 NY on Aug 14 (EDT) -> still week 33.
    expect(isoWeekOfNyInstant(new Date("2026-08-15T02:00:00Z"))).toEqual({ year: 2026, week: 33 });
    // Winter DST: 2026-01-15 05:00 UTC = 00:00 NY (EST) -> Jan 15.
    expect(isoWeekOfNyInstant(new Date("2026-01-15T05:00:00Z"))).toEqual({ year: 2026, week: 3 });
    // 2026-01-15 04:59 UTC = 23:59 NY Jan 14 (EST).
    expect(isoWeekOfNyInstant(new Date("2026-01-15T04:59:00Z"))).toEqual({ year: 2026, week: 3 });
  });

  it("Monday 00:30 UTC is still Sunday night in NY (previous week)", () => {
    // 2026-08-17 00:30 UTC = Sunday 20:30 NY -> ISO week 33, not 34.
    expect(isoWeekOfNyInstant(new Date("2026-08-17T00:30:00Z"))).toEqual({ year: 2026, week: 33 });
    // 2026-08-17 12:00 UTC = Monday 08:00 NY -> week 34.
    expect(isoWeekOfNyInstant(new Date("2026-08-17T12:00:00Z"))).toEqual({ year: 2026, week: 34 });
  });

  it("returns null for invalid instants", () => {
    expect(isoWeekOfNyInstant(new Date("not-a-date"))).toBeNull();
  });
});

describe("isoWeekOfDateKey", () => {
  it("parses Alpha Vantage date keys", () => {
    expect(isoWeekOfDateKey("2026-08-14")).toEqual({ year: 2026, week: 33 });
    expect(isoWeekOfDateKey("2025-04-17")).toEqual({ year: 2025, week: 16 }); // Good Friday week
  });

  it("rejects malformed/impossible keys", () => {
    expect(isoWeekOfDateKey("2026-13-01")).toBeNull();
    expect(isoWeekOfDateKey("2026-02-30")).toBeNull();
    expect(isoWeekOfDateKey("not-a-date")).toBeNull();
    expect(isoWeekOfDateKey("")).toBeNull();
  });
});

describe("weekDiffDays / isoMonday", () => {
  it("consecutive weeks differ by exactly 7 days", () => {
    const w33 = isoWeekOfDate(2026, 8, 14);
    const w34 = isoWeekOfDate(2026, 8, 17);
    expect(weekDiffDays(w34, w33)).toBe(7);
    expect(weekDiffDays(w33, w34)).toBe(-7);
  });

  it("year-boundary weeks are consecutive, not gaps", () => {
    const w52 = { year: 2021, week: 52 };
    const w1 = { year: 2022, week: 1 };
    expect(weekDiffDays(w1, w52)).toBe(7);
  });

  it("week 53 years work", () => {
    const w53 = { year: 2026, week: 53 };
    const w1 = { year: 2027, week: 1 };
    expect(weekDiffDays(w1, w53)).toBe(7);
    expect(isoMonday(w53).getUTCDay()).toBe(1);
  });
});
