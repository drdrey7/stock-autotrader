import {
  stockDetailApiResponseSchema,
  type StockDetailApiResponse,
  type StockDetailLinePoint,
  type StockDetailPricePoint,
} from "@stock-autotrader/contracts";
import {
  computeLiveSma200w,
  type QuoteHistoryScaleState,
  type QuoteInput,
} from "../sma/metrics";
import { isoWeekOfDateKey, weekDiffDays } from "../sma/weeks";
import {
  automaticIntrinsicValueForScreener,
  calculateAutomaticIntrinsicValueFromPersistedFundamentals,
} from "../intrinsic-values/automatic";
import { buildIntrinsicValue, buildSupportLevels } from "../stocks/derived";
import { deriveDailyChange } from "../quotes/daily-change";
import { nyDateKeyOf, quoteState, quotesMarketState } from "../quotes/freshness";
import type { Env } from "../index";
import {
  readStockDetailStorageSnapshot,
  STOCK_DETAIL_HISTORY_LIMIT,
  STOCK_DETAIL_VISIBLE_WEEKS,
  type StockDetailSplitEventRow,
  type StockDetailStorageSnapshot,
  type WeeklyPriceRow,
  clearQuoteHistoryScaleMismatch,
  persistSplitScaleMismatch,
} from "./storage";

const SMA_WINDOW_WEEKS = 200;
const CLOSE_CROSSCHECK_RELATIVE_TOLERANCE = 1e-6;
const CLOSE_CROSSCHECK_ABSOLUTE_TOLERANCE = 1e-8;
const FINNHUB_BASIC_FINANCIALS_SOURCE = "finnhub-basic-financials";
// Include common forward and reverse ratios, while requiring independent
// quote/history agreement below so ordinary price moves never qualify.
const STRUCTURAL_SPLIT_FACTORS = [
  0.1, 0.2, 0.25, 1 / 3, 0.5, 2 / 3, 0.75, 0.8,
  1.2, 1.25, 4 / 3, 1.5, 2, 3, 4, 5, 10,
] as const;
const STRUCTURAL_SPLIT_TOLERANCE = 0.005;
const STRUCTURAL_REGIME_TOLERANCE = 0.25;
// The latest completed week must align tightly with the quote transition. The
// preceding week only corroborates that the old scale persisted, so allow an
// ordinary weekly move while still rejecting the larger move in the explicit
// false-positive regression test.
const STRUCTURAL_PRIOR_HISTORY_TOLERANCE = 0.1;
// A quote already normalized by its provider can only be compared with the
// last two weekly closes when both sources are nearly on the same conventional
// ratio. Keep this narrow: a sustained ordinary 20% rally must not become a
// split verification request merely because 1.2 is a common ratio.
const STRUCTURAL_QUOTE_HISTORY_TOLERANCE = 0.05;
const STRUCTURAL_HISTORY_MAX_AGE_DAYS = 14;
export const FUNDAMENTALS_MARKET_STALE_AFTER_SECONDS = 3 * 24 * 60 * 60;

function isClearlyNonNearOneSplitFactor(factor: number): boolean {
  // A quote/history ratio near 1x is not independently distinguishable from
  // a normal market move. It may still be detected from a persisted OHLC
  // before/after regime transition, where all four fields provide stronger
  // evidence.
  return factor <= 0.5 || factor >= 2;
}

interface AdjustedClosePoint {
  time: string;
  close: number;
}

function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function hasValidRawOhlc(row: WeeklyPriceRow): boolean {
  const { raw_open: open, raw_high: high, raw_low: low, raw_close: close } = row;
  return [open, high, low, close].every(isPositiveFinite)
    && high >= Math.max(open, low, close)
    && low <= Math.min(open, high, close);
}

function closeMatchesPersistedAdjustment(calculated: number, persisted: number): boolean {
  if (!isPositiveFinite(persisted)) return false;
  const tolerance = Math.max(
    CLOSE_CROSSCHECK_ABSOLUTE_TOLERANCE,
    Math.abs(persisted) * CLOSE_CROSSCHECK_RELATIVE_TOLERANCE,
  );
  return Math.abs(calculated - persisted) <= tolerance;
}

function toSplitAdjustedClosePoint(row: WeeklyPriceRow): AdjustedClosePoint | null {
  const factor = row.split_adjustment_factor;
  if (
    !isoWeekOfDateKey(row.week_end_date)
    || !isPositiveFinite(factor)
    || !isPositiveFinite(row.raw_close)
  ) return null;
  const close = row.raw_close / factor;
  if (!isPositiveFinite(close) || !closeMatchesPersistedAdjustment(close, row.split_adjusted_close)) return null;
  return { time: row.week_end_date, close };
}

