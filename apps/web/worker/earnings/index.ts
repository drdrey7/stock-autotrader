import type { EarningsApiResponse, EarningsEngineEvent } from "@stock-autotrader/contracts";
import type { Env } from "../index";
export { EARNINGS_CALENDAR_CRON, EARNINGS_MONITOR_CRON } from "../cron-dispatcher";
import {
  addDays,
  currentYearStart,
  endOfWeek,
  isWithinInclusive,
  mergeCalendarAndConsensus,
  newYorkDate,
  normalizeEvent,
  shouldPollEarnings,
  startOfWeek,
  validDateKey,
} from "./logic";
import {
  createDefaultEarningsProviders,
} from "./providers";
import type {
  EarningsCalendarObservation,
  EarningsConsensusObservation,
  EarningsConsensusProvider,
  EarningsDateRange,
  EarningsProviderBundle,
  NormalizedEarningsEvent,
  OfficialFiling,
} from "./types";
import { EARNINGS_UNIVERSE, EARNINGS_UNIVERSE_SYMBOLS, normalizeSymbol } from "./universe";
import {
  markPastScheduledEventsUnknown,
  markUnseenScheduledEventsUnknown,
  readEarningsEvents,
  readUniverseMetadata,
  rowToEarningsEvent,
  readEarningsMeta,
  setEarningsMeta,
  clearEarningsMeta,
  upsertEarningsEvents,
  upsertUniverseMembers,
  readEarningsMonitoringEvents,
} from "./storage";
import { MAX_SEC_FILING_LOOKUPS_PER_JOB } from "./subrequest-budget";
export { MAX_SEC_FILING_LOOKUPS_PER_JOB } from "./subrequest-budget";

export const EARNINGS_BACKFILL_DAYS = 30;
export const EARNINGS_WINDOW_DAYS = 60;
export const EARNINGS_QUERY_MAX_DAYS = 450;
export const EARNINGS_ENGINE_STALE_AFTER_SECONDS = 26 * 60 * 60;

const EARNINGS_META_KEYS = {
  lastAttempt: "earningsEngineLastAttemptAt",
  lastError: "earningsEngineLastError",
  calendarError: "earningsCalendarLastError",
  monitorError: "earningsMonitorLastError",
} as const;

export class EarningsQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EarningsQueryError";
  }
}

type EarningsJobMode = "calendar" | "monitor";

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

function providerConsensusMap(observations: EarningsConsensusObservation[]): Map<string, EarningsConsensusObservation> {
  const map = new Map<string, EarningsConsensusObservation>();
  for (const observation of observations) {
    const keys = [
      observation.providerEventId,
      `${observation.symbol}:${observation.scheduledDate ?? ""}`,
    ].filter((value): value is string => Boolean(value));
    for (const key of keys) map.set(key, observation);
  }
  return map;
}

function matchConsensus(
  observation: EarningsCalendarObservation,
  consensus: Map<string, EarningsConsensusObservation>,
): EarningsConsensusObservation | null {
  const byId = observation.providerEventId ? consensus.get(observation.providerEventId) : undefined;
  if (byId) return byId;
  return consensus.get(`${observation.symbol}:${observation.scheduledDate ?? ""}`) ?? null;
}

function observationFromExisting(event: EarningsEngineEvent): EarningsCalendarObservation {
  return {
    symbol: event.symbol,
    company: event.company,
    scheduledDate: event.scheduledDate,
    scheduledTime: event.scheduledTime,
    timing: event.timing,
    fiscalYear: event.fiscalYear,
    fiscalQuarter: event.fiscalQuarter,
    fiscalPeriod: event.fiscalPeriod,
    fiscalPeriodEnd: event.fiscalPeriodEnd,
    epsEstimate: event.epsEstimate,
    revenueEstimate: event.revenueEstimate,
    epsActual: event.epsActual,
    revenueActual: event.revenueActual,
    providerEventId: event.providerEventId,
    providerUpdatedAt: event.providerUpdatedAt,
    officialReportUrl: event.officialReportUrl,
    cancelled: event.cancelled,
  };
}

