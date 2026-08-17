import { describe, expect, it } from "vitest";
import { formatCompactMoney, formatDate, formatPercent, formatShareValue } from "./format";

describe("formatDate", () => {
  it("formats valid timestamps", () => {
    expect(formatDate("2026-08-10T20:16:12Z")).toContain("Aug");
  });

  it("fails safely for malformed timestamps", () => {
    expect(formatDate("not-a-timestamp")).toBe("Unavailable");
  });
});

describe("formatShareValue (EPS)", () => {
  it("formats share-style amounts with a dollar prefix", () => {
    expect(formatShareValue(2.02)).toBe("$2.02");
    expect(formatShareValue(1.91)).toBe("$1.91");
    expect(formatShareValue(1.9271)).toBe("$1.93");
  });

  it("uses the sign-before-currency convention for negative EPS", () => {
    // COIN regression: negative EPS must render -$1.17, never $-1.17.
    expect(formatShareValue(-1.17)).toBe("-$1.17");
    expect(formatShareValue(-1.36)).toBe("-$1.36");
  });

  it("renders N/A for missing values", () => {
    expect(formatShareValue(null)).toBe("N/A");
    expect(formatShareValue(Number.NaN)).toBe("N/A");
  });
});

describe("formatCompactMoney (large financial values)", () => {
  it("compacts billions and millions with the documented examples", () => {
    expect(formatCompactMoney(109_417_000_000)).toBe("$109.4B");
    expect(formatCompactMoney(11_536_000_000)).toBe("$11.54B");
    expect(formatCompactMoney(1_220_068_000)).toBe("$1.22B");
    expect(formatCompactMoney(843_000_000)).toBe("$843M");
  });

  it("never shows a giant raw integer (NVDA upcoming estimate)", () => {
    const value = 93_634_391_959;
    const formatted = formatCompactMoney(value);
    expect(formatted).not.toContain(",391,959");
    expect(formatted).toMatch(/^\$\d+(\.\d+)?B$/);
  });

  it("keeps sub-billion values compact and negative values consistent", () => {
    expect(formatCompactMoney(11_396_426_778)).toBe("$11.4B");
    expect(formatCompactMoney(1_337_471_491)).toBe("$1.34B");
    expect(formatCompactMoney(110_823_804_698)).toBe("$110.8B");
    expect(formatCompactMoney(-1_220_068)).toBe("-$1.22M");
  });

  it("falls back to share-style currency below the million threshold and handles N/A", () => {
    expect(formatCompactMoney(2.02)).toBe("$2.02");
    expect(formatCompactMoney(null)).toBe("N/A");
  });

  it("promotes a value that rounds to 1000M into its B form", () => {
    expect(formatCompactMoney(999_999_999)).toBe("$1B");
    expect(formatCompactMoney(999_950_000)).toBe("$1B");
    expect(formatCompactMoney(999_900_000)).toBe("$999.9M");
  });
});

describe("formatPercent", () => {
  it("formats positive and negative percentages with explicit sign", () => {
    expect(formatPercent(1.7643)).toBe("+1.76%");
    expect(formatPercent(-0.894)).toBe("-0.89%");
    expect(formatPercent(10)).toBe("+10.00%");
    expect(formatPercent(-574.35)).toBe("-574.35%");
  });

  it("renders N/A for missing values", () => {
    expect(formatPercent(null)).toBe("N/A");
  });
});