/** Convert one raw weekly row to today's split-adjusted scale. */
export function toSplitAdjustedPricePoint(row: WeeklyPriceRow): StockDetailPricePoint | null {
  const closePoint = toSplitAdjustedClosePoint(row);
  const factor = row.split_adjustment_factor;
  if (
    !closePoint
    || !hasValidRawOhlc(row)
    || !Number.isInteger(row.volume)
    || row.volume < 0
  ) return null;

  const open = row.raw_open / factor;
  const high = row.raw_high / factor;
  const low = row.raw_low / factor;
  if (![open, high, low].every(isPositiveFinite)) return null;
  return { time: row.week_end_date, open, high, low, close: closePoint.close, volume: row.volume };
}

function consecutiveIsoWeeks(previousTime: string, currentTime: string): boolean {
  const previousWeek = isoWeekOfDateKey(previousTime);
  const currentWeek = isoWeekOfDateKey(currentTime);
  return previousWeek !== null && currentWeek !== null && weekDiffDays(currentWeek, previousWeek) === 7;
}

function structuralScaleBetween(older: WeeklyPriceRow, newer: WeeklyPriceRow): number | null {
  if (!hasValidRawOhlc(older) || !hasValidRawOhlc(newer)) return null;
  const ratios = [
    older.raw_open / newer.raw_open,
    older.raw_high / newer.raw_high,
    older.raw_low / newer.raw_low,
    older.raw_close / newer.raw_close,
  ];
  const scale = ratios[0]!;
  if (!isPositiveFinite(scale)) return null;
  if (ratios.slice(1).some((ratio) => !isPositiveFinite(ratio)
    || Math.abs(ratio / scale - 1) > STRUCTURAL_SPLIT_TOLERANCE)) return null;
  if (scale > 0.8 && scale < 1.25) return null;
  return scale;
}

/**
 * Detect a legacy mixed raw regime without treating a single price move as a
 * split. The four OHLC fields must agree on a conventional scale transition,
 * and the newer scale must persist into the following completed week. This is
 * intentionally independent of the quote so rollout can fail closed before a
 * provider reconciliation has made split_events durable.
 */
export function hasUnexplainedHistoricalScaleTransition(
  weeklyRows: readonly WeeklyPriceRow[],
): boolean {
  const chronological = [...weeklyRows]
    .filter((row) => (
      isoWeekOfDateKey(row.week_end_date) !== null
      && approximatelyEqual(row.split_adjustment_factor, 1)
      && closeMatchesPersistedAdjustment(row.raw_close, row.split_adjusted_close)
    ))
    .sort((left, right) => left.week_end_date.localeCompare(right.week_end_date));
  for (let index = 0; index + 2 < chronological.length; index += 1) {
    const older = chronological[index]!;
    const newer = chronological[index + 1]!;
    const witness = chronological[index + 2]!;
    if (
      !consecutiveIsoWeeks(older.week_end_date, newer.week_end_date)
      || !consecutiveIsoWeeks(newer.week_end_date, witness.week_end_date)
    ) continue;
    const scale = structuralScaleBetween(older, newer);
    if (scale === null) continue;
    const witnessRatio = older.raw_close / witness.raw_close;
    if (isPositiveFinite(witnessRatio)
      && Math.abs(witnessRatio / scale - 1) <= STRUCTURAL_REGIME_TOLERANCE) return true;
  }
  return false;
}

/** O(n) rolling 200-week SMA over completed split-adjusted weekly closes. */
export function buildHistoricalSma200w(
  history: readonly AdjustedClosePoint[],
  visibleStartIndex = 0,
): StockDetailLinePoint[] {
  if (history.length < SMA_WINDOW_WEEKS) return [];
  const points: StockDetailLinePoint[] = [];
  let runningSum = 0;
  let contiguousRunStart = 0;

  for (let index = 0; index < history.length; index += 1) {
    const current = history[index]!;
    if (index === 0 || !consecutiveIsoWeeks(history[index - 1]!.time, current.time)) {
      runningSum = current.close;
      contiguousRunStart = index;
    } else {
      runningSum += current.close;
    }
    const contiguousWeeks = index - contiguousRunStart + 1;
    if (contiguousWeeks > SMA_WINDOW_WEEKS) runningSum -= history[index - SMA_WINDOW_WEEKS]!.close;
    if (contiguousWeeks >= SMA_WINDOW_WEEKS && index >= visibleStartIndex) {
      points.push({ time: current.time, value: runningSum / SMA_WINDOW_WEEKS });
    }
  }
  return points;
}

