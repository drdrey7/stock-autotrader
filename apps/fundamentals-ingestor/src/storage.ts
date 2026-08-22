/**
 * D1 storage layer — writes normalized periods + snapshots.
 *
 * Reuses the same D1 database as the rest of the Stock Autotrader.
 * All writes are idempotent (UPSERT on natural key + restatement-aware).
 */

import type { CanonicalField } from "./concepts";
import type { NormalizedPeriod } from "./normalize";

export interface D1FundamentalPeriodRow {
  symbol: string;
  fiscal_year: number;
  fiscal_period: string;
  period_start: string | null;
  period_end: string | null;
  filing_date: string | null;
  form: string | null;
  accession: string | null;
  taxonomy: string | null;
  currency: string;
  revenue: number | null;
  gross_profit: number | null;
  operating_income: number | null;
  pretax_income: number | null;
  income_tax: number | null;
  net_income: number | null;
  diluted_eps: number | null;
  operating_cash_flow: number | null;
  capex: number | null;
  depreciation_amortization: number | null;
  free_cash_flow: number | null;
  cash: number | null;
  short_term_investments: number | null;
  total_debt: number | null;
  total_assets: number | null;
  total_liabilities: number | null;
  shareholders_equity: number | null;
  current_assets: number | null;
  current_liabilities: number | null;
  weighted_avg_diluted_shares: number | null;
  shares_outstanding: number | null;
  source: string;
  quality: string;
  provenance_json: string;
  updated_at: string;
}

export interface D1FundamentalSnapshotRow {
  symbol: string;
  latest_period_end: string | null;
  revenue_ttm: number | null;
  operating_income_ttm: number | null;
  pretax_income_ttm: number | null;
  income_tax_ttm: number | null;
  net_income_ttm: number | null;
  diluted_eps_ttm: number | null;
  operating_cash_flow_ttm: number | null;
  capex_ttm: number | null;
  free_cash_flow_ttm: number | null;
  cash: number | null;
  short_term_investments: number | null;
  total_debt: number | null;
  shareholders_equity: number | null;
  current_assets: number | null;
  current_liabilities: number | null;
  shares_outstanding: number | null;
  roic_ttm: number | null;
  fcf_margin_ttm: number | null;
  debt_to_equity: number | null;
  coverage_status: string;
  blockers_json: string;
  source: string;
  updated_at: string;
}

export type Database = Pick<D1Database, "prepare"> & Partial<Pick<D1Database, "batch">>;

function getField(period: NormalizedPeriod, field: CanonicalField): number | null {
  return period.fields[field]?.value ?? null;
}

/**
 * Build a D1 row from a NormalizedPeriod + derived metrics.
 */
export function periodToRow(
  period: NormalizedPeriod,
  derived: { freeCashFlow: number | null; fcfMarginPct: number | null; debtToEquity: number | null; roicPct: number | null },
  updatedAt: string,
): D1FundamentalPeriodRow {
  const provenance: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(period.fields)) {
    if (val && val.value !== null) {
      provenance[key] = {
        taxonomy: val.taxonomy,
        concept: val.concept,
        unit: val.unit,
        form: val.form,
        accession: val.accn,
        filed: val.filed,
        periodStart: val.periodStart,
        periodEnd: val.periodEnd,
        derived: val.derived,
        derivation: val.derivation ?? null,
      };
    }
  }

  return {
    symbol: period.symbol,
    fiscal_year: period.fiscalYear,
    fiscal_period: period.fiscalPeriod,
    period_start: period.periodStart,
    period_end: period.periodEnd,
    filing_date: period.filingDate,
    form: period.form,
    accession: period.accession,
    taxonomy: period.taxonomy,
    currency: period.currency,
    revenue: getField(period, "revenue"),
    gross_profit: getField(period, "gross_profit"),
    operating_income: getField(period, "operating_income"),
    pretax_income: getField(period, "pretax_income"),
    income_tax: getField(period, "income_tax"),
    net_income: getField(period, "net_income"),
    diluted_eps: getField(period, "diluted_eps"),
    operating_cash_flow: getField(period, "operating_cash_flow"),
    capex: getField(period, "capex"),
    depreciation_amortization: getField(period, "depreciation_amortization"),
    free_cash_flow: derived.freeCashFlow,
    cash: getField(period, "cash"),
    short_term_investments: getField(period, "short_term_investments"),
    total_debt: getField(period, "total_debt"),
    total_assets: getField(period, "total_assets"),
    total_liabilities: getField(period, "total_liabilities"),
    shareholders_equity: getField(period, "shareholders_equity"),
    current_assets: getField(period, "current_assets"),
    current_liabilities: getField(period, "current_liabilities"),
    weighted_avg_diluted_shares: getField(period, "weighted_avg_diluted_shares"),
    shares_outstanding: getField(period, "shares_outstanding"),
    source: "sec-xbrl",
    quality: period.missingFields.length === 0 ? "complete" : "partial",
    provenance_json: JSON.stringify(provenance),
    updated_at: updatedAt,
  };
}

