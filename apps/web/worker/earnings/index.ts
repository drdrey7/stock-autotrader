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
  deduplicateCalendarRows,
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
import {
  CORE_UNIVERSE,
  CORE_UNIVERSE_VERSION,
  normalizeSymbol,
} from "./universe";
import {
  markPastScheduledEventsUnknown,
  markUnseenScheduledEventsUnknown,
  readEarningsEvents,
  readRecentReportedSymbols,
  readRecentlyCheckedRecoverySymbols,
  recoveryCheckedMetaKey,
  readUniverseMetadata,
  rowToEarningsEvent,
  readEarningsMeta,
  setEarningsMeta,
  clearEarningsMeta,
  upsertEarningsEvents,
  upsertUniverseMembers,
  reconcileCoreUniverse,
  readActiveUniverseSymbols,
  readEarningsMonitoringEvents,
} from "./storage";
import { MAX_SEC_FILING_LOOKUPS_PER_JOB, FINNHUB_RATE_PACING_MS, MAX_HISTORICAL_RECOVERY_SYMBOLS_PER_JOB, MAX_HISTORICAL_RECOVERY_SYMBOLS_PER_BOOTSTRAP } from "./subrequest-budget";
import { enrichUniverseMetadata, readMetadataCoverage, METADATA_BOOTSTRAP_THRESHOLD } from "./metadata";
export { MAX_SEC_FILING_LOOKUPS_PER_JOB } from "./subrequest-budget";

export const EARNINGS_BACKFILL_DAYS = 30;
export const EARNINGS_WINDOW_DAYS = 60;
// The top summary counts its own 30-day window (label: NEXT 30 DAYS) while
// the engine keeps the 60-day provider window for the calendar.
export const EARNINGS_SUMMARY_WINDOW_DAYS = 30;
export const EARNINGS_QUERY_MAX_DAYS = 450;
export const EARNINGS_ENGINE_STALE_AFTER_SECONDS = 26 * 60 * 60;

const EARNINGS_META_KEYS = {
  lastAttempt: "earningsEngineLastAttemptAt",
  lastError: "earningsEngineLastError",
  calendarError: "earningsCalendarLastError",
  monitorError: "earningsMonitorLastError",
  // SEC EDGAR enrichment diagnostics — non-critical observability only.
  // These NEVER feed the critical earnings gate (calendar/monitor errors).
  secLastAttempt: "earningsSecLastAttemptAt",
  secLastSuccess: "earningsSecLastSuccessAt",
  secLastError: "earningsSecLastError",
  secConsecutiveFailures: "earningsSecConsecutiveFailures",
} as const;

export class EarningsQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EarningsQueryError";
  }
}

type EarningsJobMode = "calendar" | "monitor";

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

/**
 * Accumulates SEC EDGAR enrichment outcomes for one earnings job. SEC is a
 * best-effort enrichment source: its failures are recorded here (and in the
 * SEC diagnostic meta keys) but never feed the critical calendar/monitor
 * failure keys, so a SEC 403/429/5xx/network outage cannot degrade the
 * critical earnings health gate while the Finnhub calendar path is healthy.
 */
interface SecEnrichmentDiagnostics {
  attempts: number;
  successes: number;
  failures: number;
  lastError: string | null;
}

const newSecDiagnostics = (): SecEnrichmentDiagnostics => ({ attempts: 0, successes: 0, failures: 0, lastError: null });

function recordSecAttempt(sec: SecEnrichmentDiagnostics, error: unknown): void {
  sec.attempts += 1;
  sec.failures += 1;
  sec.lastError = errorMessage(error).slice(0, 240);
}

function recordSecSuccess(sec: SecEnrichmentDiagnostics): void {
  sec.attempts += 1;
  sec.successes += 1;
}

/**
 * Persists the job's SEC enrichment diagnostics. `earningsSecConsecutiveFailures`
 * accumulates only while every SEC call in a job fails (a mixed job proves SEC
 * is reachable); any success resets it. `earningsSecLastError` keeps the most
 * recent failure until a fully-successful job clears it.
 */
