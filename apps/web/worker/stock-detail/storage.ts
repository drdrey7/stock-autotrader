import {
  intrinsicValueRowSchema,
  supportLevelRowSchema,
  technicalMetricsRowSchema,
  type TechnicalMetricsRow,
} from "@stock-autotrader/contracts";
import type { IntrinsicValuesForSymbol } from "../intrinsic-values/storage";
import type { LatestQuoteRow } from "../quotes/storage";
import { ACTIVE_UNIVERSE_PREDICATE } from "../stock-universe";
import type { SupportLevelsForSymbol } from "../supports/storage";

export const STOCK_DETAIL_VISIBLE_WEEKS = 260;
export const STOCK_DETAIL_SMA_WARMUP_WEEKS = 199;
export const STOCK_DETAIL_HISTORY_LIMIT = STOCK_DETAIL_VISIBLE_WEEKS + STOCK_DETAIL_SMA_WARMUP_WEEKS;

const COMPANY_SQL = `SELECT u.symbol, u.company, u.logo_url, u.exchange, u.industry
  FROM earnings_universe AS u
  WHERE u.symbol = ? AND ${ACTIVE_UNIVERSE_PREDICATE}
  LIMIT 1`;
const PREVIEW_COMPANY_SQL = `SELECT symbol, symbol AS company, NULL AS logo_url, NULL AS exchange, NULL AS industry
  FROM stock_fundamentals_snapshot
  WHERE symbol = ?
  LIMIT 1`;
const QUOTE_SQL = `SELECT symbol, price, change_abs, change_pct, day_high, day_low, day_open,
  previous_close, provider, provider_timestamp, updated_at,
  quote_session_date, previous_close_session_date, daily_change_valid
  FROM latest_quotes
  WHERE symbol = ?
  LIMIT 1`;
const TECHNICAL_SQL = `SELECT symbol, anchor_week, completed_weeks_available, sum_199, anchor_close,
  closed_sma_200w, historical_data_as_of, calculated_at, status, source
  FROM technical_metrics
  WHERE symbol = ?
  LIMIT 1`;
const SUPPORTS_SQL = `SELECT symbol, method, level, price, as_of_date
  FROM stock_support_levels
  WHERE symbol = ? AND method = 'manual'
  ORDER BY level ASC`;
const INTRINSIC_VALUE_SQL = `SELECT symbol, method, low_value, base_value, high_value, as_of_date
  FROM stock_intrinsic_values
  WHERE symbol = ? AND method = 'manual'
  LIMIT 1`;
const WEEKLY_HISTORY_SQL = `SELECT symbol, week_end_date, raw_open, raw_high, raw_low, raw_close, volume,
  split_adjustment_factor, split_adjusted_close, source, source_fetched_at
  FROM weekly_prices
  WHERE symbol = ?
  ORDER BY week_end_date DESC
  LIMIT ?`;
const SPLIT_EVENTS_SQL = `SELECT effective_date, split_factor
  FROM split_events
  WHERE symbol = ?
  ORDER BY effective_date ASC`;
const FUNDAMENTALS_SQL = `SELECT symbol, market_cap, pe_ttm, eps_ttm, fcf_per_share_ttm,
  revenue_per_share_ttm, book_value_per_share,
  revenue_growth_ttm_yoy_pct, revenue_growth_3y_pct, revenue_growth_5y_pct, roe_ttm_pct,
  pe_5y_p25, pe_5y_median, pe_5y_p75, pe_5y_samples, pe_5y_as_of,
  pfcf_5y_p25, pfcf_5y_median, pfcf_5y_p75, pfcf_5y_samples, pfcf_5y_as_of,
  ps_5y_p25, ps_5y_median, ps_5y_p75, ps_5y_samples, ps_5y_as_of,
  pb_5y_p25, pb_5y_median, pb_5y_p75, pb_5y_samples, pb_5y_as_of,
  revenue_ttm, operating_income_ttm, pretax_income_ttm, income_tax_ttm,
  operating_cash_flow_ttm, capex_ttm, free_cash_flow_ttm, cash,
  short_term_investments, total_debt, shareholders_equity, roic_pct,
  fcf_margin_pct, debt_to_equity, accounting_periods_compatible, accounting_as_of,
  market_as_of, market_checked_at, accounting_source, market_source, updated_at
  FROM stock_fundamentals_snapshot
  WHERE symbol = ?
  LIMIT 1`;

