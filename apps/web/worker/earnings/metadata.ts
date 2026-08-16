import type { Env } from "../index";
import {
  clearEarningsMeta,
  readEarningsMeta,
  readUniverseMetadataCandidates,
  setEarningsMeta,
  upsertUniverseMembers,
} from "./storage";
import type { EarningsProviderBundle } from "./types";

/**
 * Finnhub Company Profile 2 universe enrichment (PR — earnings metadata).
 *
 * Company profile data is stable and changes rarely, so it is refreshed
 * infrequently: one bounded batch per daily calendar sync, only for active
 * Core members whose metadata is missing or older than the TTL, capped at
 * METADATA_REFRESH_PER_RUN requests per run. The frontend never calls
 * Finnhub; the API key stays server-side and the persisted values are just
 * the external logo URL and small text fields (never image binary).
 *
 * This is strictly best-effort enrichment. Failures are recorded in their
 * own diagnostics meta keys and NEVER feed the critical earnings health keys
 * (calendarError/monitorError/lastError): a profile outage must not degrade
 * the earnings calendar the way the Finnhub calendar path does.
 */

export const METADATA_PROFILE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
export const METADATA_REFRESH_PER_RUN = 15;

export const METADATA_META_KEYS = {
  lastAttempt: "earningsMetadataLastAttemptAt",
  lastSuccess: "earningsMetadataLastSuccessAt",
  lastError: "earningsMetadataLastError",
  consecutiveFailures: "earningsMetadataConsecutiveFailures",
} as const;

interface MetadataEnrichmentResult {
  requests: number;
  successes: number;
  failures: number;
  symbols: string[];
}

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

/**
 * Best-effort profile enrichment for stale Core members. Never throws:
 * every sub-request failure is absorbed into the result + diagnostics.
 * Rows keep their last known good metadata because the universe update uses
 * COALESCE — a failed run cannot erase an existing logo/industry/website.
 */
export async function enrichUniverseMetadata(
  env: Env,
  providers: EarningsProviderBundle,
  collectedAt: string,
): Promise<MetadataEnrichmentResult> {
  const profile = providers.profile;
  if (!profile) return { requests: 0, successes: 0, failures: 0, symbols: [] };
  const staleBefore = new Date(Date.now() - METADATA_PROFILE_TTL_MS).toISOString();
  const candidates = await readUniverseMetadataCandidates(env.DB, staleBefore, METADATA_REFRESH_PER_RUN);
  if (candidates.length === 0) return { requests: 0, successes: 0, failures: 0, symbols: [] };

  const symbols: string[] = [];
  const failures: string[] = [];
  for (const candidate of candidates) {
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
        metadataProvider: profile.name,
        metadataUpdatedAt: collectedAt,
        updatedAt: collectedAt,
      }]);
      symbols.push(candidate.symbol);
    } catch (error) {
      // Failed symbols are left untouched (last-known-good preserved) and
      // stay candidates for the next run — but the per-run cap plus the
      // 14-day success TTL keep steady-state request volume tiny.
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
  return { requests: candidates.length, successes: symbols.length, failures: failures.length, symbols };
}