function weekIdentity(dateKey: string): string | null {
  const week = isoWeekOfDateKey(dateKey);
  return week ? `${week.year}-W${week.week}` : null;
}

function toValidChronologicalCloseHistory(rowsNewestFirst: readonly WeeklyPriceRow[]): AdjustedClosePoint[] {
  const chronological: AdjustedClosePoint[] = [];
  for (const row of [...rowsNewestFirst].reverse()) {
    const adjusted = toSplitAdjustedClosePoint(row);
    if (adjusted) chronological.push(adjusted);
  }
  return chronological;
}

function toValidChronologicalCandles(
  rowsNewestFirst: readonly WeeklyPriceRow[],
  splitWeeks: ReadonlySet<string>,
): StockDetailPricePoint[] {
  const chronological: StockDetailPricePoint[] = [];
  for (const row of [...rowsNewestFirst].reverse()) {
    const rowWeek = weekIdentity(row.week_end_date);
    if (rowWeek && splitWeeks.has(rowWeek)) continue;
    const adjusted = toSplitAdjustedPricePoint(row);
    if (adjusted) chronological.push(adjusted);
  }
  return chronological;
}

function approximatelyEqual(left: number, right: number): boolean {
  const tolerance = Math.max(1e-8, Math.abs(right) * 1e-6);
  return Math.abs(left - right) <= tolerance;
}

function approximatelyWithin(value: number, target: number, relativeTolerance: number): boolean {
  return isPositiveFinite(value)
    && isPositiveFinite(target)
    && Math.abs(value / target - 1) <= relativeTolerance;
}

function marketFundamentalsAreFresh(
  fundamentals: StockDetailStorageSnapshot["fundamentals"],
  now: Date,
): boolean {
  if (!fundamentals) return false;
  const updatedMs = Date.parse(fundamentals.updated_at);
  const marketAsOfMs = Date.parse(fundamentals.market_checked_at ?? fundamentals.market_as_of ?? "");
  if (!Number.isFinite(updatedMs) || !Number.isFinite(marketAsOfMs)) return false;
  const oldestTimestamp = Math.min(marketAsOfMs, updatedMs);
  const ageSeconds = (now.getTime() - oldestTimestamp) / 1000;
  return ageSeconds >= 0 && ageSeconds <= FUNDAMENTALS_MARKET_STALE_AFTER_SECONDS;
}

export interface AccountingCardMetrics {
  roicPct: number | null;
  fcfMarginPct: number | null;
  debtToEquity: number | null;
}

