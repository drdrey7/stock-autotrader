/**
 * Canonical derived-metrics formulas.
 *
 * All formulas are pure functions with explicit guards. No silent fabrication.
 * Missing inputs → null result + blocker reason.
 */

export interface TtmInputs {
  readonly revenue: number | null;
  readonly operatingIncome: number | null;
  readonly pretaxIncome: number | null;
  readonly incomeTax: number | null;
  readonly netIncome: number | null;
  readonly dilutedEps: number | null;
  readonly operatingCashFlow: number | null;
  readonly capex: number | null;
  readonly cash: number | null;
  readonly shortTermInvestments: number | null;
  readonly totalDebt: number | null;
  readonly shareholdersEquity: number | null;
  readonly sharesOutstanding: number | null;
  readonly currentAssets: number | null;
  readonly currentLiabilities: number | null;
  readonly totalAssets: number | null;
  readonly totalLiabilities: number | null;
  readonly weightedAvgDilutedShares: number | null;
}

export interface DerivedMetrics {
  readonly freeCashFlow: number | null;
  readonly fcfMarginPct: number | null;
  readonly debtToEquity: number | null;
  readonly roicPct: number | null;
  readonly blockers: string[];
}

/**
 * Free Cash Flow = Operating Cash Flow − CapEx
 * CapEx is stored as a positive magnitude (payment outflow). Guard against
 * sign errors: if capex is negative, flip to positive magnitude.
 */
export function computeFreeCashFlow(operatingCashFlow: number | null, capex: number | null): number | null {
  if (operatingCashFlow === null || capex === null) return null;
  const capexMagnitude = Math.abs(capex);
  return operatingCashFlow - capexMagnitude;
}

/**
 * FCF Margin = FCF TTM / Revenue TTM × 100
 */
export function computeFcfMarginPct(fcf: number | null, revenue: number | null): number | null {
  if (fcf === null || revenue === null || revenue === 0) return null;
  return (fcf / revenue) * 100;
}

/**
 * Debt / Equity = Total Debt / Shareholders' Equity
 * Null when equity <= 0 (meaningless or misleading ratio).
 */
export function computeDebtToEquity(totalDebt: number | null, equity: number | null): number | null {
  if (totalDebt === null || equity === null || equity <= 0) return null;
  return totalDebt / equity;
}

/**
 * ROIC = NOPAT / Average Invested Capital
 *
 * NOPAT = Operating Income × (1 − Effective Tax Rate)
 * Effective Tax Rate = Income Tax / Pretax Income
 * Invested Capital = Total Debt + Shareholders' Equity − Cash − Short-Term Investments
 *
 * Guards:
 *   - tax rate must be in [0, 1] (absent or absurd → null)
 *   - invested capital denominator must be > 0
 *   - when current + prior period balance available, use average
 */
export function computeRoicPct(inputs: {
  operatingIncome: number | null;
  pretaxIncome: number | null;
  incomeTax: number | null;
  totalDebt: number | null;
  shareholdersEquity: number | null;
  cash: number | null;
  shortTermInvestments: number | null;
  priorTotalDebt?: number | null;
  priorShareholdersEquity?: number | null;
  priorCash?: number | null;
  priorShortTermInvestments?: number | null;
}): { roicPct: number | null; blocker: string | null } {
  const {
    operatingIncome, pretaxIncome, incomeTax, totalDebt, shareholdersEquity,
    cash, shortTermInvestments,
    priorTotalDebt, priorShareholdersEquity, priorCash, priorShortTermInvestments,
  } = inputs;

  if (operatingIncome === null || pretaxIncome === null || incomeTax === null
    || totalDebt === null || shareholdersEquity === null || cash === null || shortTermInvestments === null) {
    return { roicPct: null, blocker: "missing inputs for ROIC" };
  }

  // Effective tax rate guard
  if (pretaxIncome === 0) {
    return { roicPct: null, blocker: "pretax income is zero — tax rate undefined" };
  }
  const effectiveTaxRate = incomeTax / pretaxIncome;
  if (effectiveTaxRate < 0 || effectiveTaxRate > 1) {
    return { roicPct: null, blocker: `effective tax rate out of range: ${effectiveTaxRate.toFixed(4)}` };
  }

  const nopat = operatingIncome * (1 - effectiveTaxRate);

  // Invested capital: current period
  const investedCapital = totalDebt + shareholdersEquity - cash - shortTermInvestments;

  // Average invested capital when prior period available
  let avgInvestedCapital = investedCapital;
  if (priorTotalDebt !== undefined && priorShareholdersEquity !== undefined
    && priorCash !== undefined && priorShortTermInvestments !== undefined
    && priorTotalDebt !== null && priorShareholdersEquity !== null
    && priorCash !== null && priorShortTermInvestments !== null) {
    const priorInvestedCapital = priorTotalDebt + priorShareholdersEquity - priorCash - priorShortTermInvestments;
    avgInvestedCapital = (investedCapital + priorInvestedCapital) / 2;
  }

  if (avgInvestedCapital <= 0) {
    return { roicPct: null, blocker: `invested capital <= 0: ${avgInvestedCapital}` };
  }

  return { roicPct: (nopat / avgInvestedCapital) * 100, blocker: null };
}

/**
 * Compute all derived metrics from TTM inputs in one call.
 */
export function computeDerivedMetrics(inputs: TtmInputs): DerivedMetrics {
  const blockers: string[] = [];

  const freeCashFlow = computeFreeCashFlow(inputs.operatingCashFlow, inputs.capex);
  const fcfMarginPct = computeFcfMarginPct(freeCashFlow, inputs.revenue);
  const debtToEquity = computeDebtToEquity(inputs.totalDebt, inputs.shareholdersEquity);

  const roic = computeRoicPct({
    operatingIncome: inputs.operatingIncome,
    pretaxIncome: inputs.pretaxIncome,
    incomeTax: inputs.incomeTax,
    totalDebt: inputs.totalDebt,
    shareholdersEquity: inputs.shareholdersEquity,
    cash: inputs.cash,
    shortTermInvestments: inputs.shortTermInvestments,
  });
  if (roic.blocker) blockers.push(roic.blocker);

  return {
    freeCashFlow,
    fcfMarginPct,
    debtToEquity,
    roicPct: roic.roicPct,
    blockers,
  };
}

/**
 * Market Cap = current price × shares outstanding
 * Computed in the Worker (never in the ingestor).
 */
export function computeMarketCap(price: number | null, sharesOutstanding: number | null): number | null {
  if (price === null || sharesOutstanding === null || price <= 0 || sharesOutstanding <= 0) return null;
  return price * sharesOutstanding;
}

/**
 * P/E TTM = current price / diluted EPS TTM
 * Null when EPS <= 0 (negative P/E is not shown).
 */
export function computePeTtm(price: number | null, dilutedEpsTtm: number | null): number | null {
  if (price === null || dilutedEpsTtm === null || dilutedEpsTtm <= 0) return null;
  return price / dilutedEpsTtm;
}
