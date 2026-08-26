import { describe, expect, it } from "vitest";
import {
  calculateAutomaticIntrinsicValue,
  classifyValuationFamily,
  intrinsicValueDistancePct,
  type AutomaticIntrinsicValue,
  type AutomaticIntrinsicValueInput,
} from "./intrinsic-value";

const dense = (p25: number, median: number, p75: number, samples = 20) => ({ p25, median, p75, samples });

function expectArithmeticMidpoint(result: AutomaticIntrinsicValue): void {
  expect(result.base).toBe(Math.round(((result.bear + result.bull) / 2) * 100) / 100);
}

function amdInput(price: number | null): AutomaticIntrinsicValueInput {
  return {
    price,
    epsTtm: 3.8972,
    fcfPerShareTtm: 5.1533,
    revenuePerShareTtm: 92.4,
    revenueGrowthTtmYoyPct: 39.54,
    revenueGrowth3yPct: 13.64,
    revenueGrowth5yPct: 28.82,
    roicPct: 9.59,
    fcfMarginPct: 13.51,
    debtToEquity: 0.048,
    peHistory: dense(61.38, 80.97, 166.8, 19),
    pfcfHistory: dense(47.11, 59.57, 110.1, 20),
    psHistory: dense(4.8, 8.53, 12.8, 20),
  };
}

