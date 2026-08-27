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
} from "./storage";

const SMA_WINDOW_WEEKS = 200;
const CLOSE_CROSSCHECK_RELATIVE_TOLERANCE = 1e-6;
const CLOSE_CROSSCHECK_ABSOLUTE_TOLERANCE = 1e-8;
const FINNHUB_BASIC_FINANCIALS_SOURCE = "finnhub-basic-financials";
export const FUNDAMENTALS_MARKET_STALE_AFTER_SECONDS = 3 * 24 * 60 * 60;

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

/** Convert one raw weekly row to today's split-adjusted scale. */
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
  if (effectiveSplits.length === 0) return splitHistoryVerified ? "safe" : "unknown";
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
): QuoteHistoryScaleState {
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
    fundamentals,
  } = env.ENVIRONMENT === "preview"
    ? await readStockDetailStorageSnapshot(env.DB, symbol, STOCK_DETAIL_HISTORY_LIMIT, "preview")
    : await readStockDetailStorageSnapshot(env.DB, symbol);

  const marketFundamentalsFresh = marketFundamentalsAreFresh(fundamentals, now);
  const cardMetrics = calculateAccountingCardMetrics(fundamentals);
  const marketCap = marketFundamentalsFresh ? fundamentals?.market_cap ?? null : null;
  const formattedMarketCap = marketCap === null
    ? null
    : marketCap >= 1_000_000_000_000
      ? `$${(marketCap / 1_000_000_000_000).toFixed(2)}T`
      : marketCap >= 1_000_000_000
        ? `$${(marketCap / 1_000_000_000).toFixed(1)}B`
        : `$${(marketCap / 1_000_000).toFixed(0)}M`;

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
  const historyScaleState = servedHistoryScaleState(weeklyRows, effectiveSplitEvents, splitHistoryVerified === true);
  const historyScaleSafe = historyScaleState === "safe";
  const scaleState = servedSplitScaleState(
    quoteInput,
    null,
    weeklyRows,
    effectiveSplitEvents,
    splitHistoryVerified === true,
  );
  const quoteScaleSafe = scaleState === "safe";
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

  const supports = buildSupportLevels(
    currentPrice,
    supportsRaw,
    effectiveSplitAsOf ?? undefined,
    currentMarketDate,
  );
  const screenerManualIntrinsicValue = buildIntrinsicValue(
    currentPrice,
    intrinsicRaw,
    effectiveSplitAsOf ?? undefined,
    currentMarketDate,
  );
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

  const automaticModel = calculateAutomaticIntrinsicValueFromPersistedFundamentals(
    symbol,
    company?.industry?.trim() || null,
    currentPrice,
    fundamentals,
    effectiveSplitEvents,
    currentMarketDate,
  );
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
      state: quoteState(quote?.updated_at ?? null, now),
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
      peTtm: marketFundamentalsFresh ? fundamentals?.pe_ttm ?? null : null,
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