async function flushSecDiagnostics(env: Env, collectedAt: string, sec: SecEnrichmentDiagnostics): Promise<void> {
  if (sec.attempts === 0) return;
  await setEarningsMeta(env.DB, EARNINGS_META_KEYS.secLastAttempt, collectedAt);
  if (sec.successes > 0) {
    await setEarningsMeta(env.DB, EARNINGS_META_KEYS.secLastSuccess, collectedAt);
    await setEarningsMeta(env.DB, EARNINGS_META_KEYS.secConsecutiveFailures, "0");
  }
  if (sec.failures > 0) {
    if (sec.lastError) await setEarningsMeta(env.DB, EARNINGS_META_KEYS.secLastError, sec.lastError.slice(0, 480));
    if (sec.successes === 0) {
      const previous = await readEarningsMeta(env.DB, EARNINGS_META_KEYS.secConsecutiveFailures).catch(() => null);
      const previousCount = previous && /^\d+$/.test(previous) ? Number(previous) : 0;
      await setEarningsMeta(env.DB, EARNINGS_META_KEYS.secConsecutiveFailures, String(Math.min(999, previousCount + sec.failures)));
    }
  } else {
    await clearEarningsMeta(env.DB, EARNINGS_META_KEYS.secLastError);
  }
}

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
  sec: SecEnrichmentDiagnostics,
): Promise<{ metadata: Awaited<ReturnType<typeof readUniverseMetadata>>; activeSymbols: ReadonlySet<string>; warnings: string[] }> {
  await reconcileCoreUniverse(env.DB, CORE_UNIVERSE, CORE_UNIVERSE_VERSION, collectedAt);
  const previous = await readUniverseMetadata(env.DB).catch(() => new Map<string, { company: string; cik: string | null; investorRelationsUrl: string | null }>());
  const warnings: string[] = [];
  let metadata = new Map<string, { company: string; cik: string | null; investorRelationsUrl: string | null }>();
  try {
    const result = await providers.official.fetchCompanyMetadata(collectedAt);
    recordSecSuccess(sec);
    warnings.push(...result.warnings);
    const bySymbol = new Map(result.observations.map((item) => [normalizeSymbol(item.symbol), item]));
    await upsertUniverseMembers(env.DB, CORE_UNIVERSE.map((symbol) => {
      const secRow = bySymbol.get(symbol);
      return {
        symbol,
        company: secRow?.company ?? previous.get(symbol)?.company ?? symbol,
        cik: secRow?.cik ?? previous.get(symbol)?.cik ?? null,
        exchange: secRow?.exchange ?? null,
        investorRelationsUrl: secRow?.investorRelationsUrl ?? previous.get(symbol)?.investorRelationsUrl ?? null,
        indexes: [],
        updatedAt: collectedAt,
      };
    }));
  } catch (error) {
    // SEC company metadata is best-effort enrichment. A failure is recorded
    // as enrichment diagnostics + a log line, but it must not degrade the
    // critical earnings health gate (calendarError/monitorError/lastError).
    recordSecAttempt(sec, error);
    console.warn(JSON.stringify({ message: "earnings universe metadata degraded", error: errorMessage(error).slice(0, 180) }));
    // A metadata outage must not erase the last known CIK/company values.
    await upsertUniverseMembers(env.DB, CORE_UNIVERSE.map((symbol) => ({
      symbol,
      company: previous.get(symbol)?.company ?? symbol,
      cik: previous.get(symbol)?.cik ?? null,
      exchange: null,
      investorRelationsUrl: previous.get(symbol)?.investorRelationsUrl ?? null,
      indexes: [],
      updatedAt: collectedAt,
    })));
  }
  metadata = await readUniverseMetadata(env.DB);
  return { metadata, activeSymbols: await readActiveUniverseSymbols(env.DB), warnings };
}