export interface StockDetailCompanyRow {
  symbol: string;
  company: string;
  logo_url: string | null;
  exchange?: string | null;
  industry?: string | null;
}

export interface WeeklyPriceRow {
  symbol: string;
  week_end_date: string;
  raw_open: number;
  raw_high: number;
  raw_low: number;
  raw_close: number;
  volume: number;
  split_adjustment_factor: number;
  split_adjusted_close: number;
  source: string;
  source_fetched_at: string;
}

export interface StockDetailSplitEventRow {
  effective_date: string;
  split_factor: number;
}

export interface StockFundamentalsSnapshotRow {
  symbol: string;
  market_cap: number | null;
  pe_ttm: number | null;
  eps_ttm?: number | null;
  fcf_per_share_ttm?: number | null;
  revenue_per_share_ttm?: number | null;
  book_value_per_share?: number | null;
  revenue_growth_ttm_yoy_pct?: number | null;
  revenue_growth_3y_pct?: number | null;
  revenue_growth_5y_pct?: number | null;
  roe_ttm_pct?: number | null;
  pe_5y_p25?: number | null;
  pe_5y_median?: number | null;
  pe_5y_p75?: number | null;
  pe_5y_samples?: number | null;
  pe_5y_as_of?: string | null;
  pfcf_5y_p25?: number | null;
  pfcf_5y_median?: number | null;
  pfcf_5y_p75?: number | null;
  pfcf_5y_samples?: number | null;
  pfcf_5y_as_of?: string | null;
  ps_5y_p25?: number | null;
  ps_5y_median?: number | null;
  ps_5y_p75?: number | null;
  ps_5y_samples?: number | null;
  ps_5y_as_of?: string | null;
  pb_5y_p25?: number | null;
  pb_5y_median?: number | null;
  pb_5y_p75?: number | null;
  pb_5y_samples?: number | null;
  pb_5y_as_of?: string | null;
  revenue_ttm: number | null;
  operating_income_ttm: number | null;
  pretax_income_ttm: number | null;
  income_tax_ttm: number | null;
  operating_cash_flow_ttm: number | null;
  capex_ttm: number | null;
  free_cash_flow_ttm: number | null;
  cash: number | null;
  short_term_investments: number | null;
  total_debt: number | null;
  shareholders_equity: number | null;
  roic_pct: number | null;
  fcf_margin_pct: number | null;
  debt_to_equity: number | null;
  accounting_periods_compatible: number | null;
  accounting_as_of: string | null;
  market_as_of: string | null;
  market_checked_at: string | null;
  accounting_source: string;
  market_source: string;
  updated_at: string;
}

