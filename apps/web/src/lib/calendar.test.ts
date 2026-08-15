import { describe, expect, it } from "vitest";
import { monthDays } from "./calendar";

describe("monthDays Monday-first grid", () => {
  it("builds the monthly grid Monday-first for a month that starts on Saturday (Aug 2026)", () => {
    const cells = monthDays(7, 2026);
    expect(cells).toHaveLength(42);
    expect(cells.slice(0, 5)).toEqual([null, null, null, null, null]);
    expect(cells[5]).toBe(1); // day 1 under Saturday
    expect(cells[6]).toBe(2); // day 2 under Sunday
    expect(cells[7]).toBe(3); // next week begins on Monday
    expect(cells[35]).toBe(31);
    expect(cells.slice(36)).toEqual([null, null, null, null, null, null]);
  });

  it("places day 1 of a Sunday-start month in the last column (Mar 2026)", () => {
    const cells = monthDays(2, 2026);
    expect(cells).toHaveLength(42);
    expect(cells.slice(0, 6)).toEqual([null, null, null, null, null, null]);
    expect(cells[6]).toBe(1); // Sunday column (index 6)
    expect(cells[36]).toBe(31);
  });

  it("lays out a Monday-start month with no leading cells (Feb 2027)", () => {
    const cells = monthDays(1, 2027);
    expect(cells).toHaveLength(28);
    expect(cells[0]).toBe(1);
    expect(cells[27]).toBe(28);
    expect(cells).not.toContain(null);
  });

  it("keeps a leap February aligned (Feb 2028)", () => {
    const cells = monthDays(1, 2028);
    expect(cells).toHaveLength(35);
    expect(cells[0]).toBeNull(); // Tuesday lead-in
    expect(cells[1]).toBe(1);
    expect(cells[29]).toBe(29);
    expect(cells.slice(30)).toEqual([null, null, null, null, null]);
  });

  it("keeps a December → January boundary aligned", () => {
    const december = monthDays(11, 2026);
    const january = monthDays(0, 2027);
    expect(december).toHaveLength(35);
    expect(december[1]).toBe(1); // Dec 1 under Tuesday
    expect(december[31]).toBe(31); // Dec 31 under Thursday
    expect(january).toHaveLength(35);
    expect(january[4]).toBe(1); // Jan 1 under Friday
    expect(january[34]).toBe(31); // Jan 31 under Sunday
  });
});