function finite(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function nonNegative(value: number | null | undefined): value is number {
  return finite(value) && value >= 0;
}

function directFinnhubCardMetrics(
  fundamentals: StockDetailStorageSnapshot["fundamentals"],
): AccountingCardMetrics {
  return {
    roicPct: finite(fundamentals?.roic_pct) ? fundamentals.roic_pct : null,
    fcfMarginPct: finite(fundamentals?.fcf_margin_pct) ? fundamentals.fcf_margin_pct : null,
    debtToEquity: finite(fundamentals?.debt_to_equity) ? fundamentals.debt_to_equity : null,
  };
}

/**
 * Read the three slow-moving cards. New snapshots use Finnhub's direct ratios.
 * The old accounting derivation remains only as a rollout compatibility path.
 */
export function calculateAccountingCardMetrics(
  fundamentals: StockDetailStorageSnapshot["fundamentals"],
): AccountingCardMetrics {
  if (fundamentals?.market_source === FINNHUB_BASIC_FINANCIALS_SOURCE) {
    return directFinnhubCardMetrics(fundamentals);
  }

  const metrics: AccountingCardMetrics = { roicPct: null, fcfMarginPct: null, debtToEquity: null };
  if (!fundamentals) return metrics;
  if (
    finite(fundamentals.operating_cash_flow_ttm)
    && finite(fundamentals.capex_ttm)
    && finite(fundamentals.revenue_ttm)
    && fundamentals.revenue_ttm > 0
  ) {
    const freeCashFlow = fundamentals.operating_cash_flow_ttm - fundamentals.capex_ttm;
    const fcfMargin = freeCashFlow / fundamentals.revenue_ttm;
    if (Number.isFinite(fcfMargin)) metrics.fcfMarginPct = fcfMargin * 100;
  }
  if (nonNegative(fundamentals.total_debt) && finite(fundamentals.shareholders_equity) && fundamentals.shareholders_equity > 0) {
    metrics.debtToEquity = fundamentals.total_debt / fundamentals.shareholders_equity;
  }
  if (
    finite(fundamentals.operating_income_ttm)
    && finite(fundamentals.income_tax_ttm)
    && finite(fundamentals.pretax_income_ttm)
    && fundamentals.pretax_income_ttm > 0
    && nonNegative(fundamentals.total_debt)
    && nonNegative(fundamentals.shareholders_equity)
    && nonNegative(fundamentals.cash)
    && nonNegative(fundamentals.short_term_investments)
    && fundamentals.accounting_periods_compatible === 1
  ) {
    const effectiveTaxRate = fundamentals.income_tax_ttm / fundamentals.pretax_income_ttm;
    const nopat = fundamentals.operating_income_ttm * (1 - effectiveTaxRate);
    const investedCapital = fundamentals.total_debt
      + fundamentals.shareholders_equity
      - fundamentals.cash
      - fundamentals.short_term_investments;
    if (Number.isFinite(nopat) && Number.isFinite(investedCapital) && investedCapital > 0) {
      metrics.roicPct = (nopat / investedCapital) * 100;
    }
  }
  return metrics;
}

function expectedSplitFactorForWeek(
  weekEndDate: string,
  effectiveSplits: readonly StockDetailSplitEventRow[],
): number | null {
  let factor = 1;
  for (const split of effectiveSplits) {
    if (split.effective_date <= weekEndDate) continue;
    if (!isPositiveFinite(split.split_factor)) return null;
    factor *= split.split_factor;
    if (!isPositiveFinite(factor)) return null;
  }
  return factor;
}

function quoteSplitState(quote: QuoteInput | null, splitMs: number): QuoteHistoryScaleState {
  if (!quote) return "unknown";
  const quoteMs = Date.parse(quote.provider_timestamp);
  if (!Number.isFinite(quoteMs)) return "unknown";
  return quoteMs >= splitMs ? "safe" : "mismatch";
}

function servedHistorySplitState(
  weeklyRows: readonly WeeklyPriceRow[],
  effectiveSplits: readonly StockDetailSplitEventRow[],
  splitMs: number,
): QuoteHistoryScaleState {
  for (const row of weeklyRows) {
    if (!isoWeekOfDateKey(row.week_end_date)) return "unknown";
    const expectedFactor = expectedSplitFactorForWeek(row.week_end_date, effectiveSplits);
    if (expectedFactor === null) return "unknown";
    if (!approximatelyEqual(row.split_adjustment_factor, expectedFactor)) return "mismatch";
    if (!hasValidRawOhlc(row) || !closeMatchesPersistedAdjustment(
      row.raw_close / row.split_adjustment_factor,
      row.split_adjusted_close,
    )) return "mismatch";
    const fetchedAt = Date.parse(row.source_fetched_at);
    if (!Number.isFinite(fetchedAt)) return "unknown";
    if (fetchedAt < splitMs) return "mismatch";
  }
  return "safe";
}

/** Classify weekly history only when its split scale has sufficient evidence. */
function servedHistoryScaleState(
  weeklyRows: readonly WeeklyPriceRow[],
  effectiveSplits: readonly StockDetailSplitEventRow[],
  splitHistoryVerified = false,
): QuoteHistoryScaleState {
  if (weeklyRows.length === 0) return "safe";
  if (effectiveSplits.length === 0) {
    if (!splitHistoryVerified) return "unknown";
    for (const row of weeklyRows) {
      if (
        !approximatelyEqual(row.split_adjustment_factor, 1)
        || !hasValidRawOhlc(row)
        || !closeMatchesPersistedAdjustment(row.raw_close, row.split_adjusted_close)
      ) return "mismatch";
    }
    return "safe";
  }
  const latestEffectiveSplit = effectiveSplits.at(-1) ?? null;
  if (!latestEffectiveSplit) return "safe";
  const splitMs = Date.parse(`${latestEffectiveSplit.effective_date}T00:00:00.000Z`);
  if (!Number.isFinite(splitMs)) return "unknown";
  return servedHistorySplitState(weeklyRows, effectiveSplits, splitMs);
}

/** Evidence-based split safety for quote/chart serving. */
export function servedSplitScaleState(
  quote: QuoteInput | null,
  metricCalculatedAt: string | null,
  weeklyRows: readonly WeeklyPriceRow[],
  effectiveSplits: readonly StockDetailSplitEventRow[],
  splitHistoryVerified = false,
  servingState: "READY" | "BLOCKED" | undefined = undefined,
): QuoteHistoryScaleState {
  if (servingState === "BLOCKED") return "mismatch";
  const latestEffectiveSplit = effectiveSplits.at(-1) ?? null;
  if (!latestEffectiveSplit) {
    return servedHistoryScaleState(weeklyRows, effectiveSplits, splitHistoryVerified);
  }
  const splitMs = Date.parse(`${latestEffectiveSplit.effective_date}T00:00:00.000Z`);
  if (!Number.isFinite(splitMs)) return "unknown";
  if (weeklyRows.length === 0) return quoteSplitState(quote, splitMs);
  const historyState = servedHistoryScaleState(weeklyRows, effectiveSplits, splitHistoryVerified);
  if (historyState !== "safe") return historyState;
  const quoteState = quoteSplitState(quote, splitMs);
  if (quoteState !== "safe" || metricCalculatedAt === null) return quoteState;
  const metricMs = Date.parse(metricCalculatedAt);
  if (!Number.isFinite(metricMs)) return "unknown";
  return metricMs >= splitMs ? "safe" : "mismatch";
}

/**
 * Detect only strong scale evidence not explained by the known split history.
 * A persisted historical transition after the latest known split can
 * independently prove a mixed regime; for a current quote transition, the
 * quote and two consecutive weekly closes must agree with the same
 * conventional split ratio. A percentage move alone (including a normal 50%
 * move) is never sufficient.
 */
export function hasUnexpectedQuoteScaleMismatch(
  quote: QuoteInput | null,
  weeklyRows: readonly WeeklyPriceRow[],
  effectiveSplits: readonly StockDetailSplitEventRow[],
): boolean {
  const latestKnownEffectiveDate = effectiveSplits.at(-1)?.effective_date ?? null;
  const rowsAfterLatestKnownSplit = latestKnownEffectiveDate
    ? weeklyRows.filter((row) => row.week_end_date >= latestKnownEffectiveDate)
    : weeklyRows;
  if (hasUnexplainedHistoricalScaleTransition(rowsAfterLatestKnownSplit)) return true;
  const latestWeeklyRow = weeklyRows[0] ?? null;
  const priorWeeklyRow = weeklyRows[1] ?? null;
  if (!quote || !latestWeeklyRow || !priorWeeklyRow) return false;
  if (
    !isPositiveFinite(quote.price)
    || !isPositiveFinite(quote.previous_close ?? NaN)
    || !isPositiveFinite(latestWeeklyRow.raw_close)
    || !isPositiveFinite(priorWeeklyRow.raw_close)
    || !hasValidRawOhlc(latestWeeklyRow)
    || !hasValidRawOhlc(priorWeeklyRow)
    || !approximatelyEqual(latestWeeklyRow.split_adjustment_factor, 1)
    || !approximatelyEqual(priorWeeklyRow.split_adjustment_factor, 1)
    || quote.daily_change_valid !== 1
    || typeof quote.quote_session_date !== "string"
    || typeof quote.previous_close_session_date !== "string"
    || quote.previous_close_session_date >= quote.quote_session_date
  ) return false;
  const latestWeek = isoWeekOfDateKey(latestWeeklyRow.week_end_date);
  const priorWeek = isoWeekOfDateKey(priorWeeklyRow.week_end_date);
  if (
    latestWeek === null
    || priorWeek === null
    || latestWeeklyRow.week_end_date <= priorWeeklyRow.week_end_date
    || weekDiffDays(latestWeek, priorWeek) !== 7
    || (latestKnownEffectiveDate !== null
      && (latestWeeklyRow.week_end_date < latestKnownEffectiveDate
        || priorWeeklyRow.week_end_date < latestKnownEffectiveDate))
  ) return false;
  const quoteSessionMs = Date.parse(`${quote.quote_session_date}T00:00:00.000Z`);
  const historyMs = Date.parse(`${latestWeeklyRow.week_end_date}T00:00:00.000Z`);
  if (!Number.isFinite(quoteSessionMs) || !Number.isFinite(historyMs)) return false;
  const ageDays = (quoteSessionMs - historyMs) / (24 * 60 * 60 * 1000);
  if (ageDays < 0 || ageDays > STRUCTURAL_HISTORY_MAX_AGE_DAYS) return false;

  const quoteRatio = (quote.previous_close ?? 0) / quote.price;
  const historyRatios = [latestWeeklyRow.raw_close, priorWeeklyRow.raw_close]
    .map((close) => close / quote.price);
  const [latestHistoryRatio, priorHistoryRatio] = historyRatios as [number, number];
  if (STRUCTURAL_SPLIT_FACTORS.some((factor) => (
    isClearlyNonNearOneSplitFactor(factor)
    && Math.abs(quoteRatio / factor - 1) <= STRUCTURAL_SPLIT_TOLERANCE
    && Math.abs(latestHistoryRatio / factor - 1) <= STRUCTURAL_SPLIT_TOLERANCE
    && approximatelyWithin(
      priorHistoryRatio,
      latestHistoryRatio,
      STRUCTURAL_PRIOR_HISTORY_TOLERANCE,
    )
  ))) return true;

  // If the quote feed has already normalized its previous-close field to the
  // new scale, the daily ratio is ordinary and cannot provide the first
  // signal. Two consecutive historical closes still on the old scale provide
  // the independent evidence: both must sit near the same conventional factor
  // above/below the quote's previous close. A single weekly close is not enough
  // because a provider correction or an ordinary gap can move one candle.
  const historyToPreviousCloseRatios = [latestWeeklyRow.raw_close, priorWeeklyRow.raw_close]
    .map((close) => close / (quote.previous_close ?? 1));
  // This fallback only applies when the quote's own daily ratio is ordinary;
  // otherwise the first detector owns the evidence. Require the two history
  // rows to agree tightly as a second independent check so a normal large move
  // cannot create durable split-verification work by itself.
  if (!approximatelyWithin(quoteRatio, 1, STRUCTURAL_QUOTE_HISTORY_TOLERANCE)) return false;
  const [latestRatio, priorRatio] = historyToPreviousCloseRatios as [number, number];
  if (!approximatelyWithin(latestRatio, priorRatio, STRUCTURAL_SPLIT_TOLERANCE)) return false;
  return STRUCTURAL_SPLIT_FACTORS.some((factor) => (
    isClearlyNonNearOneSplitFactor(factor)
    && historyToPreviousCloseRatios.every((ratio) => approximatelyWithin(
      ratio, factor, STRUCTURAL_QUOTE_HISTORY_TOLERANCE,
    ))
  ));
}

/** One-stock serving read model. Providers never run in this request path. */
export async function readStockDetailApi(
  env: Env,
  symbol: string,
  now = new Date(),
): Promise<StockDetailApiResponse> {
  const currentMarketDate = nyDateKeyOf(now);
  if (!currentMarketDate) throw new Error("new_york_market_date_unavailable");

  const {
    company,
    quote,
    metric,
    supports: supportsRaw,
    intrinsicValue: intrinsicRaw,
    weeklyRows,
    splitEvents,
    splitHistoryVerified,
    splitHistoryStatus,
    servingState,
    recoveryState,
    fundamentals,
  } = env.ENVIRONMENT === "preview"
    ? await readStockDetailStorageSnapshot(env.DB, symbol, STOCK_DETAIL_HISTORY_LIMIT, "preview")
    : await readStockDetailStorageSnapshot(env.DB, symbol);

  const marketFundamentalsFresh = marketFundamentalsAreFresh(fundamentals, now);
  const cardMetrics = calculateAccountingCardMetrics(fundamentals);
  const validSplitEvents = splitEvents.filter((event) => isoWeekOfDateKey(event.effective_date) !== null);
  const effectiveSplitEvents = validSplitEvents.filter((event) => event.effective_date <= currentMarketDate);
  const effectiveSplit = effectiveSplitEvents.at(-1) ?? null;
  const effectiveSplitAsOf = effectiveSplit?.effective_date ?? null;
  const splitWeeks = new Set(
    effectiveSplitEvents
      .map((event) => weekIdentity(event.effective_date))
      .filter((week): week is string => week !== null),
  );
  const latestEffectiveSplitMap = effectiveSplitAsOf
    ? new Map([[symbol, effectiveSplitAsOf]])
    : new Map<string, string>();
  const quoteInput: QuoteInput | null = quote
    ? {
        price: quote.price,
        provider_timestamp: quote.provider_timestamp,
        previous_close: quote.previous_close,
        quote_session_date: quote.quote_session_date,
        previous_close_session_date: quote.previous_close_session_date,
        daily_change_valid: quote.daily_change_valid,
      }
      : null;
  const quoteHistoryScaleBlock = servingState?.state === "BLOCKED"
    && servingState.reason === "quote_history_scale_mismatch";
  // A quote-only block is a transient ordering state: the due-split job may
  // have already made history safe while the quote still carries the prior
  // session. Re-evaluate it below once a refreshed quote is provably safe.
  // Every other BLOCKED reason remains authoritative and fail-closed.
  const servingStateForScale = servingState?.state === "BLOCKED" && !quoteHistoryScaleBlock
    ? "BLOCKED"
    : undefined;
  const historyScaleState = servedHistoryScaleState(
    weeklyRows,
    effectiveSplitEvents,
    splitHistoryVerified === true || servingState?.state === "READY",
  );
  const computedScaleState = servedSplitScaleState(
    quoteInput,
    metric?.calculated_at ?? null,
    weeklyRows,
    effectiveSplitEvents,
    splitHistoryVerified === true || servingState?.state === "READY",
    servingStateForScale,
  );
  const unexpectedScaleMismatch = hasUnexpectedQuoteScaleMismatch(
    quoteInput,
    weeklyRows,
    effectiveSplitEvents,
  );
  // A durable READY marker is authoritative.  A stale workflow marker may
  // remain after READY publication if cleanup/checkpointing was interrupted;
  // it must not make already-verified data disappear from serving.
  const verificationPending = servingState?.state !== "READY"
    && (splitHistoryStatus === "pending" || splitHistoryStatus === "error");
  let quoteHistoryBlockCleared = false;
  if (
    quoteHistoryScaleBlock
    && computedScaleState === "safe"
    && !verificationPending
    && !unexpectedScaleMismatch
    && recoveryState?.status !== "running"
  ) {
    try {
      quoteHistoryBlockCleared = await clearQuoteHistoryScaleMismatch(
        env.DB,
        symbol,
        now.toISOString(),
      );
    } catch (error) {
      // The response remains unavailable if the conditional publication
      // cannot be confirmed. A later read or recovery run retries it.
      console.error(JSON.stringify({
        route: "stock-detail",
        symbol,
        status: "split_ready_publication_failed",
        error: (error instanceof Error ? error.message : String(error)).slice(0, 160),
      }));
    }
  }
  const scaleState: QuoteHistoryScaleState = (
    (servingState?.state === "BLOCKED" && !quoteHistoryBlockCleared)
    || verificationPending
    || unexpectedScaleMismatch
  ) ? "mismatch" : computedScaleState;
  const recoveryRequestActive = recoveryState?.status === "pending"
    || recoveryState?.status === "running"
    || recoveryState?.status === "retry";
  if (
    scaleState === "mismatch"
    && (servingState?.state !== "BLOCKED" || !recoveryRequestActive)
    && typeof persistSplitScaleMismatch === "function"
  ) {
    const reason = unexpectedScaleMismatch
      ? "unexpected_scale_mismatch"
      : verificationPending
        ? "split_verification_pending"
        : historyScaleState === "mismatch"
          ? "history_factor_mismatch"
          : "quote_history_scale_mismatch";
    try {
      await persistSplitScaleMismatch(env.DB, symbol, reason, now.toISOString());
    } catch (error) {
      // The response still fails closed in this request. The next read retries
      // the durable queue/state write; no potentially wrong price is emitted.
      console.error(JSON.stringify({
        route: "stock-detail",
        symbol,
        status: "split_recovery_enqueue_failed",
        error: (error instanceof Error ? error.message : String(error)).slice(0, 160),
      }));
    }
  }
  const quoteScaleSafe = scaleState === "safe";
  const historyScaleSafe = scaleState === "safe";
  // Market cap and P/E are quote-scale dependent.  Do not expose a cached
  // market snapshot beside a blocked/mismatched current quote.
  const marketCap = quoteScaleSafe && marketFundamentalsFresh ? fundamentals?.market_cap ?? null : null;
  const formattedMarketCap = marketCap === null
    ? null
    : marketCap >= 1_000_000_000_000
      ? `$${(marketCap / 1_000_000_000_000).toFixed(2)}T`
      : marketCap >= 1_000_000_000
        ? `$${(marketCap / 1_000_000_000).toFixed(1)}B`
        : `$${(marketCap / 1_000_000).toFixed(0)}M`;
  const currentPrice = quoteScaleSafe ? quote?.price ?? null : null;
  const marketState = quotesMarketState(now);
  const dailyChange = quoteScaleSafe
    ? deriveDailyChange(quote, currentMarketDate, marketState, effectiveSplitAsOf ?? undefined)
    : null;
  const liveSma = computeLiveSma200w(
    quoteScaleSafe ? quoteInput : null,
    metric,
    latestEffectiveSplitMap,
  );

  // Supports and intrinsic values are price-scale dependent.  A fail-closed
  // Stock Detail must not expose stale levels/valuations alongside an
  // unavailable current price, even when those rows are still present in D1.
  const supports = quoteScaleSafe
    ? buildSupportLevels(
      currentPrice,
      supportsRaw,
      effectiveSplitAsOf ?? undefined,
      currentMarketDate,
    )
    : [];
  const screenerManualIntrinsicValue = quoteScaleSafe
    ? buildIntrinsicValue(
      currentPrice,
      intrinsicRaw,
      effectiveSplitAsOf ?? undefined,
      currentMarketDate,
    )
    : null;
  const manualIntrinsicValue = screenerManualIntrinsicValue
    ? {
        low: screenerManualIntrinsicValue.low,
        base: screenerManualIntrinsicValue.base,
        high: screenerManualIntrinsicValue.high,
        method: screenerManualIntrinsicValue.method,
        asOf: screenerManualIntrinsicValue.asOf,
        upsidePct: currentPrice !== null && currentPrice > 0
          ? (screenerManualIntrinsicValue.base / currentPrice - 1) * 100
          : null,
      }
    : null;

  const automaticModel = quoteScaleSafe
    ? calculateAutomaticIntrinsicValueFromPersistedFundamentals(
      symbol,
      company?.industry?.trim() || null,
      currentPrice,
      fundamentals,
      effectiveSplitEvents,
      currentMarketDate,
    )
    : null;
  const automatic = automaticModel
    ? {
        bear: automaticModel.bear,
        base: automaticModel.base,
        bull: automaticModel.bull,
        method: automaticModel.method,
        methods: automaticModel.methods,
        confidence: automaticModel.confidence,
        asOf: automaticModel.asOf,
        bearUpsidePct: automaticModel.bearUpsidePct,
        baseUpsidePct: automaticModel.baseUpsidePct,
        bullUpsidePct: automaticModel.bullUpsidePct,
      }
    : null;
  const automaticForSelection = automaticIntrinsicValueForScreener(automaticModel, currentPrice);
  const automaticSelectedIntrinsicValue = automaticForSelection
    ? {
        low: automaticForSelection.low,
        base: automaticForSelection.base,
        high: automaticForSelection.high,
        method: automaticForSelection.method,
        asOf: automaticForSelection.asOf,
        upsidePct: automaticModel?.baseUpsidePct ?? null,
      }
    : null;
  const selectedIntrinsicValue = manualIntrinsicValue ?? automaticSelectedIntrinsicValue;

  const allCloseHistory = historyScaleSafe ? toValidChronologicalCloseHistory(weeklyRows) : [];
  const visibleStartIndex = Math.max(0, allCloseHistory.length - STOCK_DETAIL_VISIBLE_WEEKS);
  const visibleStartTime = allCloseHistory[visibleStartIndex]?.time ?? null;
  const allCandles = historyScaleSafe ? toValidChronologicalCandles(weeklyRows, splitWeeks) : [];
  const priceHistory = visibleStartTime === null
    ? []
    : allCandles.filter((point) => point.time >= visibleStartTime).slice(-STOCK_DETAIL_VISIBLE_WEEKS);
  const sma200wHistory = buildHistoricalSma200w(allCloseHistory, visibleStartIndex);
  const latestWeeklyRow = historyScaleSafe ? weeklyRows[0] ?? null : null;
  const historyAsOf = latestWeeklyRow && Number.isFinite(Date.parse(latestWeeklyRow.source_fetched_at))
    ? latestWeeklyRow.source_fetched_at
    : null;

  return stockDetailApiResponseSchema.parse({
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    symbol,
    company: {
      name: company?.company ?? null,
      exchange: company?.exchange?.trim() || null,
      sector: company?.industry?.trim() || null,
      logoUrl: company?.logo_url ?? null,
    },
    quote: {
      price: currentPrice,
      changeAbs: dailyChange?.changeAbs ?? null,
      changePct: dailyChange?.changePct ?? null,
      provider: quote?.provider ?? null,
      asOf: quote?.provider_timestamp ?? null,
      updatedAt: quote?.updated_at ?? null,
      state: scaleState === "safe" ? quoteState(quote?.updated_at ?? null, now) : "Unavailable",
      marketState,
      scaleState,
    },
    valuation: {
      intrinsicValue: manualIntrinsicValue,
      automatic,
      selectedIntrinsicValue,
    },
    fundamentals: {
      marketCap: formattedMarketCap,
      peTtm: quoteScaleSafe && marketFundamentalsFresh ? fundamentals?.pe_ttm ?? null : null,
      roicPct: cardMetrics.roicPct,
      fcfMarginPct: cardMetrics.fcfMarginPct,
      debtToEquity: cardMetrics.debtToEquity,
    },
    technical: {
      sma200w: liveSma.sma200w,
      distanceToSma200wPct: liveSma.distanceToSma200wPct,
      sma200wState: liveSma.sma200wState,
      sma200wHistoryWeeks: liveSma.sma200wHistoryWeeks,
      sma200wAsOf: liveSma.sma200wAsOf,
      supports,
      sma200wHistory,
    },
    chart: {
      interval: "1w",
      priceHistory,
      intrinsicValueHistory: [],
    },
    freshness: {
      quoteAsOf: quote?.provider_timestamp ?? null,
      historyAsOf,
      valuationAsOf: selectedIntrinsicValue?.asOf ?? null,
      technicalAsOf: metric?.calculated_at ?? null,
    },
  });
}