async function syncUniverse(
  env: Env,
  providers: EarningsProviderBundle,
  collectedAt: string,
): Promise<{ metadata: Awaited<ReturnType<typeof readUniverseMetadata>>; warnings: string[] }> {
  const previous = await readUniverseMetadata(env.DB).catch(() => new Map<string, { company: string; cik: string | null; investorRelationsUrl: string | null }>());
  const warnings: string[] = [];
  let metadata = new Map<string, { company: string; cik: string | null; investorRelationsUrl: string | null }>();
  try {
    const result = await providers.official.fetchCompanyMetadata(collectedAt);
    warnings.push(...result.warnings);
    const bySymbol = new Map(result.observations.map((item) => [normalizeSymbol(item.symbol), item]));
    await upsertUniverseMembers(env.DB, EARNINGS_UNIVERSE.map((member) => {
      const sec = bySymbol.get(member.symbol);
      return {
        symbol: member.symbol,
        company: sec?.company ?? previous.get(member.symbol)?.company ?? member.symbol,
        cik: sec?.cik ?? previous.get(member.symbol)?.cik ?? null,
        exchange: sec?.exchange ?? null,
        investorRelationsUrl: sec?.investorRelationsUrl ?? previous.get(member.symbol)?.investorRelationsUrl ?? null,
        indexes: member.indexes,
        updatedAt: collectedAt,
      };
    }));
  } catch (error) {
    const warning = `SEC company metadata degraded: ${errorMessage(error).slice(0, 180)}`;
    warnings.push(warning);
    console.warn(JSON.stringify({ message: "earnings universe metadata degraded", error: warning }));
    // A metadata outage must not erase the last known CIK/company values.
    await upsertUniverseMembers(env.DB, EARNINGS_UNIVERSE.map((member) => ({
      symbol: member.symbol,
      company: previous.get(member.symbol)?.company ?? member.symbol,
      cik: previous.get(member.symbol)?.cik ?? null,
      exchange: null,
      investorRelationsUrl: previous.get(member.symbol)?.investorRelationsUrl ?? null,
      indexes: member.indexes,
      updatedAt: collectedAt,
    })));
  }
  metadata = await readUniverseMetadata(env.DB);
  return { metadata, warnings };
}

async function findFiling(
  providers: EarningsProviderBundle,
  event: EarningsEngineEvent,
  today: string,
): Promise<OfficialFiling | null> {
  if (!event.cik || !event.scheduledDate || event.scheduledDate > today) return null;
  try {
    return await providers.official.findRelevantFiling(event, today);
  } catch (error) {
    console.warn(JSON.stringify({ message: "SEC filing lookup degraded", symbol: event.symbol, error: errorMessage(error).slice(0, 180) }));
    return null;
  }
}

function applyProviderNames(event: NormalizedEarningsEvent, providers: EarningsProviderBundle): NormalizedEarningsEvent {
  return { ...event, calendarProvider: providers.calendar.name, consensusProvider: providers.consensus.name };
}

function logEarningsJob(fields: {
  job: "calendar" | "monitor";
  provider: string;
  range: EarningsDateRange;
  observations: number;
  normalized: number;
  written: number;
  secLookups: number;
  status: "ok" | "degraded" | "skipped";
  durationMs: number;
  warningCount: number;
  detail?: string;
}): void {
  console.info(JSON.stringify({
    job: `earnings-${fields.job}`,
    provider: fields.provider,
    range: fields.range,
    observations: fields.observations,
    normalized: fields.normalized,
    written: fields.written,
    secLookups: fields.secLookups,
    status: fields.status,
    durationMs: fields.durationMs,
    warningCount: fields.warningCount,
    ...(fields.detail ? { detail: fields.detail.slice(0, 240) } : {}),
  }));
}

type EarningsFailureScope = "calendar" | "monitor";

function failureKey(scope: EarningsFailureScope): string {
  return scope === "calendar" ? EARNINGS_META_KEYS.calendarError : EARNINGS_META_KEYS.monitorError;
}

async function recordEarningsAttempt(env: Env, collectedAt: string): Promise<void> {
  await setEarningsMeta(env.DB, EARNINGS_META_KEYS.lastAttempt, collectedAt);
}

