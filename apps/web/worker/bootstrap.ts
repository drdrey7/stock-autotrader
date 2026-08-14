import { CORE_UNIVERSE, CORE_UNIVERSE_VERSION } from "@stock-autotrader/contracts";
import type { Env } from "./index";
import { runEarningsJob } from "./earnings";
import {
  readTrackedUniverse,
  reconcileCoreUniverse,
  type TrackedUniverseRow,
} from "./earnings/storage";

export interface CoreUniverseHealth {
  activeCount: number;
  expectedCount: number;
  universeVersion: number | null;
  initialized: boolean;
}

export interface ProductionBootstrapResult {
  core: CoreUniverseHealth;
  calendar: {
    status: "ok" | "degraded" | "skipped";
    detail: string;
  };
}

function activeCoreRows(rows: TrackedUniverseRow[]): TrackedUniverseRow[] {
  return rows.filter((row) => row.active && row.source === "core");
}

export async function readCoreUniverseHealth(env: Env): Promise<CoreUniverseHealth> {
  const rows = await readTrackedUniverse(env.DB);
  const active = activeCoreRows(rows);
  const activeSymbols = new Set(active.map((row) => row.symbol));
  const versions = new Set(active.map((row) => row.universeVersion));
  const initialized = active.length === CORE_UNIVERSE.length
    && active.every((row) => row.universeVersion === CORE_UNIVERSE_VERSION)
    && CORE_UNIVERSE.every((symbol) => activeSymbols.has(symbol));

  return {
    activeCount: active.length,
    expectedCount: CORE_UNIVERSE.length,
    universeVersion: versions.size === 1 ? [...versions][0] ?? null : null,
    initialized,
  };
}

/**
 * Reconcile and verify Core membership without invoking any external provider.
 * This is deliberately separate from the calendar run so deployment can
 * prove the membership invariant before Finnhub or SEC is contacted.
 */
export async function reconcileAndVerifyCoreUniverse(
  env: Env,
  updatedAt = new Date().toISOString(),
): Promise<CoreUniverseHealth> {
  await reconcileCoreUniverse(env.DB, CORE_UNIVERSE, CORE_UNIVERSE_VERSION, updatedAt);
  const health = await readCoreUniverseHealth(env);
  if (!health.initialized) {
    throw new Error(`Core Universe invariant failed: ${health.activeCount}/${health.expectedCount} active at version ${health.universeVersion ?? "unknown"}`);
  }
  return health;
}

/**
 * Deployment/manual production bootstrap. Core is reconciled and verified
 * first; the existing calendar job then refreshes the earnings read model.
 * A provider degradation is returned as a job result, while a Core invariant
 * or D1 failure throws and must fail deployment.
 */
export async function runProductionBootstrap(
  env: Env,
  scheduledTime = new Date(),
): Promise<ProductionBootstrapResult> {
  const startedAt = Date.now();
  const core = await reconcileAndVerifyCoreUniverse(env, scheduledTime.toISOString());
  const calendar = await runEarningsJob(env, scheduledTime, "calendar");
  const verifiedCore = await readCoreUniverseHealth(env);
  if (!verifiedCore.initialized) {
    throw new Error(`Core Universe invariant failed after calendar run: ${verifiedCore.activeCount}/${verifiedCore.expectedCount} active`);
  }
  console.info(JSON.stringify({
    job: "production-bootstrap",
    status: "ok",
    activeCoreCount: verifiedCore.activeCount,
    expectedCoreCount: verifiedCore.expectedCount,
    universeVersion: verifiedCore.universeVersion,
    calendarStatus: calendar.status,
    durationMs: Date.now() - startedAt,
  }));
  return { core: { ...core, ...verifiedCore }, calendar };
}
