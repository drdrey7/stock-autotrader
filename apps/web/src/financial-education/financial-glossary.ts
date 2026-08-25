export interface FinancialGlossaryEntry {
  title: string;
  shortDescription: string;
  interpretation?: string;
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
  | "debtToEquity"
  | "eps"
  | "consensusEps"
  | "adjustedEps"
  | "marketEpsActual"
  | "earningsSurprise"
  | "beatMiss"
  | "gaapEps"
  | "secEdgar"
  | "secForm";

export const financialGlossary = Object.freeze({
  marketCap: {
    title: "Market Cap",
    shortDescription:
      "The total value of all the company's shares combined. Think of it as a quick way to see how big the company is in the stock market.",
    interpretation:
      "There isn't a better or worse number here — it mainly tells you the size of the company.",
  },
  sma200w: {
    title: "200W SMA",
    shortDescription:
      "The average share price over roughly the last 200 weeks. It is a simple way to look at the stock's very long-term trend.",
    interpretation:
      "Being above it usually points to a stronger long-term trend; being below it can point to a weaker one.",
  },
  intrinsicValue: {
    title: "Intrinsic Value",
    shortDescription:
      "An estimate of what the stock may be worth based on valuation assumptions. It is not the market price and it is never a guarantee.",
    interpretation:
      "If IV is above the current share price, that usually suggests potential upside. If it is below, it suggests potential downside.",
  },
  valuationMethods: {
    title: "Valuation Methods",
    shortDescription:
      "Different ways to estimate what a company or its shares may be worth. Each method looks at the business from a different angle.",
    interpretation:
      "There is no single method that is always best. It is usually more useful when different methods point to a similar range.",
  },
  dcf: {
    title: "DCF",
    shortDescription:
      "Discounted Cash Flow estimates what a company may be worth today based on the cash it could generate in the future.",
    interpretation:
      "A higher DCF value is not automatically better. What matters is how the estimate compares with the current share price and how realistic the assumptions are.",
  },
  multiples: {
    title: "Multiples",
    shortDescription:
      "A valuation approach that compares the company with similar companies or with its own history using ratios such as P/E.",
    interpretation:
      "Lower multiples can make a stock look cheaper, but cheaper is not always better. Compare companies with similar growth and businesses.",
  },
  peTtm: {
    title: "P/E (TTM)",
    shortDescription:
      "Price-to-Earnings compares the share price with the company's earnings from the last 12 months. It shows how much investors are paying for each dollar of profit.",
    interpretation:
      "A lower P/E can mean a cheaper valuation, but it is not automatically better. Fast-growing companies often trade at higher P/E ratios.",
  },
  roic: {
    title: "ROIC",
    shortDescription:
      "Return on Invested Capital shows how well the company turns the money invested in the business into operating profit.",
    interpretation:
      "Higher is generally better, especially when the company can keep a strong ROIC over time.",
  },
  fcfMargin: {
    title: "FCF Margin",
    shortDescription:
      "Free Cash Flow Margin shows how much of the company's revenue is left as free cash flow after the spending needed to run and maintain the business.",
    interpretation:
      "Higher is generally better because the company is keeping more cash from each dollar of revenue.",
  },
  debtToEquity: {
    title: "Debt / Equity",
    shortDescription:
      "Compares the company's debt with the money invested by shareholders. It gives you a quick idea of how much the business relies on debt.",
    interpretation:
      "Lower is generally safer, but normal debt levels can be very different from one industry to another.",
  },
  eps: {
    title: "EPS",
    shortDescription:
      "Earnings Per Share is the company's profit divided across its shares. It is a quick way to see how much profit belongs to each share.",
    interpretation:
      "Higher and growing EPS is generally better, especially when that growth is consistent over time.",
  },
  consensusEps: {
    title: "Consensus EPS",
    shortDescription:
      "The EPS analysts expect before the company reports. Think of it as Wall Street's shared estimate, not a promise from the company.",
    interpretation:
      "Reporting above consensus is generally positive. Reporting below it is usually seen as a miss.",
  },
  adjustedEps: {
    title: "Adjusted EPS",
    shortDescription:
      "EPS with some unusual or one-off items removed. Investors often use it to compare the latest result with analyst expectations.",
    interpretation:
      "Higher is generally better, but compare adjusted EPS with adjusted EPS — not directly with GAAP EPS.",
  },
  marketEpsActual: {
    title: "Market EPS Actual",
    shortDescription:
      "The EPS figure from our market-data provider that is used to compare the reported result with analyst estimates. It may not use the same accounting basis as GAAP EPS.",
    interpretation:
      "Above consensus is generally positive; below consensus is generally negative. Always check the accounting basis before comparing it with GAAP EPS.",
  },
  earningsSurprise: {
    title: "Surprise",
    shortDescription:
      "The percentage difference between what the company reported and what analysts expected.",
    interpretation:
      "Positive is generally better because the company beat expectations. Negative means it came in below expectations.",
  },
  beatMiss: {
    title: "Beat / Miss",
    shortDescription:
      "Beat means the reported result was above analysts' expectations. Miss means it was below. A match means it landed roughly on expectations.",
    interpretation:
      "A beat is generally better than a miss, although the stock can still move differently if guidance or other news matters more.",
  },
  gaapEps: {
    title: "GAAP EPS",
    shortDescription:
      "The official earnings per share calculated using standard U.S. accounting rules. It can differ from Adjusted EPS because adjusted results may remove some items.",
    interpretation:
      "Higher and growing GAAP EPS is generally better, but compare it with previous GAAP results rather than mixing it with adjusted EPS.",
  },
  secEdgar: {
    title: "SEC / EDGAR",
    shortDescription:
      "The SEC is the U.S. market regulator, and EDGAR is its public database of company filings. This is where the official regulatory numbers come from.",
    interpretation:
      "There is no better or worse value here — this tells you the source is an official company filing.",
  },
  secForm: {
    title: "SEC Form",
    shortDescription:
      "The type of official filing. A 10-Q is usually a quarterly report, while a 10-K is the company's detailed annual report.",
    interpretation:
      "There is no better form. The form simply tells you what kind of official report you are looking at.",
  },
} satisfies Record<FinancialGlossaryTerm, FinancialGlossaryEntry>);