/**
 * Upsert a single period row. Restatement-aware: when a new filing supersedes
 * an old one (same symbol + fiscal period, newer filed date), the new values win.
 */
export async function upsertPeriod(db: Database, row: D1FundamentalPeriodRow): Promise<void> {
  const sql = `INSERT INTO stock_fundamental_periods (
    symbol, fiscal_year, fiscal_period, period_start, period_end, filing_date,
    form, accession, taxonomy, currency, revenue, gross_profit, operating_income,
    pretax_income, income_tax, net_income, diluted_eps, operating_cash_flow,
    capex, depreciation_amortization, free_cash_flow, cash, short_term_investments,
    total_debt, total_assets, total_liabilities, shareholders_equity,
    current_assets, current_liabilities, weighted_avg_diluted_shares,
    shares_outstanding, source, quality, provenance_json, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(symbol, fiscal_year, fiscal_period) DO UPDATE SET
    period_start = excluded.period_start,
    period_end = excluded.period_end,
    filing_date = excluded.filing_date,
    form = excluded.form,
    accession = excluded.accession,
    taxonomy = excluded.taxonomy,
    currency = excluded.currency,
    revenue = excluded.revenue,
    gross_profit = excluded.gross_profit,
    operating_income = excluded.operating_income,
    pretax_income = excluded.pretax_income,
    income_tax = excluded.income_tax,
    net_income = excluded.net_income,
    diluted_eps = excluded.diluted_eps,
    operating_cash_flow = excluded.operating_cash_flow,
    capex = excluded.capex,
    depreciation_amortization = excluded.depreciation_amortization,
    free_cash_flow = excluded.free_cash_flow,
    cash = excluded.cash,
    short_term_investments = excluded.short_term_investments,
    total_debt = excluded.total_debt,
    total_assets = excluded.total_assets,
    total_liabilities = excluded.total_liabilities,
    shareholders_equity = excluded.shareholders_equity,
    current_assets = excluded.current_assets,
    current_liabilities = excluded.current_liabilities,
    weighted_avg_diluted_shares = excluded.weighted_avg_diluted_shares,
    shares_outstanding = excluded.shares_outstanding,
    source = excluded.source,
    quality = excluded.quality,
    provenance_json = excluded.provenance_json,
    updated_at = excluded.updated_at
  WHERE excluded.filing_date IS NULL OR stock_fundamental_periods.filing_date IS NULL
    OR excluded.filing_date >= stock_fundamental_periods.filing_date`;

  await db.prepare(sql).bind(
    row.symbol, row.fiscal_year, row.fiscal_period, row.period_start, row.period_end, row.filing_date,
    row.form, row.accession, row.taxonomy, row.currency, row.revenue, row.gross_profit, row.operating_income,
    row.pretax_income, row.income_tax, row.net_income, row.diluted_eps, row.operating_cash_flow,
    row.capex, row.depreciation_amortization, row.free_cash_flow, row.cash, row.short_term_investments,
    row.total_debt, row.total_assets, row.total_liabilities, row.shareholders_equity,
    row.current_assets, row.current_liabilities, row.weighted_avg_diluted_shares,
    row.shares_outstanding, row.source, row.quality, row.provenance_json, row.updated_at,
  ).run();
}