async function refreshEarningsCurrentError(env: Env): Promise<void> {
  const [calendarError, monitorError] = await Promise.all([
    readEarningsMeta(env.DB, EARNINGS_META_KEYS.calendarError),
    readEarningsMeta(env.DB, EARNINGS_META_KEYS.monitorError),
  ]);
  const currentError = calendarError ?? monitorError;
  if (currentError) await setEarningsMeta(env.DB, EARNINGS_META_KEYS.lastError, currentError);
  else await clearEarningsMeta(env.DB, EARNINGS_META_KEYS.lastError);
}

async function rememberEarningsFailure(
  env: Env,
  scope: EarningsFailureScope,
  collectedAt: string,
  detail: string,
): Promise<void> {
  const bounded = detail.slice(0, 480);
  await setEarningsMeta(env.DB, EARNINGS_META_KEYS.lastAttempt, collectedAt);
  await setEarningsMeta(env.DB, failureKey(scope), bounded);
  await setEarningsMeta(env.DB, EARNINGS_META_KEYS.lastError, bounded);
}

async function clearEarningsFailure(env: Env, scope: EarningsFailureScope): Promise<void> {
  await clearEarningsMeta(env.DB, failureKey(scope));
  await refreshEarningsCurrentError(env);
}

async function normalizeObservation(
  providers: EarningsProviderBundle,
  observation: EarningsCalendarObservation,
  today: string,
  collectedAt: string,
  metadata: Map<string, { company: string; cik: string | null; investorRelationsUrl: string | null }>,
  filingLookups: { used: number; limit: number },
): Promise<NormalizedEarningsEvent> {
  const member = metadata.get(observation.symbol);
  const base = normalizeEvent(observation, today, collectedAt, member, null);
  const withProviderNames = applyProviderNames(base, providers);
  const canLookupFiling = !observation.officialFiling
    && filingLookups.used < filingLookups.limit
    && withProviderNames.scheduledDate !== null
    && (withProviderNames.status === "reported" || withProviderNames.scheduledDate <= today);
  const filing = canLookupFiling ? await findFiling(providers, withProviderNames, today) : null;
  if (canLookupFiling) filingLookups.used += 1;
  const final = filing
    ? applyProviderNames(normalizeEvent(observation, today, collectedAt, member, filing), providers)
    : withProviderNames;
  return final;
}

async function readProviderCalendar(
  providers: EarningsProviderBundle,
  range: EarningsDateRange,
  collectedAt: string,
): Promise<{ observations: EarningsCalendarObservation[]; provider: string; warnings: string[]; success: boolean; complete: boolean }> {
  try {
    const calendar = await providers.calendar.fetchCalendar(range, EARNINGS_UNIVERSE_SYMBOLS, collectedAt);
    if (Object.is(providers.calendar, providers.consensus)) {
      return {
        observations: calendar.observations,
        provider: calendar.provider,
        warnings: calendar.warnings,
        success: true,
        complete: calendar.complete !== false,
      };
    }
    let consensus: Awaited<ReturnType<EarningsConsensusProvider["fetchConsensus"]>>;
    try {
      consensus = await providers.consensus.fetchConsensus(range, EARNINGS_UNIVERSE_SYMBOLS, collectedAt);
    } catch (error) {
      // A calendar is still useful when estimates/actuals are temporarily
      // unavailable from a separate adapter. Keep the valid calendar rows.
      return {
        observations: calendar.observations,
        provider: calendar.provider,
        warnings: [...calendar.warnings, `consensus degraded: ${errorMessage(error)}`],
        success: true,
        complete: calendar.complete !== false,
      };
    }
    const map = providerConsensusMap(consensus.observations);
    return {
      observations: calendar.observations.map((observation) => mergeCalendarAndConsensus(observation, matchConsensus(observation, map))),
      provider: calendar.provider,
      warnings: [...calendar.warnings, ...consensus.warnings],
      success: true,
      complete: calendar.complete !== false,
    };
  } catch (error) {
    return { observations: [], provider: providers.calendar.name, warnings: [errorMessage(error)], success: false, complete: false };
  }
}

