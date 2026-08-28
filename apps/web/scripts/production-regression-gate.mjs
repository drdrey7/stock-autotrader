import { execFile as execFileCallback } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const DEFAULT_WORKER_URL = "https://stock-autotrader-web.barroso-labs.workers.dev";
const STATE_SEVERITY = new Map([
  ["Live", 0],
  ["Cached", 1],
  ["Stale", 2],
  ["Unavailable", 3],
  ["Error", 4],
]);
const EARNINGS_ENGINE_SEVERITY = new Map([
  ["HEALTHY", 0],
  ["STALE", 1],
  ["DEGRADED", 2],
  ["UNINITIALIZED", 3],
]);

const ALL_CRITICAL_SOURCES = ["market", "earnings"];

const argValue = (name, args = process.argv.slice(2)) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? null : null;
};

const normalizePath = (value) => String(value).replaceAll("\\", "/").replace(/^\.\//, "");

const matchesPrefix = (path, prefix) => path === prefix || path.startsWith(`${prefix}/`);

export function classifyChangedPaths(inputPaths) {
  const paths = [...new Set(inputPaths.map(normalizePath).filter(Boolean))].sort();
  const criticalSources = new Set();
  let runtime = false;
  let core = false;

  for (const path of paths) {
    const workerPath = matchesPrefix(path, "apps/web/worker");
    const migrationPath = matchesPrefix(path, "apps/web/migrations");
    const contractsPath = matchesPrefix(path, "packages/contracts");
    const deployWorkflow = path === ".github/workflows/deploy.yml";
    const deploymentTooling = deployWorkflow || [
      "apps/web/scripts/bootstrap-production.mjs",
      "apps/web/scripts/production-regression-gate.mjs",
    ].includes(path);
    const webRuntimeConfig = [
      "apps/web/wrangler.jsonc",
      "apps/web/package.json",
      "package.json",
      "package-lock.json",
    ].includes(path);
    const sharedCriticalRuntime = [
      "apps/web/worker/index.ts",
      "apps/web/worker/dashboard.ts",
      "apps/web/worker/cron-dispatcher.ts",
    ].includes(path);

    if (workerPath || migrationPath || contractsPath || deploymentTooling || webRuntimeConfig) runtime = true;

    if (migrationPath || contractsPath || sharedCriticalRuntime || deploymentTooling || webRuntimeConfig) {
      ALL_CRITICAL_SOURCES.forEach((source) => criticalSources.add(source));
    }

    if (
      migrationPath
      || contractsPath
      || path === "apps/web/worker/bootstrap.ts"
      || path === "apps/web/worker/stock-universe.ts"
      || path === "apps/web/worker/earnings/storage.ts"
      || matchesPrefix(path, "apps/web/worker/earnings/storage")
      || path === "apps/web/scripts/bootstrap-production.mjs"
    ) {
      core = true;
    }

    if (
      path === "apps/web/worker/bootstrap.ts"
      || matchesPrefix(path, "apps/web/worker/earnings")
      || path.startsWith("apps/web/worker/earnings.")
      || path === "apps/web/worker/stock-universe.ts"
      || path === "apps/web/scripts/bootstrap-production.mjs"
    ) {
      criticalSources.add("earnings");
    }

    if (matchesPrefix(path, "apps/web/worker/market-context") || path.startsWith("apps/web/worker/market-context.")) {
      criticalSources.add("market");
    }
  }

  return {
    changedFiles: paths.length,
    runtime,
    core,
    criticalSources: [...criticalSources].sort(),
    paths,
  };
}

async function changedPaths(base, head) {
  const zeroSha = /^0+$/.test(base ?? "");
  const range = !base || zeroSha ? `${head}^..${head}` : `${base}..${head}`;
  const { stdout: repoRootOutput } = await execFile("git", ["rev-parse", "--show-toplevel"], {
    cwd: process.cwd(),
    maxBuffer: 64 * 1024,
  });
  const repoRoot = repoRootOutput.trim();
  const { stdout } = await execFile("git", ["diff", "--name-only", "--diff-filter=ACMRD", range], {
    cwd: repoRoot,
    maxBuffer: 2 * 1024 * 1024,
  });
  return stdout.split("\n").map((line) => line.trim()).filter(Boolean);
}

async function fetchJson(url) {
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json", "cache-control": "no-cache" },
      cache: "no-store",
    });
    let body = null;
    try {
      body = await response.json();
    } catch {
      // HTTP status remains useful even when a broken deployment returns HTML.
    }
    return { httpStatus: response.status, body };
  } catch (error) {
    return {
      httpStatus: 0,
      body: null,
      networkError: error instanceof Error ? error.name : "NetworkError",
    };
  }
}

