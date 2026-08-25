export interface FinancialGlossaryEntry {
  title: string;
  shortDescription: string;
  longDescription?: string;
  example?: string;
  relatedTerms?: readonly FinancialGlossaryTerm[];
}

export type FinancialGlossaryTerm = "marketCap" | "sma200w" | "intrinsicValue";

export const financialGlossary = Object.freeze({
  marketCap: {
    title: "Market Cap",
    shortDescription:
      "The total value of all the company's shares combined. It is a simple way to understand how large the company is.",
  },
  sma200w: {
    title: "200W SMA",
    shortDescription:
      "The average share price over roughly the last 200 weeks. It helps show the stock's very long-term trend.",
  },
  intrinsicValue: {
    title: "Intrinsic Value",
    shortDescription:
      "An estimate of what the stock may be worth based on valuation assumptions. It is not the market price and it is not a guarantee.",
  },
} satisfies Record<FinancialGlossaryTerm, FinancialGlossaryEntry>);
