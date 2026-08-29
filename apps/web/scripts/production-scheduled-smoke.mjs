import { execFile as execFileCallback } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const DEFAULT_WORKER_URL = "https://stock-autotrader-web.barroso-labs.workers.dev";
const FETCH_TIMEOUT_MS = 10_000;

const argValue = (name, args = process.argv.slice(2)) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? null : null;
};

const normalizePath = (value) => String(value).replaceAll("\\", "/").replace(/^\.\//, "");

export function scheduledSmokePlan(scope) {
  const paths = Array.isArray(scope?.paths)
    ? scope.paths.map(normalizePath).filter(Boolean)
    : [];
  const dispatcherChanged = paths.includes("apps/web/worker/cron-dispatcher.ts");
  const marketContextChanged = paths.some((path) =>
    path === "apps/web/worker/market-context.ts"
    || path.startsWith("apps/web/worker/market-context/"));

  return {
    validateDispatcher: dispatcherChanged,
    runMarketContext: dispatcherChanged || marketContextChanged,
  };
}

export function marketSmokeScheduledTime(statusBody) {
  const candidate = statusBody?.market?.latestSourceTimestamp;
  if (typeof candidate !== "string") return null;
  const parsed = new Date(candidate);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

async function fetchProductionStatus(workerUrl) {
  const url = `${workerUrl.replace(/\/$/, "")}/api/status?scheduled-smoke=${Date.now()}`;
  const response = await fetch(url, {
    headers: { accept: "application/json", "cache-control": "no-cache" },
    cache: "no-store",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Production status returned HTTP ${response.status}`);
  return response.json();
}

async function runDispatcherContract() {
  await execFile("npx", ["--no-install", "vitest", "run", "worker/cron-dispatcher.test.ts"], {
    cwd: process.cwd(),
    env: process.env,
    maxBuffer: 2 * 1024 * 1024,
  });
}

async function runMarketContextSmoke({ workerUrl, outputPath }) {
  const statusBody = await fetchProductionStatus(workerUrl);
  const scheduledTime = marketSmokeScheduledTime(statusBody);
  if (!scheduledTime) {
    throw new Error("Production Market Context smoke cannot resolve the latest canonical source timestamp");
  }

  const args = [
    "scripts/bootstrap-production.mjs",
    "--market-context",
    "--scheduled-time", scheduledTime,
    "--output", outputPath,
  ];
  await execFile(process.execPath, args, {
    cwd: process.cwd(),
    env: process.env,
    maxBuffer: 2 * 1024 * 1024,
  });

  const report = JSON.parse(await readFile(outputPath, "utf8"));
  const resultStatus = report?.result?.status;
  const healthStatus = report?.health?.status;
  if (resultStatus !== "ok" || healthStatus !== "ok") {
    throw new Error(`Production Market Context smoke failed (result=${resultStatus ?? "unknown"}, health=${healthStatus ?? "unknown"})`);
  }
  console.log(`Production Market Context smoke: PASS — scheduledTime=${scheduledTime}; provider=${report?.health?.provider ?? "unknown"}; rows=${report?.health?.rowsWritten ?? 0}`);
}

async function main() {
  const scopePath = argValue("--scope");
  const outputPath = argValue("--output");
  if (!scopePath || !outputPath) throw new Error("scheduled smoke requires --scope and --output");

  const scope = JSON.parse(await readFile(scopePath, "utf8"));
  const plan = scheduledSmokePlan(scope);
  if (!plan.validateDispatcher && !plan.runMarketContext) {
    console.log("Production scheduled smoke: SKIP — changed scope does not touch scheduled Market Context/dispatcher paths.");
    return;
  }

  if (plan.validateDispatcher) {
    await runDispatcherContract();
    console.log("Production scheduled dispatcher contract: PASS");
  }

  if (plan.runMarketContext) {
    await runMarketContextSmoke({
      workerUrl: process.env.PRODUCTION_WORKER_URL ?? DEFAULT_WORKER_URL,
      outputPath,
    });
  }
}

const isDirectRun = process.argv[1]
  ? import.meta.url === new URL(`file://${process.argv[1]}`).href
  : false;

if (isDirectRun) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Production scheduled smoke failed");
    process.exitCode = 1;
  });
}
