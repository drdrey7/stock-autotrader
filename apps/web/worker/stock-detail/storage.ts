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
const FUNDAMENTAL_SNAPSHOT_SQL = `SELECT symbol, latest_period_end, revenue_ttm, operating_income_ttm,
  pretax_income_ttm, income_tax_ttm, net_income_ttm, diluted_eps_ttm, operating_cash_flow_ttm,
  capex_ttm, free_cash_flow_ttm, cash, short_term_investments, total_debt, shareholders_equity,
  current_assets, current_liabilities, shares_outstanding, roic_ttm, fcf_margin_ttm,
  debt_to_equity, coverage_status, blockers_json, source, updated_at
  FROM stock_fundamental_snapshots
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

export interface StockDetailFundamentalSnapshotRow {
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

export interface StockDetailStorageSnapshot {
  company: StockDetailCompanyRow | null;
  quote: LatestQuoteRow | null;
  metric: TechnicalMetricsRow | null;
  supports: SupportLevelsForSymbol | undefined;
  intrinsicValue: IntrinsicValuesForSymbol | undefined;
  weeklyRows: WeeklyPriceRow[];
  splitEvents: StockDetailSplitEventRow[];
  fundamentalSnapshot: StockDetailFundamentalSnapshotRow | null;
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

function parseFundamentalSnapshot(raw: unknown): StockDetailFundamentalSnapshotRow | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  if (typeof row.symbol !== "string") return null;
  return {
    symbol: row.symbol,
    latest_period_end: typeof row.latest_period_end === "string" ? row.latest_period_end : null,
    revenue_ttm: isFiniteNumber(row.revenue_ttm) ? row.revenue_ttm : null,
    operating_income_ttm: isFiniteNumber(row.operating_income_ttm) ? row.operating_income_ttm : null,
    pretax_income_ttm: isFiniteNumber(row.pretax_income_ttm) ? row.pretax_income_ttm : null,
    income_tax_ttm: isFiniteNumber(row.income_tax_ttm) ? row.income_tax_ttm : null,
    net_income_ttm: isFiniteNumber(row.net_income_ttm) ? row.net_income_ttm : null,
    diluted_eps_ttm: isFiniteNumber(row.diluted_eps_ttm) ? row.diluted_eps_ttm : null,
    operating_cash_flow_ttm: isFiniteNumber(row.operating_cash_flow_ttm) ? row.operating_cash_flow_ttm : null,
    capex_ttm: isFiniteNumber(row.capex_ttm) ? row.capex_ttm : null,
    free_cash_flow_ttm: isFiniteNumber(row.free_cash_flow_ttm) ? row.free_cash_flow_ttm : null,
    cash: isFiniteNumber(row.cash) ? row.cash : null,
    short_term_investments: isFiniteNumber(row.short_term_investments) ? row.short_term_investments : null,
    total_debt: isFiniteNumber(row.total_debt) ? row.total_debt : null,
    shareholders_equity: isFiniteNumber(row.shareholders_equity) ? row.shareholders_equity : null,
    current_assets: isFiniteNumber(row.current_assets) ? row.current_assets : null,
    current_liabilities: isFiniteNumber(row.current_liabilities) ? row.current_liabilities : null,
    shares_outstanding: isFiniteNumber(row.shares_outstanding) ? row.shares_outstanding : null,
    roic_ttm: isFiniteNumber(row.roic_ttm) ? row.roic_ttm : null,
    fcf_margin_ttm: isFiniteNumber(row.fcf_margin_ttm) ? row.fcf_margin_ttm : null,
    debt_to_equity: isFiniteNumber(row.debt_to_equity) ? row.debt_to_equity : null,
    coverage_status: typeof row.coverage_status === "string" ? row.coverage_status : "none",
    blockers_json: typeof row.blockers_json === "string" ? row.blockers_json : "[]",
    source: typeof row.source === "string" ? row.source : "sec-xbrl",
    updated_at: typeof row.updated_at === "string" ? row.updated_at : "",
  };
}

/**
 * Canonical Stock Detail serving read. D1 documents at most six simultaneous
 * connections per Worker invocation, while this read model needs seven
 * independent data families. `batch()` is therefore the production path: one
 * bound, symbol-scoped database call, seven sequential SELECT statements and
 * one coherent snapshot. Any D1 failure propagates and becomes a sanitized 503.
 *
 * The first statement is also the runtime membership gate. A symbol that is
 * configured statically but is not currently active in the Core universe must
 * never expose stale symbol-only quote/history/valuation rows.
 */
export async function readStockDetailStorageSnapshot(
  db: D1Database,
  symbol: string,
  historyLimit = STOCK_DETAIL_HISTORY_LIMIT,
): Promise<StockDetailStorageSnapshot> {
  const results = await db.batch([
    db.prepare(COMPANY_SQL).bind(symbol),
    db.prepare(QUOTE_SQL).bind(symbol),
    db.prepare(TECHNICAL_SQL).bind(symbol),
    db.prepare(SUPPORTS_SQL).bind(symbol),
    db.prepare(INTRINSIC_VALUE_SQL).bind(symbol),
    db.prepare(WEEKLY_HISTORY_SQL).bind(symbol, historyLimit),
    db.prepare(SPLIT_EVENTS_SQL).bind(symbol),
    db.prepare(FUNDAMENTAL_SNAPSHOT_SQL).bind(symbol),
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
    fundamentalSnapshot: parseFundamentalSnapshot(firstRow(rows[7])),
  };
}

/** Individual strict reads are retained for focused storage tests/reuse. */
export async function readStockDetailCompany(db: D1Database, symbol: string): Promise<StockDetailCompanyRow | null> {
  return parseCompany(await db.prepare(COMPANY_SQL).bind(symbol).first<StockDetailCompanyRow>());
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
