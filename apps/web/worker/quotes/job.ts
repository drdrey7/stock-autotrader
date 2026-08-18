import type { Env } from "../index";
import { CORE_UNIVERSE } from "@stock-autotrader/contracts";
import { marketCollectionWindow } from "../market-context";
import { QUOTES_SHARD_WORST_CASE_EXTERNAL_SUBREQUESTS } from "./budget";
import { FinnhubQuoteProvider } from "./finnhub";
import { rememberQuotesHealth, readQuotesHealth } from "./health";
import type { QuoteProvider } from "./provider";
import { shardIndexForMinute, shardUniverse } from "./shard";
import { upsertLatestQuotes } from "./storage";

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

/**
 * Per-minute Screener quote shard job.
 *
 * Market-aware (America/New_York, DST-safe via the existing market calendar):
 * runs ONLY inside the regular + post-close windows — outside them it is a
 * pure no-op (no HTTP, no D1 writes) and the last known quotes keep being
 * served. Including the post-close window guarantees a final snapshot near
 * the close (16:45 ET). The 15-minute and 06:00 jobs are untouched; this runs
 * on its own dedicated 1-minute trigger.
 *
 * External-subrequest worst case: 5 symbols × MAX_PROVIDER_ATTEMPTS = the
 * constant budget, a deliberate margin below the Workers Free 50/invocation
 * cap (see quotes/budget.ts) and half the previous per-minute claim on the
 * shared Finnhub key. Serial collection paces each request 1.1 s apart via the
 * shared gate; one shard completes in roughly 6 s.
 */
export async function runQuotesShardJob(
  env: Env,
  scheduledTime: Date,
  provider?: QuoteProvider,
): Promise<{ status: "ok" | "degraded" | "skipped"; detail: string }> {
  const window = marketCollectionWindow(scheduledTime);
  if (!window) {
    console.info(JSON.stringify({
      job: "quotes-shard",
      phase: "result",
      scheduledTime: scheduledTime.toISOString(),
      status: "skipped",
      detail: "market_closed",
      externalSubrequests: 0,
      rowsWritten: 0,
      durationMs: 0,
    }));
    return { status: "skipped", detail: "market_closed" };
  }
  const startedAt = Date.now();
  const collectedAt = scheduledTime.toISOString();
  const shardIndex = shardIndexForMinute(scheduledTime.getTime());
  const symbols = shardUniverse(CORE_UNIVERSE)[shardIndex] ?? [];
  const previous = await readQuotesHealth(env.DB);
  // Deterministic provider label for health/logs; the default (Finnhub)
  // adapter owns this name, an injected provider supplies its own.
  const providerName = provider?.name ?? "finnhub-quote";

  // Only the default path needs the Finnhub secret — an explicitly injected
  // provider is testable without it. Trim so a whitespace-only env value is
  // treated as unset and never reaches the FinnhubQuoteProvider constructor
  // (which throws on a blank key). A missing key persists a degraded health
  // record instead of failing silently.
  const configuredKey = (env.FINNHUB_API_KEY ?? "").trim();
  if (!provider && !configuredKey) {
    const detail = "FINNHUB_API_KEY is not configured";
    console.error(JSON.stringify({
      job: "quotes-shard",
      phase: "result",
      scheduledTime: scheduledTime.toISOString(),
      window,
      shard: shardIndex,
      status: "degraded",
      detail,
    }));
    await rememberQuotesHealth(env.DB, {
      provider: "unavailable",
      status: "degraded",
      lastAttemptAt: collectedAt,
      lastSuccessAt: previous?.lastSuccessAt ?? null,
      lastError: detail,
      rowsWritten: 0,
      lastShard: shardIndex,
      rateLimited: false,
    });
    return { status: "degraded", detail };
  }

  try {
    // Constructed inside the try so a provider construction failure also
    // degrades health instead of escaping the job as an unhandled rejection.
    const activeProvider: QuoteProvider = provider ?? new FinnhubQuoteProvider(configuredKey);
    await rememberQuotesHealth(env.DB, {
      provider: providerName,
      status: "running",
      lastAttemptAt: collectedAt,
      lastSuccessAt: previous?.lastSuccessAt ?? null,
      lastError: previous?.lastError ?? null,
      rowsWritten: 0,
      lastShard: shardIndex,
      rateLimited: false,
    });

    const result = await activeProvider.collect(symbols, collectedAt);
    const rowsWritten = await upsertLatestQuotes(env.DB, result.observations, collectedAt);
    const failed = symbols.length - result.observations.length;
    const status = result.observations.length > 0 && failed === 0 ? "ok" : "degraded";
    const boundedError = result.warnings.slice(0, 8).join("; ").slice(0, 480) || null;
    const lastSuccessAt = result.observations.length > 0 ? collectedAt : previous?.lastSuccessAt ?? null;
    await rememberQuotesHealth(env.DB, {
      provider: providerName,
      status,
      lastAttemptAt: collectedAt,
      lastSuccessAt,
      lastError: boundedError,
      rowsWritten,
      lastShard: shardIndex,
      rateLimited: result.rateLimited,
    });
    console.info(JSON.stringify({
      job: "quotes-shard",
      phase: "result",
      scheduledTime: scheduledTime.toISOString(),
      window,
      shard: shardIndex,
      provider: providerName,
      symbolsRequested: symbols.length,
      successful: result.observations.length,
      failed,
      warningsCount: result.warnings.length,
      rateLimited: result.rateLimited,
      externalSubrequestsBudget: QUOTES_SHARD_WORST_CASE_EXTERNAL_SUBREQUESTS,
      rowsWritten,
      durationMs: Date.now() - startedAt,
      status,
    }));
    return { status, detail: `shard ${shardIndex}: ${result.observations.length}/${symbols.length}` };
  } catch (error) {
    const detail = errorMessage(error).slice(0, 200);
    console.error(JSON.stringify({
      job: "quotes-shard",
      phase: "result",
      scheduledTime: scheduledTime.toISOString(),
      window,
      shard: shardIndex,
      status: "degraded",
      error: detail,
      durationMs: Date.now() - startedAt,
    }));
    await rememberQuotesHealth(env.DB, {
      provider: providerName,
      status: "degraded",
      lastAttemptAt: collectedAt,
      lastSuccessAt: previous?.lastSuccessAt ?? null,
      lastError: detail,
      rowsWritten: 0,
      lastShard: shardIndex,
      rateLimited: false,
    });
    return { status: "degraded", detail };
  }
}
