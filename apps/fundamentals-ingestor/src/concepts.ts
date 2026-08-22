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
 *
 * Taxonomy priority for mixed filers (e.g. foreign issuers with both
 * us-gaap and ifrs-full facts): the FIRST taxonomy in the list that has
 * a matching fact wins. This avoids mixing GAAP and IFRS concepts.
 */

export type Taxonomy = "us-gaap" | "ifrs-full" | "dei";
export type Duration = "instant" | "duration";

export interface ConceptMapping {
  readonly taxonomy: Taxonomy;
  readonly concept: string;
  readonly unit: string;
  readonly duration: Duration;
  readonly priority: number; // lower = preferred
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
 *
 * Priority order reflects the most common / most specific concept first.
 * Fallback concepts are only tried when the primary has no match.
 * Concepts are NEVER mixed in one decision — two concepts for the same
 * period with different values = CONFLICT → null.
 */
export const CONCEPT_MAPPINGS: Readonly<Record<CanonicalField, readonly ConceptMapping[]>> = {
  revenue: [
    // US GAAP
    { taxonomy: "us-gaap", concept: "RevenueFromContractWithCustomerExcludingAssessedTax", unit: "USD", duration: "duration", priority: 0 },
    { taxonomy: "us-gaap", concept: "RevenueFromContractWithCustomerIncludingAssessedTax", unit: "USD", duration: "duration", priority: 1 },
    { taxonomy: "us-gaap", concept: "Revenues", unit: "USD", duration: "duration", priority: 2 },
    { taxonomy: "us-gaap", concept: "SalesRevenueNet", unit: "USD", duration: "duration", priority: 3 },
    { taxonomy: "us-gaap", concept: "SalesRevenueGoodsNet", unit: "USD", duration: "duration", priority: 4 },
    { taxonomy: "us-gaap", concept: "SalesRevenueServicesNet", unit: "USD", duration: "duration", priority: 5 },
    { taxonomy: "us-gaap", concept: "RevenueNet", unit: "USD", duration: "duration", priority: 6 },
    // IFRS
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
    { taxonomy: "ifrs-full", concept: "OperatingProfit", unit: "USD", duration: "duration", priority: 11 },
  ],
  pretax_income: [
    { taxonomy: "us-gaap", concept: "IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest", unit: "USD", duration: "duration", priority: 0 },
    { taxonomy: "us-gaap", concept: "IncomeLossFromContinuingOperationsBeforeIncomeTaxes", unit: "USD", duration: "duration", priority: 1 },
    { taxonomy: "ifrs-full", concept: "ProfitLossBeforeTax", unit: "USD", duration: "duration", priority: 10 },
  ],
  income_tax: [
    { taxonomy: "us-gaap", concept: "IncomeTaxExpenseBenefit", unit: "USD", duration: "duration", priority: 0 },
    { taxonomy: "ifrs-full", concept: "IncomeTaxExpenseIncomeTaxExpenseCredit", unit: "USD", duration: "duration", priority: 10 },
    { taxonomy: "ifrs-full", concept: "TaxExpenseTaxIncomeExpenseCredit", unit: "USD", duration: "duration", priority: 11 },
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
    { taxonomy: "us-gaap", concept: "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations", unit: "USD", duration: "duration", priority: 1 },
    { taxonomy: "ifrs-full", concept: "CashFlowsFromUsedInOperatingActivities", unit: "USD", duration: "duration", priority: 10 },
  ],
  capex: [
    { taxonomy: "us-gaap", concept: "PaymentsToAcquirePropertyPlantAndEquipment", unit: "USD", duration: "duration", priority: 0 },
    { taxonomy: "us-gaap", concept: "PaymentsToAcquireProductiveAssets", unit: "USD", duration: "duration", priority: 1 },
    { taxonomy: "ifrs-full", concept: "PaymentsToAcquirePropertyPlantAndEquipment", unit: "USD", duration: "duration", priority: 10 },
    { taxonomy: "ifrs-full", concept: "PurchaseOfPropertyPlantAndEquipment", unit: "USD", duration: "duration", priority: 11 },
  ],
  depreciation_amortization: [
    { taxonomy: "us-gaap", concept: "DepreciationDepletionAndAmortization", unit: "USD", duration: "duration", priority: 0 },
    { taxonomy: "us-gaap", concept: "DepreciationAmortizationAndAccretionNet", unit: "USD", duration: "duration", priority: 1 },
    { taxonomy: "us-gaap", concept: "DepreciationAndAmortization", unit: "USD", duration: "duration", priority: 2 },
    { taxonomy: "ifrs-full", concept: "DepreciationAndAmortisationExpense", unit: "USD", duration: "duration", priority: 10 },
  ],
  cash: [
    { taxonomy: "us-gaap", concept: "CashAndCashEquivalentsAtCarryingValue", unit: "USD", duration: "instant", priority: 0 },
    { taxonomy: "us-gaap", concept: "CashCashEquivalentsAndShortTermInvestments", unit: "USD", duration: "instant", priority: 1 },
    { taxonomy: "ifrs-full", concept: "CashAndCashEquivalents", unit: "USD", duration: "instant", priority: 10 },
  ],
  short_term_investments: [
    { taxonomy: "us-gaap", concept: "ShortTermInvestments", unit: "USD", duration: "instant", priority: 0 },
    { taxonomy: "us-gaap", concept: "MarketableSecuritiesCurrent", unit: "USD", duration: "instant", priority: 1 },
    { taxonomy: "us-gaap", concept: "AvailableForSaleSecuritiesCurrent", unit: "USD", duration: "instant", priority: 2 },
    { taxonomy: "ifrs-full", concept: "CurrentFinancialAssetsAtFairValueThroughProfitOrLoss", unit: "USD", duration: "instant", priority: 10 },
  ],
  total_debt: [
    { taxonomy: "us-gaap", concept: "LongTermDebt", unit: "USD", duration: "instant", priority: 0 },
    { taxonomy: "us-gaap", concept: "LongTermDebtAndCapitalLeaseObligations", unit: "USD", duration: "instant", priority: 1 },
    { taxonomy: "us-gaap", concept: "DebtLongtermAndShorttermCombinedAmount", unit: "USD", duration: "instant", priority: 2 },
    { taxonomy: "ifrs-full", concept: "Borrowings", unit: "USD", duration: "instant", priority: 10 },
    { taxonomy: "ifrs-full", concept: "Debt", unit: "USD", duration: "instant", priority: 11 },
  ],
  total_assets: [
    { taxonomy: "us-gaap", concept: "Assets", unit: "USD", duration: "instant", priority: 0 },
    { taxonomy: "ifrs-full", concept: "Assets", unit: "USD", duration: "instant", priority: 10 },
  ],
  total_liabilities: [
    { taxonomy: "us-gaap", concept: "Liabilities", unit: "USD", duration: "instant", priority: 0 },
    { taxonomy: "us-gaap", concept: "LiabilitiesAndStockholdersEquity", unit: "USD", duration: "instant", priority: 1 },
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
    { taxonomy: "us-gaap", concept: "CommonStockSharesOutstanding", unit: "shares", duration: "instant", priority: 0 },
    { taxonomy: "us-gaap", concept: "EntityCommonStockSharesOutstanding", unit: "shares", duration: "instant", priority: 1 },
    { taxonomy: "us-gaap", concept: "WeightedAverageNumberOfSharesOutstandingBasic", unit: "shares", duration: "duration", priority: 2 },
    { taxonomy: "dei", concept: "EntityCommonStockSharesOutstanding", unit: "shares", duration: "instant", priority: 3 },
    { taxonomy: "ifrs-full", concept: "NumberOfSharesOutstanding", unit: "shares", duration: "instant", priority: 10 },
  ],
};

export const ALL_CANONICAL_FIELDS = Object.keys(CONCEPT_MAPPINGS) as CanonicalField[];
