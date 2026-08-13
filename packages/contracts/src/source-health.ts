import { z } from "zod";

export const sourceStateValues = [
  "Live",
  "Cached",
  "Stale",
  "Unavailable",
  "Error",
] as const;

export type SourceState = (typeof sourceStateValues)[number];

const isoTimestamp = z.string().datetime({ offset: true });

/**
 * Provider/read-model freshness metadata shared by every public data domain.
 * Nullable timestamps are intentional for sources that have not succeeded yet.
 */
export const sourceHealthSchema = z.strictObject({
  provider: z.string().trim().min(1).max(128),
  state: z.enum(sourceStateValues),
  asOf: isoTimestamp.nullable(),
  ageSeconds: z.number().int().nonnegative().nullable(),
  staleAfterSeconds: z.number().int().positive(),
  lastSuccess: isoTimestamp.nullable(),
  lastAttempt: isoTimestamp.nullable(),
  error: z.string().trim().min(1).max(500).nullable(),
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
