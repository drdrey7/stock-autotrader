/**
 * Canonical fundamentals field definitions.
 *
 * Each canonical metric maps to one or more (taxonomy, concept, unit) triples,
 * tried in priority order. A field is only resolved when ALL of these hold:
 *   - concept matches one of the accepted XBRL concepts
 *   - unit matches exactly
 *   - fiscal identity is provably comparable
 *   - the fact comes from an accepted form
 *   - no conflicting values exist for the same period/context
 * Anything less → null. Never guess.
 */

export type Taxonomy = "us-gaap" | "ifrs-full" | "dei";
export type Duration = "instant" | "duration";

export interface ConceptMapping {
  readonly taxonomy: Taxonomy;
  readonly concept: string;
  readonly unit: string;
  readonly duration: Duration;
  readonly priority: number;
}

export type CanonicalField =
  | "revenue"
  | "gross_profit"
  | "operating_income"
  | "pretax_income"
  | "income_tax"
  | "net_income"
  | "diluted_eps"
  | "operating_cash_flow"
  | "capex"
  | "depreciation_amortization"
  | "cash"
  | "short_term_investments"
  | "total_debt"
  | "total_assets"
  | "total_liabilities"
  | "shareholders_equity"
  | "current_assets"
  | "current_liabilities"
  | "weighted_avg_diluted_shares"
  | "shares_outstanding";

/**
 * Ordered concept mappings per canonical field.
 */
