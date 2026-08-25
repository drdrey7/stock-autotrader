export interface FinancialGlossaryEntry {
  title: string;
  shortDescription: string;
  longDescription?: string;
  example?: string;
  relatedTerms?: readonly FinancialGlossaryTerm[];
}

export type FinancialGlossaryTerm =
  | "marketCap"
  | "sma200w"
  | "intrinsicValue"
  | "valuationMethods"
  | "dcf"
  | "multiples"
  | "peTtm"
  | "roic"
  | "fcfMargin"
  | "debtToEquity";

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
  valuationMethods: {
    title: "Valuation Methods",
    shortDescription:
      "Different ways to estimate what a company or its shares may be worth. Each method uses different assumptions, so the results can differ.",
  },
  dcf: {
    title: "DCF",
    shortDescription:
      "Discounted Cash Flow estimates what a company may be worth today based on the cash it could generate in the future.",
  },
  multiples: {
    title: "Multiples",
    shortDescription:
      "A valuation approach that compares the company with similar companies or its own history using ratios such as P/E.",
  },
  peTtm: {
    title: "P/E (TTM)",
    shortDescription:
      "Price-to-Earnings compares the share price with earnings from the last 12 months. It shows how much investors are paying for each dollar of profit.",
  },
  roic: {
    title: "ROIC",
    shortDescription:
      "Return on Invested Capital shows how efficiently the company turns the money invested in the business into operating profit. Higher is generally better, but comparisons should be made with similar companies.",
  },
  fcfMargin: {
    title: "FCF Margin",
    shortDescription:
      "Free Cash Flow Margin shows how much of the company's revenue remains as free cash flow after the spending needed to run and maintain the business.",
  },
  debtToEquity: {
    title: "Debt / Equity",
    shortDescription:
      "Compares the company's debt with shareholders' equity. A higher number generally means the company relies more heavily on debt financing.",
  },
} satisfies Record<FinancialGlossaryTerm, FinancialGlossaryEntry>);
