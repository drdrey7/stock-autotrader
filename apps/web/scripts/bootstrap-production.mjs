import { randomBytes } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { chmod, readFile, rm, writeFile } from "node:fs/promises";

const execFile = promisify(execFileCallback);
const DATABASE_NAME = "stock-autotrader-db";
const NONCE_KEY = "deploymentBootstrapNonce";
const NONCE_FILE = process.env.STOCK_AUTOTRADER_BOOTSTRAP_NONCE_FILE
  ?? "/tmp/stock-autotrader-deployment-bootstrap.json";
const WORKER_URL = (process.env.PRODUCTION_WORKER_URL
  ?? "https://stock-autotrader-web.barroso-labs.workers.dev").replace(/\/$/, "");
const NONCE_TTL_MS = 10 * 60 * 1000;

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function wrangler(args) {
  try {
    return await execFile("npx", ["--yes", "wrangler@4.122.0", ...args], {
      cwd: process.cwd(),
      env: process.env,
      maxBuffer: 2 * 1024 * 1024,
    });
  } catch (error) {
    // Do not echo Wrangler output: the command includes the one-time nonce.
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "unknown";
    throw new Error(`Wrangler operation failed (${code})`);
  }
}

async function prepareNonce() {
  const nonce = randomBytes(32).toString("hex");
  const record = { nonce, expiresAt: Date.now() + NONCE_TTL_MS };
  const value = JSON.stringify(record);
  const command = `INSERT INTO app_meta (key, value) VALUES (${sqlString(NONCE_KEY)}, ${sqlString(value)}) ON CONFLICT(key) DO UPDATE SET value = excluded.value`;
  await wrangler([
    "d1", "execute", DATABASE_NAME, "--remote", "--config", "wrangler.jsonc", "--command", command,
  ]);
  await writeFile(NONCE_FILE, `${value}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(NONCE_FILE, 0o600);
  return record;
}

async function invoke(operation, scheduledTime) {
  const record = JSON.parse(await readFile(NONCE_FILE, "utf8"));
  const response = await fetch(`${WORKER_URL}/__internal/deployment/bootstrap`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${record.nonce}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ operation, ...(scheduledTime ? { scheduledTime } : {}) }),
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    // The status below remains the authoritative result.
  }
  if (!response.ok) throw new Error(`Production bootstrap endpoint returned HTTP ${response.status}`);
  return body;
}

const argValue = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
};

async function main() {
  const marketContextOnly = process.argv.includes("--market-context");
  const scheduledTime = argValue("--scheduled-time") ?? process.env.MARKET_CONTEXT_SCHEDULED_TIME ?? null;
  await prepareNonce();
  try {
    const body = await invoke(marketContextOnly ? "market-context" : "bootstrap", scheduledTime);
    if (marketContextOnly) {
      const result = body?.result ?? {};
      const health = body?.health ?? {};
      console.log(`Production Market Context run: ${result.status ?? "unknown"}; rows=${health.rowsWritten ?? 0}; provider=${health.provider ?? "unknown"}`);
      return;
    }
    const core = body?.core;
    const calendar = body?.calendar;
    if (!core?.initialized || core.activeCount !== core.expectedCount) {
      throw new Error(`Core bootstrap invariant failed (${core?.activeCount ?? "unknown"}/${core?.expectedCount ?? "unknown"})`);
    }
    console.log(`Production bootstrap: Core ${core.activeCount}/${core.expectedCount} active, version=${core.universeVersion ?? "unknown"}; calendar=${calendar?.status ?? "unknown"}`);
  } finally {
    await rm(NONCE_FILE, { force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Production bootstrap failed");
  process.exitCode = 1;
});