export const CONCEPT_MAPPINGS: Readonly<Record<CanonicalField, readonly ConceptMapping[]>> = {
  revenue: [
    { taxonomy: "us-gaap", concept: "RevenueFromContractWithCustomerExcludingAssessedTax", unit: "USD", duration: "duration", priority: 0 },
    { taxonomy: "us-gaap", concept: "RevenueFromContractWithCustomerIncludingAssessedTax", unit: "USD", duration: "duration", priority: 1 },
    { taxonomy: "us-gaap", concept: "Revenues", unit: "USD", duration: "duration", priority: 2 },
    { taxonomy: "us-gaap", concept: "SalesRevenueNet", unit: "USD", duration: "duration", priority: 3 },
    { taxonomy: "ifrs-full", concept: "Revenue", unit: "USD", duration: "duration", priority: 10 },
    { taxonomy: "ifrs-full", concept: "RevenueFromContractsWithCustomers", unit: "USD", duration: "duration", priority: 11 },
  ],
  gross_profit: [
    { taxonomy: "us-gaap", concept: "GrossProfit", unit: "USD", duration: "duration", priority: 0 },
    { taxonomy: "ifrs-full", concept: "GrossProfit", unit: "USD", duration: "duration", priority: 10 },
  ],
  operating_income: [
    { taxonomy: "us-gaap", concept: "OperatingIncomeLoss", unit: "USD", duration: "duration", priority: 0 },
    { taxonomy: "ifrs-full", concept: "ProfitLossFromOperatingActivities", unit: "USD", duration: "duration", priority: 10 },
  ],
  pretax_income: [
    { taxonomy: "us-gaap", concept: "IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest", unit: "USD", duration: "duration", priority: 0 },
    { taxonomy: "us-gaap", concept: "IncomeLossFromContinuingOperationsBeforeIncomeTaxes", unit: "USD", duration: "duration", priority: 1 },
    { taxonomy: "ifrs-full", concept: "ProfitLossBeforeTax", unit: "USD", duration: "duration", priority: 10 },
  ],
  income_tax: [
    { taxonomy: "us-gaap", concept: "IncomeTaxExpenseBenefit", unit: "USD", duration: "duration", priority: 0 },
    { taxonomy: "ifrs-full", concept: "IncomeTaxExpenseIncomeTaxExpenseCredit", unit: "USD", duration: "duration", priority: 10 },
  ],
  net_income: [
    { taxonomy: "us-gaap", concept: "NetIncomeLoss", unit: "USD", duration: "duration", priority: 0 },
    { taxonomy: "us-gaap", concept: "ProfitLoss", unit: "USD", duration: "duration", priority: 1 },
    { taxonomy: "ifrs-full", concept: "ProfitLoss", unit: "USD", duration: "duration", priority: 10 },
  ],
  diluted_eps: [
    { taxonomy: "us-gaap", concept: "EarningsPerShareDiluted", unit: "USD/shares", duration: "duration", priority: 0 },
    { taxonomy: "ifrs-full", concept: "DilutedEarningsLossPerShare", unit: "USD/shares", duration: "duration", priority: 10 },
  ],
  operating_cash_flow: [
    { taxonomy: "us-gaap", concept: "NetCashProvidedByUsedInOperatingActivities", unit: "USD", duration: "duration", priority: 0 },
    { taxonomy: "ifrs-full", concept: "CashFlowsFromUsedInOperatingActivities", unit: "USD", duration: "duration", priority: 10 },
  ],
  capex: [
    { taxonomy: "us-gaap", concept: "PaymentsToAcquirePropertyPlantAndEquipment", unit: "USD", duration: "duration", priority: 0 },
    { taxonomy: "us-gaap", concept: "PaymentsToAcquireProductiveAssets", unit: "USD", duration: "duration", priority: 1 },
    { taxonomy: "ifrs-full", concept: "PaymentsToAcquirePropertyPlantAndEquipment", unit: "USD", duration: "duration", priority: 10 },
  ],
  depreciation_amortization: [
    { taxonomy: "us-gaap", concept: "DepreciationDepletionAndAmortization", unit: "USD", duration: "duration", priority: 0 },
    { taxonomy: "ifrs-full", concept: "DepreciationAndAmortisationExpense", unit: "USD", duration: "duration", priority: 10 },
  ],
  cash: [
    { taxonomy: "us-gaap", concept: "CashAndCashEquivalentsAtCarryingValue", unit: "USD", duration: "instant", priority: 0 },
    { taxonomy: "ifrs-full", concept: "CashAndCashEquivalents", unit: "USD", duration: "instant", priority: 10 },
  ],
  short_term_investments: [
    { taxonomy: "us-gaap", concept: "ShortTermInvestments", unit: "USD", duration: "instant", priority: 0 },
    { taxonomy: "us-gaap", concept: "MarketableSecuritiesCurrent", unit: "USD", duration: "instant", priority: 1 },
    { taxonomy: "ifrs-full", concept: "CurrentFinancialAssetsAtFairValueThroughProfitOrLoss", unit: "USD", duration: "instant", priority: 10 },
  ],
  total_debt: [
    // Prefer combined debt (short + long) when available
    { taxonomy: "us-gaap", concept: "DebtLongtermAndShorttermCombinedAmount", unit: "USD", duration: "instant", priority: 0 },
    { taxonomy: "us-gaap", concept: "LongTermDebtAndCapitalLeaseObligations", unit: "USD", duration: "instant", priority: 1 },
    { taxonomy: "us-gaap", concept: "LongTermDebt", unit: "USD", duration: "instant", priority: 2 },
    { taxonomy: "ifrs-full", concept: "Borrowings", unit: "USD", duration: "instant", priority: 10 },
    { taxonomy: "ifrs-full", concept: "Debt", unit: "USD", duration: "instant", priority: 11 },
  ],
  total_assets: [
    { taxonomy: "us-gaap", concept: "Assets", unit: "USD", duration: "instant", priority: 0 },
    { taxonomy: "ifrs-full", concept: "Assets", unit: "USD", duration: "instant", priority: 10 },
  ],
  total_liabilities: [
    { taxonomy: "us-gaap", concept: "Liabilities", unit: "USD", duration: "instant", priority: 0 },
    { taxonomy: "ifrs-full", concept: "Liabilities", unit: "USD", duration: "instant", priority: 10 },
  ],
  shareholders_equity: [
    { taxonomy: "us-gaap", concept: "StockholdersEquity", unit: "USD", duration: "instant", priority: 0 },
    { taxonomy: "us-gaap", concept: "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest", unit: "USD", duration: "instant", priority: 1 },
    { taxonomy: "us-gaap", concept: "Equity", unit: "USD", duration: "instant", priority: 2 },
    { taxonomy: "ifrs-full", concept: "Equity", unit: "USD", duration: "instant", priority: 10 },
    { taxonomy: "ifrs-full", concept: "EquityAttributableToOwnersOfParent", unit: "USD", duration: "instant", priority: 11 },
  ],
  current_assets: [
    { taxonomy: "us-gaap", concept: "AssetsCurrent", unit: "USD", duration: "instant", priority: 0 },
    { taxonomy: "ifrs-full", concept: "CurrentAssets", unit: "USD", duration: "instant", priority: 10 },
  ],
  current_liabilities: [
    { taxonomy: "us-gaap", concept: "LiabilitiesCurrent", unit: "USD", duration: "instant", priority: 0 },
    { taxonomy: "ifrs-full", concept: "CurrentLiabilities", unit: "USD", duration: "instant", priority: 10 },
  ],
  weighted_avg_diluted_shares: [
    { taxonomy: "us-gaap", concept: "WeightedAverageNumberOfDilutedSharesOutstanding", unit: "shares", duration: "duration", priority: 0 },
    { taxonomy: "us-gaap", concept: "WeightedAverageNumberOfSharesOutstandingDiluted", unit: "shares", duration: "duration", priority: 1 },
    { taxonomy: "ifrs-full", concept: "WeightedAverageNumberOfOrdinarySharesOutstandingDiluted", unit: "shares", duration: "duration", priority: 10 },
  ],
  shares_outstanding: [
    // Point-in-time shares (preferred for Market Cap)
    { taxonomy: "us-gaap", concept: "CommonStockSharesOutstanding", unit: "shares", duration: "instant", priority: 0 },
    { taxonomy: "us-gaap", concept: "EntityCommonStockSharesOutstanding", unit: "shares", duration: "instant", priority: 1 },
    { taxonomy: "dei", concept: "EntityCommonStockSharesOutstanding", unit: "shares", duration: "instant", priority: 2 },
    { taxonomy: "ifrs-full", concept: "NumberOfSharesOutstanding", unit: "shares", duration: "instant", priority: 3 },
  ],
};

export const ALL_CANONICAL_FIELDS = Object.keys(CONCEPT_MAPPINGS) as CanonicalField[];

/**
 * Companyfacts uses the reporting currency as the XBRL unit for IFRS
 * monetary facts.  The mapping keeps USD as its canonical family name, but
 * foreign issuers must be allowed to retain their own currency (EUR, DKK,
 * TWD, ...); no FX conversion is safe without an explicitly sourced rate.
 */
export function isReportingCurrencyUnit(unit: string | null): boolean {
  return unit !== null && /^[A-Z]{3}$/.test(unit);
}

export function currencyFromUnit(unit: string | null): string | null {
  if (isReportingCurrencyUnit(unit)) return unit;
  const perShare = unit?.match(/^([A-Z]{3})\/shares$/);
  return perShare?.[1] ?? null;
}

/** Match a fact unit while keeping the source taxonomy and actual currency. */
export function unitMatchesMapping(mapping: ConceptMapping, unit: string | null): boolean {
  if (unit === mapping.unit) return true;
  if (unit === null) return false;
  if (mapping.unit === "USD") return isReportingCurrencyUnit(unit);
  if (mapping.unit === "USD/shares") return /^[A-Z]{3}\/shares$/.test(unit);
  return false;
}