export async function captureProductionSnapshot(workerUrl = process.env.PRODUCTION_WORKER_URL ?? DEFAULT_WORKER_URL) {
  const baseUrl = workerUrl.replace(/\/$/, "");
  const cacheBust = `gate=${Date.now()}`;
  const [livenessResponse, sourcesResponse] = await Promise.all([
    fetchJson(`${baseUrl}/healthz?${cacheBust}`),
    fetchJson(`${baseUrl}/healthz/sources?${cacheBust}`),
  ]);

  const livenessBody = livenessResponse.body;
  const sourcesBody = sourcesResponse.body;
  const critical = Array.isArray(sourcesBody?.critical)
    ? sourcesBody.critical.filter((value) => typeof value === "string")
    : [];
  const down = Array.isArray(sourcesBody?.down)
    ? sourcesBody.down.filter((value) => typeof value === "string")
    : [];
  const states = {};
  const engineStates = {};
  for (const source of critical) {
    const state = sourcesBody?.sources?.[source]?.state;
    const engineState = sourcesBody?.sources?.[source]?.engineState;
    states[source] = typeof state === "string" ? state : null;
    engineStates[source] = typeof engineState === "string" ? engineState : null;
  }

  return {
    capturedAt: new Date().toISOString(),
    liveness: {
      httpStatus: livenessResponse.httpStatus,
      ok: livenessResponse.httpStatus >= 200 && livenessResponse.httpStatus < 300 && livenessBody?.ok === true,
      networkError: livenessResponse.networkError ?? null,
    },
    sources: {
      httpStatus: sourcesResponse.httpStatus,
      readable: sourcesBody !== null && Array.isArray(sourcesBody?.critical) && Array.isArray(sourcesBody?.down),
      ok: sourcesBody?.ok === true,
      critical,
      down,
      states,
      engineStates,
      error: typeof sourcesBody?.error === "string" ? sourcesBody.error : null,
      networkError: sourcesResponse.networkError ?? null,
    },
  };
}

const sourceStateSeverity = (snapshot, source) => {
  if (source === "earnings") {
    const engineState = snapshot?.sources?.engineStates?.[source];
    const engineSeverity = EARNINGS_ENGINE_SEVERITY.get(engineState);
    if (engineSeverity !== undefined) return engineSeverity;
  }
  const state = snapshot?.sources?.states?.[source];
  return STATE_SEVERITY.get(state) ?? null;
};

const sourceStateLabel = (snapshot, source) => {
  if (source === "earnings") {
    const engineState = snapshot?.sources?.engineStates?.[source];
    if (EARNINGS_ENGINE_SEVERITY.has(engineState)) return engineState;
  }
  return snapshot?.sources?.states?.[source] ?? "unknown";
};

const sourceIsDown = (snapshot, source) => snapshot?.sources?.down?.includes(source) === true;

