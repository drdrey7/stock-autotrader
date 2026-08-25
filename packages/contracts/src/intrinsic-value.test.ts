import { describe, expect, it } from "vitest";
import {
  calculateAutomaticIntrinsicValue,
  classifyValuationFamily,
  intrinsicValueDistancePct,
} from "./intrinsic-value";

describe("automatic intrinsic value", () => {
  it("defines Base as the exact midpoint of displayed Bear and Bull values", () => {
    const result = calculateAutomaticIntrinsicValue("MSFT", "Software", {
      price: 481.2,
      peTtm: 32.1,
      priceToBook: null,
    });

    expect(result).toEqual({
      family: "mega-cap-quality",
      method: "P/E",
      bear: 419.74,
      base: 464.71,
      bull: 509.68,
      bearMultiple: 28,
      baseMultiple: 31,
      bullMultiple: 34,
      bearUpsidePct: -12.8,
      baseUpsidePct: -3.4,
      bullUpsidePct: 5.9,
    });
    expect(result!.base).toBe((result!.bear + result!.bull) / 2);
  });

  it("uses justified P/B for balance-sheet financials", () => {
    expect(classifyValuationFamily("JPM", "Banks - Diversified")).toBe("bank");
    const result = calculateAutomaticIntrinsicValue("JPM", "Banks - Diversified", {
      price: 200,
      peTtm: 14,
      priceToBook: 2,
    });

    expect(result?.method).toBe("P/B");
    expect(result?.bear).toBe(122.86);
    expect(result?.base).toBe(159.48);
    expect(result?.bull).toBe(196.1);
    expect(result?.baseMultiple).toBe(1.6);
  });

  it("does not classify asset-light financial platforms as banks by name alone", () => {
    expect(classifyValuationFamily("HOOD", "Capital Markets")).toBe("general");
    expect(classifyValuationFamily("COIN", "Financial Services")).toBe("general");
  });

  it("fails closed on missing or distorted inputs", () => {
    expect(calculateAutomaticIntrinsicValue("MSFT", "Software", { price: null, peTtm: 30 })).toBeNull();
    expect(calculateAutomaticIntrinsicValue("MSFT", "Software", { price: 400, peTtm: -5 })).toBeNull();
    expect(calculateAutomaticIntrinsicValue("MSFT", "Software", { price: 400, peTtm: 151 })).toBeNull();
    expect(calculateAutomaticIntrinsicValue("JPM", "Banks", { price: 200, peTtm: 14, priceToBook: null })).toBeNull();
  });

  it("keeps Screener distance semantics unchanged", () => {
    expect(intrinsicValueDistancePct(80, 100)).toBeCloseTo(-20);
    expect(intrinsicValueDistancePct(120, 100)).toBeCloseTo(20);
  });
});
