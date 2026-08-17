import type { Env } from "../index";
import {
  clearEarningsMeta,
  readActiveUniverseSymbols,
  readEarningsMeta,
  readUniverseMetadataCandidates,
  setEarningsMeta,
  stampUniverseMetadataAttempt,
  upsertUniverseMembers,
} from "./storage";
import { MAX_FINNHUB_PROFILE_REQUESTS_PER_JOB } from "./subrequest-budget";
import type { Database } from "./storage";
import type { EarningsProviderBundle } from "./types";

/**
 * Finnhub Company Profile 2 universe enrichment (PR — earnings metadata).
 *
 * Company profile data is stable and changes rarely, so it is refreshed
 * infrequently: one bounded maintenance batch per daily calendar sync, only
 * for active Core members whose metadata is missing or older than the TTL.
 * The frontend never calls Finnhub; the API key stays server-side and the
 * persisted values are just the external logo URL and small text fields
 * (never image binary).
 *
 * This is strictly best-effort enrichment. Failures are recorded in their
 * own diagnostics meta keys and NEVER feed the critical earnings health keys
 * (calendarError/monitorError/lastError): a profile outage must not degrade
 * the earnings calendar the way the Finnhub calendar path does.
 *
 * Production D1 was bootstrapped externally. The Worker stays in maintenance
 * mode only — no aggressive multi-day Core bootstrap inside the daily job.
 * Heavy backfills remain out of scope for the Worker.
 *
 * Per-symbol `metadata_attempted_at` cools failed/partial candidates so the
 * cap of 2/run cannot starve later Core symbols forever.
 *
 * Physical Finnhub pacing is enforced by FinnhubRequestGate inside the
 * provider (every HTTP attempt, including retries). Do not re-sleep here.
 */

export const METADATA_PROFILE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
/** Failed/partial profile attempts rest this long before re-entering the queue. */
export const METADATA_PROFILE_ATTEMPT_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
/** @deprecated Use MAX_FINNHUB_PROFILE_REQUESTS_PER_JOB — kept as an alias for older tests. */
export const METADATA_REFRESH_PER_RUN = MAX_FINNHUB_PROFILE_REQUESTS_PER_JOB;

export const METADATA_META_KEYS = {
  lastAttempt: "earningsMetadataLastAttemptAt",
  lastSuccess: "earningsMetadataLastSuccessAt",
  lastError: "earningsMetadataLastError",
  consecutiveFailures: "earningsMetadataConsecutiveFailures",
} as const;

export const METADATA_PROVIDER_NAME = "finnhub-company-profile";

interface MetadataEnrichmentResult {
  requests: number;
  successes: number;
  failures: number;
  symbols: string[];
  /** Always false: the Worker no longer runs an aggressive bootstrap mode. */
  bootstrap: boolean;
}

export interface MetadataCoverage {
  active: number;
  missing: number;
}

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

/**
 * Active Core members and how many of them have never been enriched.
 * `missing` counts members with no logo/industry and no metadata stamp at
 * all — TTL-stale members (metadata older than the refresh window) are NOT
 * missing, they just need a periodic refresh under the normal cap.
 * Cooldown is ignored here: coverage is about data completeness, not queue eligibility.
 */
export async function readMetadataCoverage(db: Database): Promise<MetadataCoverage> {
  const [active, candidates] = await Promise.all([
    readActiveUniverseSymbols(db),
    // epoch staleBefore + epoch cooldownBefore: every never-enriched member
    // is counted regardless of recent failed attempts.
    readUniverseMetadataCandidates(db, "1970-01-01T00:00:00.000Z", "1970-01-01T00:00:00.000Z", 1000),
  ]);
  return { active: active.size, missing: candidates.length };
}

/**
 * Best-effort profile enrichment for stale Core members. Never throws:
 * every sub-request failure is absorbed into the result + diagnostics.
 * Rows keep their last known good metadata because the universe update uses
 * COALESCE — a failed run cannot erase an existing logo/industry/website.
 *
 * Finnhub pacing is provider-level (FinnhubRequestGate). The optional
 * `pacingMs` argument is retained only for call-site compatibility and is ignored.
 */
export async function enrichUniverseMetadata(
  env: Env,
  providers: EarningsProviderBundle,
  collectedAt: string,
  // retained for call-site compatibility; pacing is provider-level now
  pacingMs = 0,
): Promise<MetadataEnrichmentResult> {
  void pacingMs;
  const profile = providers.profile;
  if (!profile) return { requests: 0, successes: 0, failures: 0, symbols: [], bootstrap: false };
  const cap = MAX_FINNHUB_PROFILE_REQUESTS_PER_JOB;
  const nowMs = Date.parse(collectedAt);
  const anchorMs = Number.isFinite(nowMs) ? nowMs : Date.now();
  const staleBefore = new Date(anchorMs - METADATA_PROFILE_TTL_MS).toISOString();
  const cooldownBefore = new Date(anchorMs - METADATA_PROFILE_ATTEMPT_COOLDOWN_MS).toISOString();
  const candidates = await readUniverseMetadataCandidates(env.DB, staleBefore, cooldownBefore, cap);
  if (candidates.length === 0) return { requests: 0, successes: 0, failures: 0, symbols: [], bootstrap: false };

  const symbols: string[] = [];
  const failures: string[] = [];
  for (const candidate of candidates) {
    // Finnhub physical-request pacing lives in FinnhubRequestGate (per attempt).
    await stampUniverseMetadataAttempt(env.DB, candidate.symbol, collectedAt);
    try {
      const profileObservation = await profile.fetchProfile(candidate.symbol, collectedAt);
      await upsertUniverseMembers(env.DB, [{
        symbol: candidate.symbol,
        company: profileObservation.company ?? candidate.company,
        cik: null,
        exchange: profileObservation.exchange ?? null,
        investorRelationsUrl: undefined,
        indexes: [],
        logoUrl: profileObservation.logoUrl,
        industry: profileObservation.industry,
        websiteUrl: profileObservation.websiteUrl,
        // Explicit Finnhub stamp only when this path actually updated metadata.
        metadataProvider: profile.name,
        metadataUpdatedAt: collectedAt,
        updatedAt: collectedAt,
      }]);
      symbols.push(candidate.symbol);
    } catch (error) {
      // Failed symbols keep last-known-good fields (COALESCE) and rest for
      // METADATA_PROFILE_ATTEMPT_COOLDOWN_MS via metadata_attempted_at.
      failures.push(`${candidate.symbol}: ${errorMessage(error).slice(0, 160)}`);
    }
  }

  await setEarningsMeta(env.DB, METADATA_META_KEYS.lastAttempt, collectedAt);
  if (symbols.length > 0) {
    await setEarningsMeta(env.DB, METADATA_META_KEYS.lastSuccess, collectedAt);
    await setEarningsMeta(env.DB, METADATA_META_KEYS.consecutiveFailures, "0");
  }
  if (failures.length > 0) {
    await setEarningsMeta(env.DB, METADATA_META_KEYS.lastError, failures[0]!.slice(0, 240));
    if (symbols.length === 0) {
      const previous = await readEarningsMeta(env.DB, METADATA_META_KEYS.consecutiveFailures).catch(() => null);
      const previousCount = previous && /^\d+$/.test(previous) ? Number(previous) : 0;
      await setEarningsMeta(env.DB, METADATA_META_KEYS.consecutiveFailures, String(Math.min(999, previousCount + failures.length)));
    }
  } else {
    await clearEarningsMeta(env.DB, METADATA_META_KEYS.lastError);
  }
  return { requests: candidates.length, successes: symbols.length, failures: failures.length, symbols, bootstrap: false };
}
