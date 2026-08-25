import { describe, expect, it } from "vitest";
import { stockDetailFundamentalsSchema } from "@stock-autotrader/contracts";

const fundamentals = (priceToBook: number | null | undefined) => ({
  marketCap: "$400.0B",
  peTtm: 14,
  priceToBook,
  roicPct: null,
  fcfMarginPct: null,
  debtToEquity: null,
});

describe("Stock Detail price-to-book serving guard", () => {
  it("keeps a plausible P/B input for bank valuation", () => {
    expect(stockDetailFundamentalsSchema.parse(fundamentals(2))).toEqual({
      marketCap: "$400.0B",
      peTtm: 14,
      priceToBook: 2,
      roicPct: null,
      fcfMarginPct: null,
      debtToEquity: null,
    });
  });

  it("omits missing P/B instead of expanding the public card shape", () => {
    expect(stockDetailFundamentalsSchema.parse(fundamentals(null))).toEqual({
      marketCap: "$400.0B",
      peTtm: 14,
      roicPct: null,
      fcfMarginPct: null,
      debtToEquity: null,
    });
  });

  it("omits implausible P/B values caused by bad units or denominators", () => {
    expect(stockDetailFundamentalsSchema.parse(fundamentals(15_000_000))).toEqual({
      marketCap: "$400.0B",
      peTtm: 14,
      roicPct: null,
      fcfMarginPct: null,
      debtToEquity: null,
    });
  });
});