async function runCalendarSync(env: Env, scheduledTime: Date, providers: EarningsProviderBundle): Promise<{ status: "ok" | "degraded"; detail: string }> {
  const startedAt = Date.now();
  const collectedAt = scheduledTime.toISOString();
  const today = newYorkDate(scheduledTime);
  const range = { from: addDays(today, -EARNINGS_BACKFILL_DAYS), to: addDays(today, EARNINGS_WINDOW_DAYS) };
  // The daily sync owns the initial historical backfill as well as the
  // rolling future window. Providers may return fewer rows when they do not
  // publish forward schedules; missing values remain NULL/Not Available.
  const providerRange = range;
  await recordEarningsAttempt(env, collectedAt);
  const universe = await syncUniverse(env, providers, collectedAt);
  const metadata = universe.metadata;
  const calendar = await readProviderCalendar(providers, providerRange, collectedAt);
  if (!calendar.success) {
    const detail = calendar.warnings[0]?.slice(0, 200) ?? "calendar unavailable";
    await rememberEarningsFailure(env, "calendar", collectedAt, detail);
    logEarningsJob({
      job: "calendar",
      provider: providers.calendar.name,
      range,
      observations: 0,
      normalized: 0,
      written: 0,
      secLookups: 0,
      status: "degraded",
      durationMs: Date.now() - startedAt,
      warningCount: universe.warnings.length + calendar.warnings.length,
      detail,
    });
    return { status: "degraded", detail };
  }

  let written = 0;
  const filingLookups = { used: 0, limit: MAX_SEC_FILING_LOOKUPS_PER_JOB };
  const normalized: NormalizedEarningsEvent[] = [];
  const warnings = [...universe.warnings, ...calendar.warnings];
  for (const observation of calendar.observations) {
    try {
      normalized.push(await normalizeObservation(providers, observation, today, collectedAt, metadata, filingLookups));
      written += 1;
    } catch (error) {
      const warning = `${observation.symbol}: ${errorMessage(error).slice(0, 180)}`;
      warnings.push(warning);
      console.warn(JSON.stringify({ message: "earnings event normalization failed", symbol: observation.symbol, error: warning }));
    }
  }
  await upsertEarningsEvents(env.DB, normalized);
  // Absence reconciliation is destructive. A mixed/malformed provider payload
  // is useful for valid rows, but it is not authoritative for rows it omitted.
  // Keep the last-known-good schedule until a complete calendar is available.
  if (calendar.complete) {
    if (providers.calendar.supportsForwardCalendar !== false) {
      await markUnseenScheduledEventsUnknown(env.DB, range.from, range.to, collectedAt, collectedAt);
      await env.DB.prepare(
        "UPDATE earnings_events SET status = 'unknown', scheduled = 0, reported = 0, unknown = 1, updated_at = ?, last_checked_at = ? WHERE status = 'scheduled' AND scheduled_date > ?",
      ).bind(collectedAt, collectedAt, range.to).run();
    }
    await markPastScheduledEventsUnknown(env.DB, today, collectedAt);
  }
  await setEarningsMeta(env.DB, "earningsEngineUpdatedAt", collectedAt);
  await setEarningsMeta(env.DB, "earningsCalendarWindow", JSON.stringify(range));
  if (warnings.length > 0) await rememberEarningsFailure(env, "calendar", collectedAt, warnings[0]!);
  else await clearEarningsFailure(env, "calendar");
  const status = warnings.length > 0 ? "degraded" : "ok";
  const detail = `${written}/${calendar.observations.length} events in ${range.from}..${range.to}`;
  logEarningsJob({
    job: "calendar",
    provider: providers.calendar.name,
    range,
    observations: calendar.observations.length,
    normalized: normalized.length,
    written,
    secLookups: filingLookups.used,
    status,
    durationMs: Date.now() - startedAt,
    warningCount: warnings.length,
    detail,
  });
  return { status, detail };
}

