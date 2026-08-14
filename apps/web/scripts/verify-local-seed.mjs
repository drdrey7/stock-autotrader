#!/usr/bin/env node
/**
 * Regression check for the documented local migration + seed workflow.
 *
 * This intentionally runs against local D1 only. It seeds once from the
 * clean migrated database, verifies the public stock data prerequisites, then
 * adds a legacy non-Core row and repeats the seed to verify reconciliation and
 * idempotency.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(__dirname, "..");
const repoDir = path.resolve(webDir, "../..");
const local = process.argv.includes("--local");
const expectClean = process.argv.includes("--expect-clean");

if (!local) throw new Error("Local seed verification requires the --local flag");

const coreConfig = JSON.parse(readFileSync(path.join(repoDir, "packages/contracts/src/core-universe.v1.json"), "utf8"));
const expectedSymbols = [...coreConfig.symbols].sort();
const expectedSet = new Set(expectedSymbols);

function d1Json(sql) {
  const output = execFileSync("npx", [
    "--yes",
    "wrangler@4.122.0",
    "d1",
    "execute",
    "stock-autotrader-db",
    "--command",
    sql,
    "--local",
    "--json",
  ], { cwd: webDir, encoding: "utf8" });
  try {
    return JSON.parse(output);
  } catch (error) {
    throw new Error(`Unable to parse Wrangler D1 JSON output: ${error instanceof Error ? error.message : String(error)}\n${output}`);
  }
}

function queryRows(sql) {
  const payload = d1Json(sql);
  const result = Array.isArray(payload) ? payload.find((item) => Array.isArray(item?.results)) : payload;
  if (!result || !Array.isArray(result.results)) throw new Error(`D1 query returned no results: ${sql}`);
  return result.results;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function readUniverseRows() {
  return queryRows(
    "SELECT symbol, active, source, universe_version, added_at, removed_at, updated_at FROM earnings_universe ORDER BY symbol",
  );
}

function assertExactActiveCore(rows, label) {
  const activeCore = rows
    .filter((row) => Number(row.active) === 1 && row.source === "core")
    .map((row) => String(row.symbol))
    .sort();
  assert(JSON.stringify(activeCore) === JSON.stringify(expectedSymbols), `${label}: active Core membership is not exactly the checked-in configuration`);
  assert(
    rows.every((row) => Number(row.active) !== 1 || row.source !== "core" || expectedSet.has(String(row.symbol))),
    `${label}: a non-Core symbol became active`,
  );
  for (const row of rows.filter((candidate) => Number(candidate.active) === 1 && candidate.source === "core")) {
    assert(Number(row.universe_version) === Number(coreConfig.version), `${label}: ${row.symbol} has the wrong Core version`);
  }
}

function assertSeededStockData(label) {
  const rows = queryRows(`
    SELECT
      (SELECT COUNT(*) FROM stocks WHERE symbol = 'NVDA') AS stocks,
      (SELECT COUNT(*) FROM scan_candidates WHERE symbol = 'NVDA') AS candidates,
      (SELECT COUNT(*) FROM earnings WHERE symbol = 'NVDA') AS earnings,
      (SELECT COUNT(*) FROM shadow_positions WHERE symbol = 'NVDA') AS positions,
      (SELECT COUNT(*) FROM bot_events WHERE symbol = 'NVDA') AS events
  `);
  const counts = rows[0] ?? {};
  for (const [name, value] of Object.entries(counts)) {
    assert(Number(value) > 0, `${label}: seeded Core NVDA ${name} data is not visible`);
  }
}

function runSeed() {
  execFileSync(process.execPath, [path.join(webDir, "scripts/seed.mjs"), "--local"], {
    cwd: webDir,
    stdio: "inherit",
  });
}

const initialRows = readUniverseRows();
if (expectClean) assert(initialRows.length === 0, `Expected a clean migrated earnings_universe, found ${initialRows.length} rows`);

runSeed();
const firstRows = readUniverseRows();
assertExactActiveCore(firstRows, "first seed");
assertSeededStockData("first seed");

// Simulate a previously tracked index-only member. Reconciliation must retain
// the row for audit/history but remove it from the active Core universe.
d1Json(`
  INSERT INTO earnings_universe
    (symbol, company, cik, exchange, investor_relations_url, index_memberships, metadata_provider, active, source, universe_version, added_at, removed_at, updated_at)
  VALUES ('ABNB', 'Airbnb', NULL, NULL, NULL, '[]', 'legacy-index', 1, 'core', 0, '2026-08-01T00:00:00.000Z', NULL, '2026-08-01T00:00:00.000Z')
  ON CONFLICT(symbol) DO UPDATE SET active = 1, source = 'core', universe_version = 0, removed_at = NULL
`);
runSeed();
const reconciledRows = readUniverseRows();
assertExactActiveCore(reconciledRows, "reconciled seed");
assertSeededStockData("reconciled seed");
const abnb = reconciledRows.find((row) => row.symbol === "ABNB");
assert(abnb && Number(abnb.active) === 0 && abnb.source === "core", "reconciled seed: legacy ABNB was not retained as inactive");

const beforeRepeat = JSON.stringify(reconciledRows);
runSeed();
const repeatedRows = readUniverseRows();
assert(JSON.stringify(repeatedRows) === beforeRepeat, "repeated seed changed Core lifecycle rows");
assertSeededStockData("repeated seed");

console.log(`Local seed verification passed: ${expectedSymbols.length} exact active Core symbols, seeded NVDA data visible, ABNB inactive, repeat idempotent.`);