async function findFiling(
  providers: EarningsProviderBundle,
  event: Pick<EarningsEngineEvent, "symbol" | "scheduledDate" | "fiscalPeriodEnd" | "cik">,
  today: string,
  sec: SecEnrichmentDiagnostics,
): Promise<OfficialFiling | null> {
  if (!event.cik || !event.scheduledDate || event.scheduledDate > today) return null;
  try {
    const filing = await providers.official.findRelevantFiling(event, today);
    recordSecSuccess(sec);
    return filing;
  } catch (error) {
    // Filing lookup is best-effort enrichment: record the failure in the SEC
    // diagnostics (and the log) but keep the event usable without it.
    recordSecAttempt(sec, error);
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
  secAttempts?: number;
  secFailures?: number;
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
    ...(fields.secAttempts !== undefined ? { secAttempts: fields.secAttempts } : {}),
    ...(fields.secFailures !== undefined ? { secFailures: fields.secFailures } : {}),
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
  sec: SecEnrichmentDiagnostics,
): Promise<NormalizedEarningsEvent> {
  const member = metadata.get(observation.symbol);
  const base = normalizeEvent(observation, today, collectedAt, member, null);
  const withProviderNames = applyProviderNames(base, providers);
  const canLookupFiling = !observation.officialFiling
    && filingLookups.used < filingLookups.limit
    && withProviderNames.scheduledDate !== null
    && (withProviderNames.status === "reported" || withProviderNames.scheduledDate <= today);
  const filing = canLookupFiling ? await findFiling(providers, withProviderNames, today, sec) : null;
  if (canLookupFiling) filingLookups.used += 1;
  const final = filing
    ? applyProviderNames(normalizeEvent(observation, today, collectedAt, member, filing), providers)
    : withProviderNames;
  return final;
}

async function readProviderCalendar(
  providers: EarningsProviderBundle,
  range: EarningsDateRange,
  activeSymbols: ReadonlySet<string>,
  collectedAt: string,
): Promise<{ observations: EarningsCalendarObservation[]; provider: string; warnings: string[]; success: boolean; complete: boolean }> {
  const activeObservations = (observations: EarningsCalendarObservation[]): EarningsCalendarObservation[] => observations.flatMap((observation) => {
    const symbol = normalizeSymbol(observation.symbol);
    return activeSymbols.has(symbol)
      ? [{ ...observation, symbol }]
      : [];
  });
  const activeConsensusObservations = (observations: EarningsConsensusObservation[]): EarningsConsensusObservation[] => observations.flatMap((observation) => {
    const symbol = normalizeSymbol(observation.symbol);
    return activeSymbols.has(symbol)
      ? [{ ...observation, symbol }]
      : [];
  });
  try {
    const calendar = await providers.calendar.fetchCalendar(range, activeSymbols, collectedAt);
    if (Object.is(providers.calendar, providers.consensus)) {
      return {
        observations: activeObservations(calendar.observations),
        provider: calendar.provider,
        warnings: calendar.warnings,
        success: true,
        complete: calendar.complete !== false,
      };
    }
    let consensus: Awaited<ReturnType<EarningsConsensusProvider["fetchConsensus"]>>;
    try {
      consensus = await providers.consensus.fetchConsensus(range, activeSymbols, collectedAt);
    } catch (error) {
      // A calendar is still useful when estimates/actuals are temporarily
      // unavailable from a separate adapter. Keep the valid calendar rows.
      return {
        observations: activeObservations(calendar.observations),
        provider: calendar.provider,
        warnings: [...calendar.warnings, `consensus degraded: ${errorMessage(error)}`],
        success: true,
        complete: calendar.complete !== false,
      };
    }
    const map = providerConsensusMap(activeConsensusObservations(consensus.observations));
    return {
      observations: activeObservations(calendar.observations).map((observation) => mergeCalendarAndConsensus(observation, matchConsensus(observation, map))),
      provider: calendar.provider,
      warnings: [...calendar.warnings, ...consensus.warnings],
      success: true,
      complete: calendar.complete !== false,
    };
  } catch (error) {
    return { observations: [], provider: providers.calendar.name, warnings: [errorMessage(error)], success: false, complete: false };
  }
}

const RECOVERY_META_KEYS = {
  lastAttempt: "earningsRecoveryLastAttemptAt",
  lastSuccess: "earningsRecoveryLastSuccessAt",
  lastError: "earningsRecoveryLastError",
} as const;

interface HistoricalRecoveryResult {
  observations: EarningsCalendarObservation[];
  requests: number;
  successes: number;
  failures: number;
  skipped: number;
  symbols: string[];
}

/**
 * Targeted historical recovery (verified against production 2026-08-16).
 *
 * The bulk Earnings Calendar caps its payload at ~1500 rows dominated by
 * near-term dates, so recently reported large caps (MSFT 2026-07-29, AAPL
 * 2026-07-30) are absent from the bulk response while the symbol-scoped
 * query returns them with full EPS/revenue estimates AND actuals.
 *
 * Recovery only covers active Core symbols that (a) are absent from the bulk
 * response for this window AND (b) hold no reported event in D1 for the
 * window. It is capped per run and paced to the free-tier rate budget.
 * Failures are recorded in their own diagnostics keys and NEVER feed the
 * critical calendar health gate: the bulk pipeline stays authoritative.
 */
async function recoverMissingHistory(
  env: Env,
  providers: EarningsProviderBundle,
  activeSymbols: ReadonlySet<string>,
  bulkObservations: EarningsCalendarObservation[],
  range: EarningsDateRange,
  collectedAt: string,
  cap: number,
  pacingMs: number,
): Promise<HistoricalRecoveryResult> {
  const empty: HistoricalRecoveryResult = { observations: [], requests: 0, successes: 0, failures: 0, skipped: 0, symbols: [] };
  const fetchHistory = providers.calendar.fetchSymbolHistory;
  if (typeof fetchHistory !== "function") return empty;
  // Only a bulk row inside the historical window proves the past report is
  // already present. A future scheduled date in the +60d half of the bulk
  // payload must not skip recovery of a missing last-30-day report.
  const bulkHistoricalSymbols = new Set(
    bulkObservations
      .filter((observation) => observation.scheduledDate !== null
        && observation.scheduledDate >= range.from
        && observation.scheduledDate <= range.to)
      .map((observation) => normalizeSymbol(observation.symbol)),
  );
  const reportedRecent = await readRecentReportedSymbols(env.DB, range.from, range.to);
  // Symbols probed recently (with or without results) rest outside the
  // candidate set until the stamp expires, so empty probes cannot starve
  // alphabetically-later symbols.
  const checkedCutoff = addDays(range.to, -7);
  const recentlyChecked = await readRecentlyCheckedRecoverySymbols(env.DB, checkedCutoff);
  const missing = [...activeSymbols]
    .filter((symbol) => !bulkHistoricalSymbols.has(symbol) && !reportedRecent.has(symbol) && !recentlyChecked.has(symbol))
    .sort();
  if (missing.length === 0) return empty;
  const targeted = missing.slice(0, cap);
  const observations: EarningsCalendarObservation[] = [];
  const symbols: string[] = [];
  const failures: string[] = [];
  for (const symbol of targeted) {
    if (pacingMs > 0) await new Promise((resolve) => setTimeout(resolve, pacingMs));
    try {
      const result = await fetchHistory.call(providers.calendar, symbol, range, collectedAt);
      observations.push(...result.observations);
      symbols.push(symbol);
    } catch (error) {
      failures.push(`${symbol}: ${errorMessage(error).slice(0, 160)}`);
    }
    // Stamp the probe regardless of outcome so empty results expire out of
    // the candidate set (7-day rest) instead of blocking later symbols.
    await setEarningsMeta(env.DB, recoveryCheckedMetaKey(symbol), collectedAt);
  }
  await setEarningsMeta(env.DB, RECOVERY_META_KEYS.lastAttempt, collectedAt);
  if (symbols.length > 0) await setEarningsMeta(env.DB, RECOVERY_META_KEYS.lastSuccess, collectedAt);
  if (failures.length > 0) await setEarningsMeta(env.DB, RECOVERY_META_KEYS.lastError, failures[0]!.slice(0, 240));
  else await clearEarningsMeta(env.DB, RECOVERY_META_KEYS.lastError);
  return {
    observations,
    requests: targeted.length,
    successes: symbols.length,
    failures: failures.length,
    skipped: missing.length - targeted.length,
    symbols,
  };
}

async function runCalendarSync(
  env: Env,
  scheduledTime: Date,
  providers: EarningsProviderBundle,
  pacingMs = FINNHUB_RATE_PACING_MS,
): Promise<{ status: "ok" | "degraded"; detail: string }> {
  const startedAt = Date.now();
  const collectedAt = scheduledTime.toISOString();
  const today = newYorkDate(scheduledTime);
  const range = { from: addDays(today, -EARNINGS_BACKFILL_DAYS), to: addDays(today, EARNINGS_WINDOW_DAYS) };
  // The daily sync owns the initial historical backfill as well as the
  // rolling future window. Providers may return fewer rows when they do not
  // publish forward schedules; missing values remain NULL/Not Available.
  const providerRange = range;
  await recordEarningsAttempt(env, collectedAt);
  const sec = newSecDiagnostics();
  const universe = await syncUniverse(env, providers, collectedAt, sec);
  const metadata = universe.metadata;
  const calendar = await readProviderCalendar(providers, providerRange, universe.activeSymbols, collectedAt);
  if (!calendar.success) {
    const detail = calendar.warnings[0]?.slice(0, 200) ?? "calendar unavailable";
    await rememberEarningsFailure(env, "calendar", collectedAt, detail);
    await flushSecDiagnostics(env, collectedAt, sec);
    logEarningsJob({
      job: "calendar",
      provider: providers.calendar.name,
      range,
      observations: 0,
      normalized: 0,
      written: 0,
      secLookups: 0,
      secAttempts: sec.attempts,
      secFailures: sec.failures,
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
  // Critical warnings come from the calendar pipeline only (Finnhub). SEC
  // enrichment warnings are diagnostics: they must not set the calendar
  // failure key that drives critical earnings health.
  const warnings = [...calendar.warnings];
  const enrichmentWarnings = [...universe.warnings];
  // Targeted historical recovery: active Core symbols absent from the bulk
  // response (bulk caps at ~1500 rows, dominated by near-term dates) get one
  // symbol-scoped query for the past-30-day window. Recovery diagnostics stay
  // out of the critical failure keys; failures are isolated per symbol.
  const coverage = await readMetadataCoverage(env.DB);
  const bootstrapMode = coverage.active > 0
    && coverage.missing >= Math.ceil(coverage.active * METADATA_BOOTSTRAP_THRESHOLD);
  const recovery = await recoverMissingHistory(
    env,
    providers,
    universe.activeSymbols,
    calendar.observations,
    { from: providerRange.from, to: today },
    collectedAt,
    bootstrapMode ? MAX_HISTORICAL_RECOVERY_SYMBOLS_PER_BOOTSTRAP : MAX_HISTORICAL_RECOVERY_SYMBOLS_PER_JOB,
    pacingMs,
  );
  if (recovery.requests > 0) {
    console.info(JSON.stringify({
      job: "earnings-recovery",
      requests: recovery.requests,
      successes: recovery.successes,
      failures: recovery.failures,
      skipped: recovery.skipped,
      symbols: recovery.symbols,
    }));
  }
  // Bulk observations stay authoritative; recovery only contributes symbols
  // the bulk omitted, deduplicated deterministically by provider event id /
  // symbol:date before normalization.
  const observations = deduplicateCalendarRows([...calendar.observations, ...recovery.observations]);
  for (const observation of observations) {
    try {
      normalized.push(await normalizeObservation(providers, observation, today, collectedAt, metadata, filingLookups, sec));
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
  await flushSecDiagnostics(env, collectedAt, sec);
  // Best-effort Finnhub Company Profile 2 enrichment. Runs AFTER the calendar
  // outcome and failure keys are recorded so a profile outage can never
  // degrade the critical earnings health gate; the result is only observable
  // through the metadata diagnostics meta keys (/healthz/sources enrichment).
  const metadataResult = await enrichUniverseMetadata(env, providers, collectedAt, pacingMs).catch((error) => {
    console.warn(JSON.stringify({ message: "earnings universe metadata enrichment degraded", error: errorMessage(error).slice(0, 180) }));
    return { requests: 0, successes: 0, failures: 0, symbols: [] };
  });
  if (metadataResult.requests > 0) {
    console.info(JSON.stringify({
      job: "earnings-metadata",
      provider: providers.profile?.name ?? "none",
      requests: metadataResult.requests,
      successes: metadataResult.successes,
      failures: metadataResult.failures,
      symbols: metadataResult.symbols,
    }));
  }
  // Job status mirrors the critical Earnings/calendar pipeline only. SEC
  // enrichment failures remain visible in the SEC diagnostics (meta keys +
  // secAttempts/secFailures on the log line) but never degrade the job.
  const status = warnings.length > 0 ? "degraded" : "ok";
  const detail = `${written}/${observations.length} events in ${range.from}..${range.to}`;
  logEarningsJob({
    job: "calendar",
    provider: providers.calendar.name,
    range,
    observations: observations.length,
    normalized: normalized.length,
    written,
    secLookups: filingLookups.used,
    secAttempts: sec.attempts,
    secFailures: sec.failures,
    status,
    durationMs: Date.now() - startedAt,
    warningCount: warnings.length + enrichmentWarnings.length,
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
  const sec = newSecDiagnostics();
  const activeUniverseSymbols = await readActiveUniverseSymbols(env.DB);
  const calendar = await readProviderCalendar(providers, range, activeUniverseSymbols, collectedAt);
  if (!calendar.success) {
    const detail = calendar.warnings[0]?.slice(0, 200) ?? "calendar unavailable";
    await rememberEarningsFailure(env, "monitor", collectedAt, detail);
    await flushSecDiagnostics(env, collectedAt, sec);
    logEarningsJob({ job: "monitor", provider: providers.calendar.name, range, observations: 0, normalized: 0, written: 0, secLookups: 0, secAttempts: sec.attempts, secFailures: sec.failures, status: "degraded", durationMs: Date.now() - startedAt, warningCount: calendar.warnings.length, detail });
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
      normalized.push(await normalizeObservation(providers, observation, today, collectedAt, metadata, filingLookups, sec));
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
      normalized.push(await normalizeObservation(providers, observation, today, collectedAt, metadata, filingLookups, sec));
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
  await flushSecDiagnostics(env, collectedAt, sec);
  // Same separation as the calendar job: status reflects the critical
  // Finnhub-backed monitoring path only; SEC failures stay diagnostic.
  const status = warnings.length > 0 ? "degraded" : "ok";
  const detail = `${successes}/${Math.max(active.length, todayObservations.length)} events checked; provider=ok`;
  logEarningsJob({ job: "monitor", provider: providers.calendar.name, range, observations: calendar.observations.length, normalized: normalized.length, written: normalized.length, secLookups: filingLookups.used, secAttempts: sec.attempts, secFailures: sec.failures, status, durationMs: Date.now() - startedAt, warningCount: warnings.length, detail });
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
  pacingMs = FINNHUB_RATE_PACING_MS,
): Promise<{ status: "ok" | "degraded" | "skipped"; detail: string }> {
  if (mode === "calendar") return runCalendarSync(env, scheduledTime, providers, pacingMs);
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
      next30Days: events.filter((event) => isWithinInclusive(event.scheduledDate, today, addDays(today, EARNINGS_SUMMARY_WINDOW_DAYS))).length,
    },
    from,
    to,
  };
}

export { rowToEarningsEvent };