/**
 * Upsert a snapshot row (one row per symbol, always the latest).
 */
export async function upsertSnapshot(db: Database, row: D1FundamentalSnapshotRow): Promise<void> {
  const sql = `INSERT INTO stock_fundamental_snapshots (
    symbol, latest_period_end, revenue_ttm, operating_income_ttm, pretax_income_ttm,
    income_tax_ttm, net_income_ttm, diluted_eps_ttm, operating_cash_flow_ttm,
    capex_ttm, free_cash_flow_ttm, cash, short_term_investments, total_debt,
    shareholders_equity, current_assets, current_liabilities, shares_outstanding,
    roic_ttm, fcf_margin_ttm, debt_to_equity, coverage_status, blockers_json,
    source, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(symbol) DO UPDATE SET
    latest_period_end = excluded.latest_period_end,
    revenue_ttm = excluded.revenue_ttm,
    operating_income_ttm = excluded.operating_income_ttm,
    pretax_income_ttm = excluded.pretax_income_ttm,
    income_tax_ttm = excluded.income_tax_ttm,
    net_income_ttm = excluded.net_income_ttm,
    diluted_eps_ttm = excluded.diluted_eps_ttm,
    operating_cash_flow_ttm = excluded.operating_cash_flow_ttm,
    capex_ttm = excluded.capex_ttm,
    free_cash_flow_ttm = excluded.free_cash_flow_ttm,
    cash = excluded.cash,
    short_term_investments = excluded.short_term_investments,
    total_debt = excluded.total_debt,
    shareholders_equity = excluded.shareholders_equity,
    current_assets = excluded.current_assets,
    current_liabilities = excluded.current_liabilities,
    shares_outstanding = excluded.shares_outstanding,
    roic_ttm = excluded.roic_ttm,
    fcf_margin_ttm = excluded.fcf_margin_ttm,
    debt_to_equity = excluded.debt_to_equity,
    coverage_status = excluded.coverage_status,
    blockers_json = excluded.blockers_json,
    source = excluded.source,
    updated_at = excluded.updated_at`;

  await db.prepare(sql).bind(
    row.symbol, row.latest_period_end, row.revenue_ttm, row.operating_income_ttm, row.pretax_income_ttm,
    row.income_tax_ttm, row.net_income_ttm, row.diluted_eps_ttm, row.operating_cash_flow_ttm,
    row.capex_ttm, row.free_cash_flow_ttm, row.cash, row.short_term_investments, row.total_debt,
    row.shareholders_equity, row.current_assets, row.current_liabilities, row.shares_outstanding,
    row.roic_ttm, row.fcf_margin_ttm, row.debt_to_equity, row.coverage_status, row.blockers_json,
    row.source, row.updated_at,
  ).run();
}

/**
 * Read the latest snapshot for a symbol (used by Worker serving path).
 */
export async function readSnapshot(db: Database, symbol: string): Promise<D1FundamentalSnapshotRow | null> {
  const result = await db.prepare(
    "SELECT * FROM stock_fundamental_snapshots WHERE symbol = ? LIMIT 1"
  ).bind(symbol).first<D1FundamentalSnapshotRow>();
  return result;
}

/**
 * Read all periods for a symbol, ordered by fiscal year + period descending.
 */
export async function readPeriods(db: Database, symbol: string): Promise<D1FundamentalPeriodRow[]> {
  const result = await db.prepare(
    "SELECT * FROM stock_fundamental_periods WHERE symbol = ? ORDER BY fiscal_year DESC, fiscal_period DESC"
  ).bind(symbol).all<D1FundamentalPeriodRow>();
  return result.results ?? [];
}
