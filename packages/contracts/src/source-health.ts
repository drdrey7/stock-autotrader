import { z } from "zod";
import { isoTimestampSchema } from "./primitives";

export const sourceStateValues = [
  "Live",
  "Cached",
  "Stale",
  "Unavailable",
  "Error",
] as const;

export type SourceState = (typeof sourceStateValues)[number];

export const earningsEngineStateValues = [
  "UNINITIALIZED",
  "HEALTHY",
  "STALE",
  "DEGRADED",
] as const;

export type EarningsEngineState = (typeof earningsEngineStateValues)[number];

/**
 * Non-critical enrichment diagnostics for one best-effort provider path.
 * Never part of the critical gate: consecutiveFailures counts failed calls
 * since the last success for that path only.
 */
export const enrichmentDiagnosticsSchema = z.object({
  provider: z.string().trim().min(1).max(128),
  lastAttempt: isoTimestampSchema.nullable(),
  lastSuccess: isoTimestampSchema.nullable(),
  lastError: z.string().trim().max(500).nullable(),
  consecutiveFailures: z.number().int().nonnegative(),
});

export type EnrichmentDiagnostics = z.infer<typeof enrichmentDiagnosticsSchema>;

/** @deprecated Prefer enrichmentDiagnosticsSchema — kept as a stable alias. */
export const secEnrichmentHealthSchema = enrichmentDiagnosticsSchema;
/** @deprecated Prefer EnrichmentDiagnostics — kept as a stable alias. */
export type SecEnrichmentHealth = EnrichmentDiagnostics;

/**
 * Earnings best-effort enrichment bundle. SEC EDGAR (filings/CIK) and Finnhub
 * Company Profile 2 (logos/industry) are independent diagnostic paths; either
 * can fail without degrading critical calendar health.
 */
export const earningsEnrichmentHealthSchema = z.object({
  sec: enrichmentDiagnosticsSchema,
  metadata: enrichmentDiagnosticsSchema,
});

export type EarningsEnrichmentHealth = z.infer<typeof earningsEnrichmentHealthSchema>;

/**
 * Provider/read-model freshness metadata shared by every public data domain.
 * Nullable timestamps are intentional for sources that have not succeeded yet.
 */
export const sourceHealthSchema = z.strictObject({
  provider: z.string().trim().min(1).max(128),
  state: z.enum(sourceStateValues),
  asOf: isoTimestampSchema.nullable(),
  ageSeconds: z.number().int().nonnegative().nullable(),
  staleAfterSeconds: z.number().int().positive(),
  lastSuccess: isoTimestampSchema.nullable(),
  lastAttempt: isoTimestampSchema.nullable(),
  error: z.string().trim().min(1).max(500).nullable(),
  engineState: z.enum(earningsEngineStateValues).optional(),
  enrichment: earningsEnrichmentHealthSchema.optional(),
}).superRefine((source, ctx) => {
  const hasData = source.asOf !== null && source.ageSeconds !== null && source.lastSuccess !== null;
  const add = (path: (string | number)[], message: string) =>
    ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });

  if (source.state === "Live") {
    if (!hasData) add(["asOf"], "Live sources require a current data timestamp");
    if (source.lastAttempt === null) add(["lastAttempt"], "Live sources require an attempt timestamp");
    if (source.ageSeconds !== null && source.ageSeconds > source.staleAfterSeconds) {
      add(["ageSeconds"], "Live sources cannot be older than staleAfterSeconds");
    }
    if (source.error !== null) add(["error"], "Live sources cannot carry an error");
  }

  if (source.state === "Cached" || source.state === "Stale") {
    if (!hasData) add(["asOf"], `${source.state} sources require retained data metadata`);
  }

  if (source.state === "Unavailable") {
    if (source.asOf !== null) add(["asOf"], "Unavailable sources cannot expose data as of");
    if (source.ageSeconds !== null) add(["ageSeconds"], "Unavailable sources cannot expose data age");
    if (source.lastSuccess !== null) add(["lastSuccess"], "Unavailable sources have no successful update");
  }

  if (source.state === "Error") {
    if (source.error === null) add(["error"], "Error sources require an error message");
    if (source.asOf !== null) add(["asOf"], "Error sources cannot expose unvalidated data as of");
    if (source.ageSeconds !== null) add(["ageSeconds"], "Error sources cannot expose unvalidated data age");
    if (source.lastSuccess !== null) add(["lastSuccess"], "Error sources have no successful update");
    if (source.lastAttempt === null) add(["lastAttempt"], "Error sources require an attempt timestamp");
  }
});

export type SourceHealth = z.infer<typeof sourceHealthSchema>;

export const publicSourceHealthKeys = [
  "briefing",
  "market",
  "opportunities",
  "x",
  "earnings",
  "sentiment",
  "quickStats",
] as const;

export const publicSourceHealthSchema = z.strictObject({
  briefing: sourceHealthSchema,
  market: sourceHealthSchema,
  opportunities: sourceHealthSchema,
  x: sourceHealthSchema,
  earnings: sourceHealthSchema,
  sentiment: sourceHealthSchema,
  quickStats: sourceHealthSchema,
});

export type PublicSourceHealth = z.infer<typeof publicSourceHealthSchema>;