async function runMonitoring(env: Env, scheduledTime: Date, providers: EarningsProviderBundle): Promise<{ status: "ok" | "degraded" | "skipped"; detail: string }> {
  const startedAt = Date.now();
  const collectedAt = scheduledTime.toISOString();
  const today = newYorkDate(scheduledTime);
  // A small current-day provider poll is also needed when a date moves to
  // today after the daily sync. Avoid it outside the broad ET monitoring
  // window, where it cannot produce a useful result.
  const range = { from: addDays(today, -2), to: addDays(today, 1) };
  if (!shouldPollEarnings("TBD", scheduledTime)) {
    logEarningsJob({ job: "monitor", provider: providers.calendar.name, range, observations: 0, normalized: 0, written: 0, secLookups: 0, status: "skipped", durationMs: Date.now() - startedAt, warningCount: 0, detail: "outside the earnings monitoring window" });
    return { status: "skipped", detail: "outside the earnings monitoring window" };
  }
  const due = await readEarningsMonitoringEvents(env.DB, today);
  const active = due.filter((event) => shouldPollEarnings(event.timing, scheduledTime) || event.status === "reported");
  const lastPoll = await readEarningsMeta(env.DB, "earningsEngineLastMonitorPollAt").catch(() => null);
  const lastPollMs = lastPoll ? Date.parse(lastPoll) : NaN;
  const recentPoll = Number.isFinite(lastPollMs) && lastPollMs <= scheduledTime.getTime()
    && scheduledTime.getTime() - lastPollMs < 60 * 60 * 1000;
  // An hourly discovery poll catches dates that moved onto today without
  // spending a Finnhub request on an otherwise empty 15-minute invocation.
  if (active.length === 0 && recentPoll) {
    logEarningsJob({ job: "monitor", provider: providers.calendar.name, range, observations: 0, normalized: 0, written: 0, secLookups: 0, status: "skipped", durationMs: Date.now() - startedAt, warningCount: 0, detail: "no active events; discovery poll is fresh" });
    return { status: "skipped", detail: "no active events; discovery poll is fresh" };
  }
  await setEarningsMeta(env.DB, "earningsEngineLastMonitorPollAt", collectedAt);
  await recordEarningsAttempt(env, collectedAt);
  const calendar = await readProviderCalendar(providers, range, collectedAt);
  if (!calendar.success) {
    const detail = calendar.warnings[0]?.slice(0, 200) ?? "calendar unavailable";
    await rememberEarningsFailure(env, "monitor", collectedAt, detail);
    logEarningsJob({ job: "monitor", provider: providers.calendar.name, range, observations: 0, normalized: 0, written: 0, secLookups: 0, status: "degraded", durationMs: Date.now() - startedAt, warningCount: calendar.warnings.length, detail });
    return { status: "degraded", detail };
  }
  const providerMap = new Map<string, EarningsCalendarObservation>();
  for (const observation of calendar.observations) {
    providerMap.set(`${observation.symbol}:${observation.scheduledDate ?? ""}`, observation);
    if (observation.providerEventId) providerMap.set(observation.providerEventId, observation);
  }
  const todayObservations = calendar.observations.filter((observation) => observation.scheduledDate === today
    && (shouldPollEarnings(observation.timing, scheduledTime)
      || observation.epsActual !== null
      || observation.revenueActual !== null
      || observation.cancelled === true));
  const metadata = await readUniverseMetadata(env.DB);
  const filingLookups = { used: 0, limit: MAX_SEC_FILING_LOOKUPS_PER_JOB };
  const normalized: NormalizedEarningsEvent[] = [];
  const activeSymbols = new Set<string>();
  const warnings = [...calendar.warnings];
  let successes = 0;
  for (const event of active) {
    try {
      const observation = providerMap.get(event.providerEventId ?? "")
        ?? providerMap.get(`${event.symbol}:${event.scheduledDate ?? ""}`)
        ?? observationFromExisting(event);
      normalized.push(await normalizeObservation(providers, observation, today, collectedAt, metadata, filingLookups));
      activeSymbols.add(event.symbol);
      successes += 1;
    } catch (error) {
      const warning = `${event.symbol}: ${errorMessage(error).slice(0, 180)}`;
      warnings.push(warning);
      console.warn(JSON.stringify({ message: "earnings monitoring failed for symbol", symbol: event.symbol, error: warning }));
    }
  }
  for (const observation of todayObservations) {
    if (activeSymbols.has(observation.symbol)) continue;
    try {
      normalized.push(await normalizeObservation(providers, observation, today, collectedAt, metadata, filingLookups));
      successes += 1;
    } catch (error) {
      const warning = `${observation.symbol}: ${errorMessage(error).slice(0, 180)}`;
      warnings.push(warning);
      console.warn(JSON.stringify({ message: "new earnings event monitoring failed", symbol: observation.symbol, error: warning }));
    }
  }
  await upsertEarningsEvents(env.DB, normalized);
  await setEarningsMeta(env.DB, "earningsEngineCheckedAt", collectedAt);
  if (warnings.length > 0) await rememberEarningsFailure(env, "monitor", collectedAt, warnings[0]!);
  else await clearEarningsFailure(env, "monitor");
  const status = warnings.length > 0 ? "degraded" : "ok";
  const detail = `${successes}/${Math.max(active.length, todayObservations.length)} events checked; provider=ok`;
  logEarningsJob({ job: "monitor", provider: providers.calendar.name, range, observations: calendar.observations.length, normalized: normalized.length, written: normalized.length, secLookups: filingLookups.used, status, durationMs: Date.now() - startedAt, warningCount: warnings.length, detail });
  return {
    status,
    detail,
  };
}

