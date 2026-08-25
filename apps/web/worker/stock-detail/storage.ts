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
// Branch Preview is intentionally seeded only with fundamentals rows. This
// path is never selected by production, which keeps the runtime membership
// gate above authoritative for real serving traffic.
const PREVIEW_COMPANY_SQL = `SELECT symbol, symbol AS company, NULL AS logo_url, NULL AS exchange, NULL AS industry
  FROM stock_fundamentals_snapshot
  WHERE symbol = ?
  LIMIT 1`;
const QUOTE_SQL = `SELECT symbol, price, change_abs, change_pct, day_high, day_low, day_open,
  previous_close, provider, provider_timestamp, updated_at
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
const FUNDAMENTALS_SQL = `SELECT symbol, market_cap, pe_ttm, eps_ttm, shares_outstanding, revenue_ttm,
  operating_income_ttm, pretax_income_ttm, income_tax_ttm,
  operating_cash_flow_ttm, capex_ttm, free_cash_flow_ttm, cash,
  short_term_investments, total_debt, shareholders_equity, roic_pct,
  fcf_margin_pct, debt_to_equity, accounting_periods_compatible, accounting_as_of, market_as_of, market_checked_at,
  accounting_source, market_source, updated_at
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
  /** Added in migration 0025; optional here for legacy/local fixture compatibility. */
  eps_ttm?: number | null;
  /** Added in migration 0024; optional here for legacy/local fixture compatibility. */
  shares_outstanding?: number | null;
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
  return rows
    .filter((row): row is StockDetailSplitEventRow => (
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

async function getFirst<T>(db: D1Database, sql: string, ...args: unknown[]): Promise<T | null> {
  return db.prepare(sql).bind(...args).first<T>();
}

async function getAll<T>(db: D1Database, sql: string, ...args: unknown[]): Promise<T[]> {
  const result = await db.prepare(sql).bind(...args).all<T>();
  return result.results ?? [];
}

export async function readStockDetailStorageSnapshot(
  db: D1Database,
  symbol: string,
  historyLimit = STOCK_DETAIL_HISTORY_LIMIT,
  companyMode: "runtime" | "preview" = "runtime",
): Promise<StockDetailStorageSnapshot> {
  const companySql = companyMode === "preview" ? PREVIEW_COMPANY_SQL : COMPANY_SQL;
  const [companyRaw, quoteRaw, metricRaw, supportRows, intrinsicRaw, weeklyRowsRaw, splitRowsRaw, fundamentals] = await Promise.all([
    getFirst<StockDetailCompanyRow>(db, companySql, symbol),
    getFirst<LatestQuoteRow>(db, QUOTE_SQL, symbol),
    getFirst<unknown>(db, TECHNICAL_SQL, symbol),
    getAll<unknown>(db, SUPPORTS_SQL, symbol),
    getFirst<unknown>(db, INTRINSIC_VALUE_SQL, symbol),
    getAll<unknown>(db, WEEKLY_HISTORY_SQL, symbol, historyLimit),
    getAll<unknown>(db, SPLIT_EVENTS_SQL, symbol),
    getFirst<StockFundamentalsSnapshotRow>(db, FUNDAMENTALS_SQL, symbol),
  ]);

  return {
    company: parseCompany(companyRaw),
    quote: parseLatestQuote(quoteRaw),
    metric: parseTechnicalMetric(metricRaw),
    supports: parseSupports(symbol, supportRows),
    intrinsicValue: parseIntrinsicValue(symbol, intrinsicRaw),
    weeklyRows: parseWeeklyRows(weeklyRowsRaw),
    splitEvents: parseSplitEvents(splitRowsRaw),
    fundamentals,
  };
}
