import { describe, expect, it } from "vitest";
import { deriveDailyChange, type DailyChangeQuote } from "./daily-change";

const VALID: DailyChangeQuote = {
  price: 102,
  previous_close: 100,
  quote_session_date: "2026-08-27",
  previous_close_session_date: "2026-08-26",
  daily_change_valid: 1,
};

describe("deriveDailyChange", () => {
  it("derives the invariant instead of trusting persisted change fields", () => {
    const change = deriveDailyChange(VALID, "2026-08-27", "regular");
    expect(change?.changeAbs).toBe(2);
    expect(change?.changePct).toBeCloseTo(2);
  });

  it("fails closed outside the regular session while retaining price elsewhere", () => {
    expect(deriveDailyChange(VALID, "2026-08-27", "post_close")).toBeNull();
    expect(deriveDailyChange(VALID, "2026-08-29", "closed")).toBeNull();
  });

  it("fails closed when the quote is from an older session", () => {
    expect(deriveDailyChange({ ...VALID, quote_session_date: "2026-08-26" }, "2026-08-27", "regular")).toBeNull();
  });

  it("fails closed when previous-close provenance is missing or invalid", () => {
    expect(deriveDailyChange({ ...VALID, daily_change_valid: 0 }, "2026-08-27", "regular")).toBeNull();
    expect(deriveDailyChange({ ...VALID, previous_close: null }, "2026-08-27", "regular")).toBeNull();
    expect(deriveDailyChange({ ...VALID, previous_close_session_date: null }, "2026-08-27", "regular")).toBeNull();
    expect(deriveDailyChange({ price: 102, previous_close: 100 }, "2026-08-27", "regular")).toBeNull();
  });

  it("fails closed across an effective split boundary", () => {
    expect(deriveDailyChange(VALID, "2026-08-27", "regular", "2026-08-27")).toBeNull();
  });

  it("allows an older split that predates the previous-close session", () => {
    const change = deriveDailyChange(VALID, "2026-08-27", "regular", "2026-08-20");
    expect(change?.changeAbs).toBe(2);
    expect(change?.changePct).toBeCloseTo(2);
  });
});