export interface StockDetailStorageSnapshot {
  company: StockDetailCompanyRow | null;
  quote: LatestQuoteRow | null;
  metric: TechnicalMetricsRow | null;
  supports: SupportLevelsForSymbol | undefined;
  intrinsicValue: IntrinsicValuesForSymbol | undefined;
  weeklyRows: WeeklyPriceRow[];
  splitEvents: StockDetailSplitEventRow[];
  fundamentals: StockFundamentalsSnapshotRow | null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function firstRow<T>(rows: readonly unknown[] | undefined): T | null {
  return (rows?.[0] as T | undefined) ?? null;
}

function parseCompany(row: StockDetailCompanyRow | null): StockDetailCompanyRow | null {
  if (!row || typeof row.company !== "string" || !row.company.trim()) return null;
  return row;
}

function parseLatestQuote(row: LatestQuoteRow | null): LatestQuoteRow | null {
  if (!row) return null;
  if (
    typeof row.symbol !== "string"
    || !isFiniteNumber(row.price) || row.price <= 0
    || !isFiniteNumber(row.change_abs)
    || !isFiniteNumber(row.change_pct)
    || typeof row.provider !== "string" || !row.provider.trim()
    || !Number.isFinite(Date.parse(row.provider_timestamp))
    || !Number.isFinite(Date.parse(row.updated_at))
    || (row.quote_session_date !== null && typeof row.quote_session_date !== "string")
    || (row.previous_close_session_date !== null && typeof row.previous_close_session_date !== "string")
    || !isFiniteNumber(row.daily_change_valid)
  ) return null;
  return row;
}

function parseTechnicalMetric(raw: unknown): TechnicalMetricsRow | null {
  if (!raw) return null;
  const parsed = technicalMetricsRowSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function parseSupports(symbol: string, rows: readonly unknown[]): SupportLevelsForSymbol | undefined {
  const levels = rows
    .map((row) => supportLevelRowSchema.safeParse(row))
    .filter((parsed) => parsed.success)
    .map((parsed) => parsed.data);
  return levels.length > 0 ? { symbol, levels } : undefined;
}

function parseIntrinsicValue(symbol: string, raw: unknown): IntrinsicValuesForSymbol | undefined {
  if (!raw) return undefined;
  const parsed = intrinsicValueRowSchema.safeParse(raw);
  return parsed.success ? { symbol, values: parsed.data } : undefined;
}

function parseWeeklyRows(rows: readonly unknown[]): WeeklyPriceRow[] {
  return rows.filter((row): row is WeeklyPriceRow => typeof row === "object" && row !== null) as WeeklyPriceRow[];
}

function parseSplitEvents(rows: readonly unknown[]): StockDetailSplitEventRow[] {
  return rows.filter((row): row is StockDetailSplitEventRow => (
    typeof row === "object"
    && row !== null
    && "effective_date" in row
    && typeof row.effective_date === "string"
    && /^\d{4}-\d{2}-\d{2}$/.test(row.effective_date)
    && "split_factor" in row
    && isFiniteNumber(row.split_factor)
    && row.split_factor > 0
  ));
}

function parseFundamentals(row: unknown): StockFundamentalsSnapshotRow | null {
  if (!row || typeof row !== "object") return null;
  const value = row as Record<string, unknown>;
  const numericFields = [
    "market_cap", "pe_ttm", "eps_ttm", "fcf_per_share_ttm", "revenue_per_share_ttm", "book_value_per_share",
    "revenue_growth_ttm_yoy_pct", "revenue_growth_3y_pct", "revenue_growth_5y_pct", "roe_ttm_pct",
    "pe_5y_p25", "pe_5y_median", "pe_5y_p75", "pe_5y_samples",
    "pfcf_5y_p25", "pfcf_5y_median", "pfcf_5y_p75", "pfcf_5y_samples",
    "ps_5y_p25", "ps_5y_median", "ps_5y_p75", "ps_5y_samples",
    "pb_5y_p25", "pb_5y_median", "pb_5y_p75", "pb_5y_samples",
    "revenue_ttm", "operating_income_ttm", "pretax_income_ttm", "income_tax_ttm",
    "operating_cash_flow_ttm", "capex_ttm", "free_cash_flow_ttm", "cash",
    "short_term_investments", "total_debt", "shareholders_equity", "roic_pct", "fcf_margin_pct",
    "debt_to_equity", "accounting_periods_compatible",
  ];
  if (typeof value.symbol !== "string" || !numericFields.every((field) => value[field] === null || value[field] === undefined || isFiniteNumber(value[field]))) return null;
  if (!["accounting_source", "market_source", "updated_at"].every((field) => typeof value[field] === "string" && value[field])) return null;
  return value as unknown as StockFundamentalsSnapshotRow;
}

/** Canonical Stock Detail D1 snapshot. Providers never run in this request path. */
export async function readStockDetailStorageSnapshot(
  db: D1Database,
  symbol: string,
  historyLimit = STOCK_DETAIL_HISTORY_LIMIT,
  environment = "production",
): Promise<StockDetailStorageSnapshot> {
  const companySql = environment === "preview" ? PREVIEW_COMPANY_SQL : COMPANY_SQL;
  const results = await db.batch([
    db.prepare(companySql).bind(symbol),
    db.prepare(QUOTE_SQL).bind(symbol),
    db.prepare(TECHNICAL_SQL).bind(symbol),
    db.prepare(SUPPORTS_SQL).bind(symbol),
    db.prepare(INTRINSIC_VALUE_SQL).bind(symbol),
    db.prepare(WEEKLY_HISTORY_SQL).bind(symbol, historyLimit),
    db.prepare(SPLIT_EVENTS_SQL).bind(symbol),
    db.prepare(FUNDAMENTALS_SQL).bind(symbol),
  ]);

  const rows = results.map((result) => (result.results ?? []) as unknown[]);
  const company = parseCompany(firstRow<StockDetailCompanyRow>(rows[0]));
  if (!company) throw new Error("stock_not_found");

  return {
    company,
    quote: parseLatestQuote(firstRow<LatestQuoteRow>(rows[1])),
    metric: parseTechnicalMetric(firstRow(rows[2])),
    supports: parseSupports(symbol, rows[3] ?? []),
    intrinsicValue: parseIntrinsicValue(symbol, firstRow(rows[4])),
    weeklyRows: parseWeeklyRows(rows[5] ?? []),
    splitEvents: parseSplitEvents(rows[6] ?? []),
    fundamentals: parseFundamentals(firstRow(rows[7])),
  };
}

/** Individual strict reads are retained for focused storage tests/reuse. */
export async function readStockDetailCompany(db: D1Database, symbol: string, environment = "production"): Promise<StockDetailCompanyRow | null> {
  const companySql = environment === "preview" ? PREVIEW_COMPANY_SQL : COMPANY_SQL;
  return parseCompany(await db.prepare(companySql).bind(symbol).first<StockDetailCompanyRow>());
}

export async function readStockDetailQuote(db: D1Database, symbol: string): Promise<LatestQuoteRow | null> {
  return parseLatestQuote(await db.prepare(QUOTE_SQL).bind(symbol).first<LatestQuoteRow>());
}

export async function readStockDetailTechnicalMetric(db: D1Database, symbol: string): Promise<TechnicalMetricsRow | null> {
  return parseTechnicalMetric(await db.prepare(TECHNICAL_SQL).bind(symbol).first());
}

export async function readStockDetailSupports(db: D1Database, symbol: string): Promise<SupportLevelsForSymbol | undefined> {
  const result = await db.prepare(SUPPORTS_SQL).bind(symbol).all();
  return parseSupports(symbol, result.results ?? []);
}

export async function readStockDetailIntrinsicValue(db: D1Database, symbol: string): Promise<IntrinsicValuesForSymbol | undefined> {
  const raw = await db.prepare(INTRINSIC_VALUE_SQL).bind(symbol).first();
  return parseIntrinsicValue(symbol, raw);
}

export async function readStockDetailWeeklyHistory(
  db: D1Database,
  symbol: string,
  limit = STOCK_DETAIL_HISTORY_LIMIT,
): Promise<WeeklyPriceRow[]> {
  const result = await db.prepare(WEEKLY_HISTORY_SQL).bind(symbol, limit).all<WeeklyPriceRow>();
  return result.results ?? [];
}

export async function readStockDetailSplitEvents(db: D1Database, symbol: string): Promise<StockDetailSplitEventRow[]> {
  const result = await db.prepare(SPLIT_EVENTS_SQL).bind(symbol).all<StockDetailSplitEventRow>();
  return parseSplitEvents(result.results ?? []);
}