export function evaluateRegression({ before, after, scope, bootstrap = null }) {
  const reasons = [];
  const beforeLive = before?.liveness?.ok === true;
  const afterLive = after?.liveness?.ok === true;

  if (beforeLive && !afterLive) {
    reasons.push(`Worker liveness regressed after deploy (HTTP ${after?.liveness?.httpStatus ?? "unknown"})`);
  } else if (!beforeLive && !afterLive && scope?.runtime) {
    reasons.push("Worker liveness is unavailable, so runtime changes cannot be regression-verified");
  }

  const beforeReadable = before?.sources?.readable === true;
  const afterReadable = after?.sources?.readable === true;

  if (beforeReadable && !afterReadable) {
    reasons.push("canonical /healthz/sources became unreadable after deploy");
  } else if (!beforeReadable && !afterReadable && scope?.runtime) {
    reasons.push("canonical /healthz/sources is unreadable, so runtime changes cannot be regression-verified");
  }

  if (beforeReadable && afterReadable) {
    const beforeDown = new Set(before.sources.down);
    for (const source of after.sources.down) {
      if (!beforeDown.has(source)) reasons.push(`critical source newly down: ${source}`);
    }

    for (const source of scope?.criticalSources ?? []) {
      if (!sourceIsDown(before, source) || !sourceIsDown(after, source)) continue;
      const beforeSeverity = sourceStateSeverity(before, source);
      const afterSeverity = sourceStateSeverity(after, source);
      if (beforeSeverity !== null && afterSeverity !== null && afterSeverity > beforeSeverity) {
        reasons.push(`touched critical source worsened: ${source} (${sourceStateLabel(before, source)} -> ${sourceStateLabel(after, source)})`);
      }
    }
  } else if (!beforeReadable && afterReadable) {
    for (const source of scope?.criticalSources ?? []) {
      if (sourceIsDown(after, source)) {
        reasons.push(`touched critical source is down and no readable baseline exists: ${source}`);
      }
    }
  }

  if (scope?.core && bootstrap) {
    const core = bootstrap.core;
    if (!core?.initialized || core.activeCount !== core.expectedCount) {
      reasons.push(`Core Universe invariant failed (${core?.activeCount ?? "unknown"}/${core?.expectedCount ?? "unknown"})`);
    }
  }

  if (
    scope?.criticalSources?.includes("earnings")
    && bootstrap?.calendar?.status === "degraded"
    && beforeReadable
    && !sourceIsDown(before, "earnings")
  ) {
    reasons.push("earnings bootstrap degraded after a change that touches earnings");
  }

  return { ok: reasons.length === 0, reasons };
}

function formatSources(snapshot) {
  if (!snapshot?.sources?.readable) return `unreadable(http=${snapshot?.sources?.httpStatus ?? "unknown"})`;
  const down = snapshot.sources.down.length > 0 ? snapshot.sources.down.join(",") : "none";
  const states = snapshot.sources.critical
    .map((source) => `${source}=${sourceStateLabel(snapshot, source)}`)
    .join(",");
  return `down=[${down}] states=[${states}]`;
}

async function readJsonFile(path) {
  const { readFile } = await import("node:fs/promises");
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJsonFile(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

async function runCli() {
  const args = process.argv.slice(2);
  const command = args[0];
  const output = argValue("--output", args);

  if (command === "classify") {
    const base = argValue("--base", args);
    const head = argValue("--head", args);
    if (!head || !output) throw new Error("classify requires --head and --output");
    const scope = classifyChangedPaths(await changedPaths(base, head));
    await writeJsonFile(output, scope);
    console.log(`Production change scope: files=${scope.changedFiles}; runtime=${scope.runtime}; core=${scope.core}; critical=[${scope.criticalSources.join(",") || "none"}]`);
    return;
  }

  if (command === "snapshot") {
    if (!output) throw new Error("snapshot requires --output");
    const snapshot = await captureProductionSnapshot();
    await writeJsonFile(output, snapshot);
    console.log(`Production snapshot: liveness=${snapshot.liveness.ok ? "ok" : `failed(http=${snapshot.liveness.httpStatus})`}; ${formatSources(snapshot)}`);
    return;
  }

  if (command === "compare") {
    const beforePath = argValue("--before", args);
    const afterPath = argValue("--after", args);
    const scopePath = argValue("--scope", args);
    const bootstrapPath = argValue("--bootstrap", args);
    if (!beforePath || !afterPath || !scopePath) throw new Error("compare requires --before, --after and --scope");
    const [before, after, scope, bootstrap] = await Promise.all([
      readJsonFile(beforePath),
      readJsonFile(afterPath),
      readJsonFile(scopePath),
      bootstrapPath ? readJsonFile(bootstrapPath) : Promise.resolve(null),
    ]);
    console.log(`Production baseline: liveness=${before.liveness?.ok ? "ok" : "failed"}; ${formatSources(before)}`);
    console.log(`Production post-deploy: liveness=${after.liveness?.ok ? "ok" : "failed"}; ${formatSources(after)}`);
    console.log(`Changed scope: runtime=${scope.runtime}; core=${scope.core}; critical=[${scope.criticalSources?.join(",") || "none"}]`);
    const result = evaluateRegression({ before, after, scope, bootstrap });
    if (!result.ok) {
      for (const reason of result.reasons) console.error(`::error::Production regression gate: ${reason}`);
      process.exitCode = 1;
      return;
    }
    console.log("Production regression gate: PASS — no new or scope-related critical regression detected.");
    return;
  }

  throw new Error("Expected one of: classify, snapshot, compare");
}

const isDirectRun = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isDirectRun) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.message : "Production regression gate failed");
    process.exitCode = 1;
  });
}