describe("Automatic IV V2", () => {
  it("uses explicit financial families without treating SOFI like JPM", () => {
    expect(classifyValuationFamily("JPM", "Banks - Diversified")).toBe("bank");
    expect(classifyValuationFamily("GS", "Capital Markets")).toBe("bank");
    expect(classifyValuationFamily("SOFI", "Credit Services")).toBe("growth-financial");
    expect(classifyValuationFamily("HOOD", "Capital Markets")).toBe("general");
    expect(classifyValuationFamily("COIN", "Financial Services")).toBe("general");
  });

  it("anchors a semiconductor to its own P/E, P/FCF and P/S history", () => {
    const result = calculateAutomaticIntrinsicValue("AMD", "Semiconductors", amdInput(480));
    expect(result).not.toBeNull();
    expect(result!.family).toBe("semiconductors");
    expect(result!.methods).toEqual(["P/E", "P/FCF", "P/S"]);
    expect(result!.confidence).toBe("High");
    expect(result!.bear).toBeLessThanOrEqual(result!.base);
    expect(result!.base).toBeLessThanOrEqual(result!.bull);
    expectArithmeticMidpoint(result!);
  });

  it("does not let current price change intrinsic value", () => {
    const first = calculateAutomaticIntrinsicValue("AMD", "Semiconductors", amdInput(400));
    const second = calculateAutomaticIntrinsicValue("AMD", "Semiconductors", amdInput(600));
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(second!.bear).toBe(first!.bear);
    expect(second!.base).toBe(first!.base);
    expect(second!.bull).toBe(first!.bull);
    expect(second!.baseUpsidePct).not.toBe(first!.baseUpsidePct);
  });

  it("keeps fair value available without a current quote", () => {
    const result = calculateAutomaticIntrinsicValue("AMD", "Semiconductors", amdInput(null));
    expect(result?.base).toBeGreaterThan(0);
    expect(result?.bearUpsidePct).toBeNull();
    expect(result?.baseUpsidePct).toBeNull();
    expect(result?.bullUpsidePct).toBeNull();
  });

  it("values a CRWV-like loss-making company from sparse own P/S history", () => {
    const result = calculateAutomaticIntrinsicValue("CRWV", "Software - Infrastructure", {
      price: 109,
      epsTtm: -4,
      fcfPerShareTtm: -20,
      revenuePerShareTtm: 11.8166,
      revenueGrowthTtmYoyPct: 129.93,
      revenueGrowth3yPct: 586.92,
      roicPct: -7.26,
      debtToEquity: 5.274,
      psHistory: dense(6.643, 6.747, 6.851, 2),
    });
    expect(result).not.toBeNull();
    expect(result!.methods).toEqual(["P/S"]);
    expect(result!.confidence).toBe("Low");
    expect(result!.bear).toBeLessThan(result!.base);
    expect(result!.bull).toBeGreaterThan(result!.base);
    expectArithmeticMidpoint(result!);
  });

  it("ignores an absurd percentage quality input instead of letting it dominate NBIS", () => {
    const normal = calculateAutomaticIntrinsicValue("NBIS", "Software", {
      price: 229,
      epsTtm: -1,
      fcfPerShareTtm: -26.9,
      revenuePerShareTtm: 4.8331,
      revenueGrowthTtmYoyPct: 488.15,
      revenueGrowth3yPct: 239.83,
      revenueGrowth5yPct: -29.42,
      roicPct: 0.32,
      fcfMarginPct: null,
      debtToEquity: 0.8265,
      psHistory: dense(1.297, 6.658, 52.29, 16),
    });
    const distorted = calculateAutomaticIntrinsicValue("NBIS", "Software", {
      price: 229,
      epsTtm: -1,
      fcfPerShareTtm: -26.9,
      revenuePerShareTtm: 4.8331,
      revenueGrowthTtmYoyPct: 488.15,
      revenueGrowth3yPct: 239.83,
      revenueGrowth5yPct: -29.42,
      roicPct: 0.32,
      fcfMarginPct: 3946,
      debtToEquity: 0.8265,
      psHistory: dense(1.297, 6.658, 52.29, 16),
    });
    expect(normal?.methods).toEqual(["P/S"]);
    expect(distorted?.base).toBe(normal?.base);
  });

  it("does not reward negative Debt/Equity as safer leverage", () => {
    const baseInput: AutomaticIntrinsicValueInput = {
      price: 100,
      revenuePerShareTtm: 10,
      revenueGrowth3yPct: 20,
      psHistory: dense(5, 7, 10, 20),
    };
    const unavailable = calculateAutomaticIntrinsicValue("TEST", "General", {
      ...baseInput,
      debtToEquity: null,
    });
    const negativeEquity = calculateAutomaticIntrinsicValue("TEST", "General", {
      ...baseInput,
      debtToEquity: -3,
    });
    expect(unavailable).not.toBeNull();
    expect(negativeEquity).not.toBeNull();
    expect(negativeEquity!.bear).toBe(unavailable!.bear);
    expect(negativeEquity!.base).toBe(unavailable!.base);
    expect(negativeEquity!.bull).toBe(unavailable!.bull);
  });

  it("down-weights a one-sample extreme method against a dense cross-check", () => {
    const denseOnly = calculateAutomaticIntrinsicValue("TEST", "General", {
      price: null,
      fcfPerShareTtm: 10,
      pfcfHistory: dense(10, 12, 14, 20),
    });
    const blended = calculateAutomaticIntrinsicValue("TEST", "General", {
      price: null,
      epsTtm: 10,
      fcfPerShareTtm: 10,
      peHistory: dense(100, 120, 150, 1),
      pfcfHistory: dense(10, 12, 14, 20),
    });
    expect(denseOnly).not.toBeNull();
    expect(blended).not.toBeNull();
    expect(blended!.methods).toEqual(["P/FCF", "P/E"]);
    expect(blended!.confidence).toBe("Medium");
    expect(blended!.base).toBeLessThan(denseOnly!.base * 2);
    expectArithmeticMidpoint(blended!);
  });

  it("uses P/B as the primary bank anchor with P/E as a cross-check", () => {
    const result = calculateAutomaticIntrinsicValue("JPM", "Banks - Diversified", {
      price: 300,
      epsTtm: 20,
      bookValuePerShare: 140.92,
      roeTtmPct: 17.81,
      revenueGrowth3yPct: 3.36,
      revenueGrowth5yPct: 7.73,
      peHistory: dense(8.9, 10.63, 12.8, 20),
      pbHistory: dense(1.352, 1.668, 1.958, 21),
    });
    expect(result).not.toBeNull();
    expect(result!.family).toBe("bank");
    expect(result!.methods).toEqual(["P/B", "P/E"]);
    expect(result!.confidence).toBe("High");
    expectArithmeticMidpoint(result!);
  });

  it("routes SOFI through growth-financial P/B plus P/E, without requiring P/S history", () => {
    const result = calculateAutomaticIntrinsicValue("SOFI", "Credit Services", {
      price: 20,
      epsTtm: 0.55,
      bookValuePerShare: 8.5841,
      roeTtmPct: 6.18,
      revenueGrowthTtmYoyPct: 205.5,
      revenueGrowth3yPct: 8.338,
      peHistory: dense(25, 36.13, 48, 8),
      pbHistory: dense(1.241, 1.717, 2.787, 21),
    });
    expect(result).not.toBeNull();
    expect(result!.family).toBe("growth-financial");
    expect(result!.methods).toEqual(["P/B", "P/E"]);
    expectArithmeticMidpoint(result!);
  });

  it("returns null only when no positive per-share anchor has usable own history", () => {
    expect(calculateAutomaticIntrinsicValue("CRWV", "Software", {
      price: 100,
      epsTtm: -1,
      fcfPerShareTtm: -2,
      revenuePerShareTtm: 10,
      psHistory: { p25: null, median: null, p75: null, samples: 0 },
    })).toBeNull();
  });

  it("keeps Screener distance semantics unchanged", () => {
    expect(intrinsicValueDistancePct(80, 100)).toBeCloseTo(-20);
    expect(intrinsicValueDistancePct(120, 100)).toBeCloseTo(20);
  });
});