export async function runEarningsJob(
  env: Env,
  scheduledTime: Date,
  mode: EarningsJobMode,
  providers: EarningsProviderBundle = createDefaultEarningsProviders(env.FINNHUB_API_KEY, env.SEC_USER_AGENT),
): Promise<{ status: "ok" | "degraded" | "skipped"; detail: string }> {
  if (mode === "calendar") return runCalendarSync(env, scheduledTime, providers);
  return runMonitoring(env, scheduledTime, providers);
}

export function validateEarningsQueryValue(value: string | null, field: "date" | "symbol" | "status"): string | null {
  if (value === null || value === "") return null;
  if (field === "date") return validDateKey(value) ? value : null;
  if (field === "symbol") return /^[A-Za-z0-9.-]{1,12}$/.test(value) ? normalizeSymbol(value) : null;
  return ["scheduled", "reported", "cancelled", "unknown"].includes(value) ? value : null;
}

export async function readEarningsApi(
  env: Env,
  params: URLSearchParams,
  now = new Date(),
): Promise<EarningsApiResponse> {
  const today = newYorkDate(now);
  const fromValue = params.get("from");
  const toValue = params.get("to");
  const yearStart = currentYearStart(today);
  const weekStart = startOfWeek(today);
  const defaultFrom = weekStart < yearStart ? weekStart : yearStart;
  const from = fromValue === null ? defaultFrom : validateEarningsQueryValue(fromValue, "date");
  const to = toValue === null ? addDays(today, EARNINGS_WINDOW_DAYS) : validateEarningsQueryValue(toValue, "date");
  if (!from || !to || from > to || to > addDays(from, EARNINGS_QUERY_MAX_DAYS)) {
    throw new EarningsQueryError("invalid earnings date range");
  }
  const symbolValue = params.get("symbol");
  const statusValue = params.get("status");
  const symbol = symbolValue === null ? undefined : validateEarningsQueryValue(symbolValue, "symbol");
  const status = statusValue === null ? undefined : validateEarningsQueryValue(statusValue, "status") as "scheduled" | "reported" | "cancelled" | "unknown" | null;
  if ((symbolValue !== null && !symbol) || (statusValue !== null && !status)) throw new EarningsQueryError("invalid earnings filter");
  const events = await readEarningsEvents(env.DB, { from, to, symbol: symbol ?? undefined, status: status ?? undefined });
  return {
    events,
    summary: {
      today: events.filter((event) => event.scheduledDate === today).length,
      thisWeek: events.filter((event) => isWithinInclusive(event.scheduledDate, startOfWeek(today), endOfWeek(today))).length,
      next60Days: events.filter((event) => isWithinInclusive(event.scheduledDate, today, addDays(today, EARNINGS_WINDOW_DAYS))).length,
    },
    from,
    to,
  };
}

export { rowToEarningsEvent };
