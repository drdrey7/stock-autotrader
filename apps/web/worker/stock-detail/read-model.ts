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
import { buildIntrinsicValue, buildSupportLevels } from "../stocks/derived";
import { nyDateKeyOf, quoteState, quotesMarketState } from "../quotes/freshness";
import type { Env } from "../index";
import {
  readStockDetailStorageSnapshot,
  STOCK_DETAIL_VISIBLE_WEEKS,
  type StockDetailSplitEventRow,
  type WeeklyPriceRow,
} from "./storage";

const SMA_WINDOW_WEEKS = 200;
const CLOSE_CROSSCHECK_RELATIVE_TOLERANCE = 1e-6;
const CLOSE_CROSSCHECK_ABSOLUTE_TOLERANCE = 1e-8;

interface AdjustedClosePoint {
  time: string;
  close: number;
}

function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
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

/**
 * Convert a normal raw/as-traded weekly bucket to today's split-adjusted price
 * scale. A bucket containing a split is filtered by the caller: the persisted
 * factor is defined from the week-end close, while raw O/H/L can span both
 * sides of the split and therefore cannot form an honest adjusted candle.
 */
export function toSplitAdjustedPricePoint(row: WeeklyPriceRow): StockDetailPricePoint | null {
  const closePoint = toSplitAdjustedClosePoint(row);
  const factor = row.split_adjustment_factor;
  if (
    !closePoint
    || !isPositiveFinite(row.raw_open)
    || !isPositiveFinite(row.raw_high)
    || !isPositiveFinite(row.raw_low)
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

/**
 * O(n) rolling 200-week SMA over completed split-adjusted weekly closes.
 * A missing/invalid/duplicate ISO week resets the rolling basis; we never
 * relabel 200 observations spanning more than 200 consecutive weeks as 200W.
 */
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
    if (contiguousWeeks > SMA_WINDOW_WEEKS) {
      runningSum -= history[index - SMA_WINDOW_WEEKS]!.close;
    }
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

    // D1 weekly history is written in independently committed chunks. A
    // single correct witness cannot prove that the full served window was
    // reconciled after a split, so every row we actually serve must have been
    // persisted after the latest effective split.
    const fetchedAt = Date.parse(row.source_fetched_at);
    if (!Number.isFinite(fetchedAt)) return "unknown";
    if (fetchedAt < splitMs) return "mismatch";
  }

  return "safe";
}

function servedHistoryScaleState(
  weeklyRows: readonly WeeklyPriceRow[],
  effectiveSplits: readonly StockDetailSplitEventRow[],
): QuoteHistoryScaleState {
  if (weeklyRows.length === 0 || effectiveSplits.length === 0) return "safe";
  const latestEffectiveSplit = effectiveSplits.at(-1) ?? null;
  if (!latestEffectiveSplit) return "safe";
  const splitMs = Date.parse(`${latestEffectiveSplit.effective_date}T00:00:00.000Z`);
  if (!Number.isFinite(splitMs)) return "unknown";
  return servedHistorySplitState(weeklyRows, effectiveSplits, splitMs);
}

/**
 * Evidence-based split safety for Stock Detail chart/history compatibility.
 *
 * This state no longer controls whether the persisted latest quote is shown.
 * Screener and Stock Detail both expose the same validated `latest_quotes`
 * value; chart/history can independently fail closed while reconciliation is
 * pending. SMA keeps its own split guard in computeLiveSma200w().
 */
export function servedSplitScaleState(
  quote: QuoteInput | null,
  metricCalculatedAt: string | null,
  weeklyRows: readonly WeeklyPriceRow[],
  effectiveSplits: readonly StockDetailSplitEventRow[],
): QuoteHistoryScaleState {
  const latestEffectiveSplit = effectiveSplits.at(-1) ?? null;
  if (!latestEffectiveSplit) return "safe";

  const splitMs = Date.parse(`${latestEffectiveSplit.effective_date}T00:00:00.000Z`);
  if (!Number.isFinite(splitMs)) return "unknown";

  if (weeklyRows.length === 0) return quoteSplitState(quote, splitMs);

  const historyState = servedHistoryScaleState(weeklyRows, effectiveSplits);
  if (historyState !== "safe") return historyState;

  const quoteState = quoteSplitState(quote, splitMs);
  if (quoteState !== "safe" || metricCalculatedAt === null) return quoteState;

  const metricMs = Date.parse(metricCalculatedAt);
  if (!Number.isFinite(metricMs)) return "unknown";
  return metricMs >= splitMs ? "safe" : "mismatch";
}

/**
 * One-stock serving read model. Every external/provider action happens before
 * this request path. D1 serving uses one batch snapshot so the seven
 * symbol-scoped reads do not exceed Cloudflare's simultaneous-connection cap.
 */
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
  } = await readStockDetailStorageSnapshot(env.DB, symbol);

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
    ? { price: quote.price, provider_timestamp: quote.provider_timestamp }
    : null;
  const historyScaleState = servedHistoryScaleState(weeklyRows, effectiveSplitEvents);
  const historyScaleSafe = historyScaleState === "safe";
  const scaleState = servedSplitScaleState(
    quoteInput,
    null,
    weeklyRows,
    effectiveSplitEvents,
  );

  // Quote summary values come from the same persisted latest_quotes row used
  // by Screener. History reconciliation is allowed to hide only history/chart
  // data; it must never blank a valid current quote.
  const currentPrice = quote?.price ?? null;
  const liveSma = computeLiveSma200w(
    quoteInput,
    metric,
    latestEffectiveSplitMap,
  );

  const supports = buildSupportLevels(
    currentPrice,
    supportsRaw,
    effectiveSplitAsOf ?? undefined,
    currentMarketDate,
  );
  const screenerIntrinsicValue = buildIntrinsicValue(
    currentPrice,
    intrinsicRaw,
    effectiveSplitAsOf ?? undefined,
    currentMarketDate,
  );
  const intrinsicValue = screenerIntrinsicValue
    ? {
        low: screenerIntrinsicValue.low,
        base: screenerIntrinsicValue.base,
        high: screenerIntrinsicValue.high,
        method: screenerIntrinsicValue.method,
        asOf: screenerIntrinsicValue.asOf,
        upsidePct: currentPrice !== null && currentPrice > 0
          ? (screenerIntrinsicValue.base / currentPrice - 1) * 100
          : null,
      }
    : null;

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
      changeAbs: quote?.change_abs ?? null,
      changePct: quote?.change_pct ?? null,
      provider: quote?.provider ?? null,
      asOf: quote?.provider_timestamp ?? null,
      updatedAt: quote?.updated_at ?? null,
      state: quoteState(quote?.updated_at ?? null, now),
      marketState: quotesMarketState(now),
      scaleState,
    },
    valuation: { intrinsicValue },
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
      valuationAsOf: intrinsicValue?.asOf ?? null,
      technicalAsOf: metric?.calculated_at ?? null,
    },
  });
}
