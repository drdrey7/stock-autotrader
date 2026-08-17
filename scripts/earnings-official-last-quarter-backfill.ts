#!/usr/bin/env node
/**
 * One-shot official-metric backfill — LATEST reported quarter, every active
 * Core Universe company.
 *
 * Runs on VPS/Hermes (never in the Cloudflare Worker — the cron budget and the
 * subrequest budget stay untouched). It reads D1 (the canonical store), fetches
 * SEC XBRL companyfacts for each symbol, resolves official GAAP diluted EPS and
 * quarterly revenue (validated: unit, fiscal identity, quarter-only duration,
 * form, single context), builds an audit row per symbol and — only with
 * --apply — writes the official/provenance columns back to production D1.
 *
 * Usage (from repo root):
 *   npx --yes tsx scripts/earnings-official-last-quarter-backfill.ts           # dry-run, all Core
 *   npx --yes tsx scripts/earnings-official-last-quarter-backfill.ts --symbol AAPL
 *   npx --yes tsx scripts/earnings-official-last-quarter-backfill.ts --apply --symbol COIN
 *   npx --yes tsx scripts/earnings-official-last-quarter-backfill.ts --apply --all-core
 *
 * Flags:
 *   --dry-run              audit + report only, write nothing (default)
 *   --apply                write resolved metrics to production D1 (idempotent)
 *   --symbol SYM           restrict to one symbol (repeatable)
 *   --all-core             every active Core symbol (default when no --symbol)
 *   --limit N              cap audited symbols this run (A-Z order)
 *   --out PATH             audit JSON report path (default ./earnings-official-audit.json)
 *   --pace-ms N            SEC pacing between companyfacts fetches (default 1000)
 *   --db NAME              D1 database name (default stock-autotrader-db)
 *   --wrangler VERSION     wrangler version pin (default 4.122.0)
 *
 * Idempotent + restartable: re-running --apply emits UPDATEs only for rows
 * whose official values actually changed; --symbol resumes partial runs.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { EarningsStatus } from "@stock-autotrader/contracts";
import {
  buildAuditRow,
  type AuditRow,
} from "../apps/web/worker/earnings/official-metrics";
import {
  fetchCompanyFacts,
  fetchTickerCikMap,
  resolveOfficialMetrics,
} from "../apps/web/worker/earnings/sec-xbrl";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB = "stock-autotrader-db";
const DEFAULT_WRANGLER = "4.122.0";
const DEFAULT_PACE_MS = 1000;
// SEC EDGAR requires a contact-email User-Agent; the github-only format is
// rejected with 403 (verified 2026-08-17). Must match the Worker default.
const SEC_USER_AGENT = "StockAutotrader research contact@barroso-labs.com";

interface CliOptions {
  dryRun: boolean;
  apply: boolean;
  symbols: string[];
  allCore: boolean;
  limit: number | null;
  outPath: string;
  paceMs: number;
  db: string;
  wrangler: string;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    dryRun: true,
    apply: false,
    symbols: [],
    allCore: true,
    limit: null,
    outPath: path.join(process.cwd(), "earnings-official-audit.json"),
    paceMs: DEFAULT_PACE_MS,
    db: DEFAULT_DB,
    wrangler: DEFAULT_WRANGLER,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    switch (argument) {
      case "--apply": options.apply = true; options.dryRun = false; break;
      case "--dry-run": options.dryRun = true; options.apply = false; break;
      case "--all-core": options.allCore = true; break;
      case "--symbol":
        {
          const value = argv[index + 1];
          if (!value) throw new Error("--symbol requires a ticker argument");
          options.symbols.push(value.toUpperCase());
          options.allCore = false;
          index += 1;
        }
        break;
      case "--limit":
        options.limit = Number(argv[index + 1]);
        index += 1;
        break;
      case "--out":
        options.outPath = argv[index + 1]!;
        index += 1;
        break;
      case "--pace-ms":
        options.paceMs = Number(argv[index + 1]) || DEFAULT_PACE_MS;
        index += 1;
        break;
      case "--db":
        options.db = argv[index + 1]!;
        index += 1;
        break;
      case "--wrangler":
        options.wrangler = argv[index + 1]!;
        index += 1;
        break;
      default:
        console.error(`Unknown flag: ${argument}`);
        process.exit(2);
    }
  }
  if (options.symbols.length > 0) options.allCore = false;
  return options;
}

function runWrangler(command: string, options: CliOptions, preferJson = false): string {
  const args = ["d1", "execute", options.db, "--remote"];
  if (preferJson) args.push("--json");
  args.push("--command", command);
  const result = spawnSync("npx", ["--yes", `wrangler@${options.wrangler}`, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`wrangler d1 execute failed (${result.status}):\n${result.stderr?.slice(0, 2000) || result.stdout?.slice(0, 2000)}`);
  }
  return result.stdout ?? "";
}

interface D1RowsResult {
  results: Record<string, unknown>[];
  success: boolean;
}

function parseD1Json(output: string): Record<string, unknown>[] {
  const parsed: unknown = JSON.parse(output);
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  const rows = first && typeof first === "object" && Array.isArray((first as D1RowsResult).results)
    ? (first as D1RowsResult).results
    : [];
  return rows;
}

interface D1EventRow {
  id: string;
  symbol: string;
  company: string | null;
  cik: string | null;
  fiscal_year: number | null;
  fiscal_quarter: number | null;
  fiscal_period: string | null;
  fiscal_period_end: string | null;
  scheduled_date: string | null;
  status: EarningsStatus | null;
  eps_estimate: number | null;
  eps_actual: number | null;
  revenue_estimate: number | null;
  revenue_actual: number | null;
  reported_at: string | null;
  sec_filing_url: string | null;
  sec_accession: string | null;
  sec_form: string | null;
  sec_filed_at: string | null;
}

interface UniverseRow {
  symbol: string;
  company: string | null;
  cik: string | null;
  active: number;
}

type EventKey = string;

function numberValue(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function textValue(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function loadActiveCore(options: CliOptions): { events: D1EventRow[]; universe: UniverseRow[] } {
  const eventOutput = runWrangler(
    `SELECT e.id, e.symbol, e.company, e.cik, e.fiscal_year, e.fiscal_quarter, e.fiscal_period, e.fiscal_period_end, e.scheduled_date, e.status, e.eps_estimate, e.eps_actual, e.revenue_estimate, e.revenue_actual, e.reported_at, e.sec_filing_url, e.sec_accession, e.sec_form, e.sec_filed_at FROM earnings_events e JOIN earnings_universe u ON u.symbol = e.symbol WHERE u.active = 1 AND u.source = 'core' ORDER BY e.symbol, e.scheduled_date DESC`,
    options,
    true,
  );
  const eventRows = parseD1Json(eventOutput);
  const events: D1EventRow[] = eventRows.map((row) => ({
    id: String(row.id ?? ""),
    symbol: String(row.symbol ?? ""),
    company: textValue(row.company),
    cik: textValue(row.cik),
    fiscal_year: numberValue(row.fiscal_year),
    fiscal_quarter: numberValue(row.fiscal_quarter),
    fiscal_period: textValue(row.fiscal_period),
    fiscal_period_end: textValue(row.fiscal_period_end),
    scheduled_date: textValue(row.scheduled_date),
    status: (textValue(row.status) ?? null) as EarningsStatus | null,
    eps_estimate: numberValue(row.eps_estimate),
    eps_actual: numberValue(row.eps_actual),
    revenue_estimate: numberValue(row.revenue_estimate),
    revenue_actual: numberValue(row.revenue_actual),
    reported_at: textValue(row.reported_at),
    sec_filing_url: textValue(row.sec_filing_url),
    sec_accession: textValue(row.sec_accession),
    sec_form: textValue(row.sec_form),
    sec_filed_at: textValue(row.sec_filed_at),
  }));
  const universeOutput = runWrangler(
    "SELECT symbol, company, cik, active FROM earnings_universe WHERE active = 1 AND source = 'core'",
    options,
    true,
  );
  const universe: UniverseRow[] = parseD1Json(universeOutput).map((row) => ({
    symbol: String(row.symbol ?? ""),
    company: textValue(row.company),
    cik: textValue(row.cik),
    active: Number(row.active ?? 1),
  }));
  return { events, universe };
}

/** Latest reported event per symbol (+ the newest event when nothing is reported). */
function selectLatestEventPerSymbol(events: D1EventRow[]): Map<string, D1EventRow> {
  const latest = new Map<string, D1EventRow>();
  for (const event of events) {
    const current = latest.get(event.symbol);
    const rank = (value: D1EventRow): EventKey => {
      const reportedRank = value.status === "reported" ? 1 : 0;
      const year = numberValue(value.fiscal_year) ?? 0;
      const quarter = numberValue(value.fiscal_quarter) ?? 0;
      return `${reportedRank}|${year}|${quarter}|${value.scheduled_date ?? ""}`;
    };
    if (!current || rank(event) > rank(current)) latest.set(event.symbol, event);
  }
  return latest;
}

function auditTargets(options: CliOptions): { symbol: string; event: D1EventRow | null }[] {
  const { events, universe } = loadActiveCore(options);
  const latest = selectLatestEventPerSymbol(events);
  const universeBySymbol = new Map(universe.map((row) => [row.symbol, row]));
  const symbols = options.allCore
    ? [...universeBySymbol.keys()].sort()
    : options.symbols.map((symbol) => symbol.toUpperCase());
  const targets = symbols.map((symbol) => ({ symbol, event: latest.get(symbol) ?? null }));
  if (options.limit !== null && options.limit > 0) return targets.slice(0, options.limit);
  return targets;
}

const sleep = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function run(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const startedAt = new Date().toISOString();
  console.error(`[backfill] ${options.apply ? "APPLY" : "DRY-RUN"} — latest reported quarter, core universe`);
  console.error(`[backfill] db=${options.db} wrangler=@${options.wrangler} pace=${options.paceMs}ms`);

  const targets = auditTargets(options);
  console.error(`[backfill] ${targets.length} symbol(s) to audit`);
  if (targets.length === 0) {
    console.error("[backfill] nothing to audit; exiting");
    return;
  }

  const cikMap = await fetchTickerCikMap({ userAgent: SEC_USER_AGENT });
  const rows: AuditRow[] = [];
  const fetchFailures: string[] = [];
  for (const [index, target] of targets.entries()) {
    const event = target.event;
    const cik = event?.cik ?? cikMap.get(target.symbol) ?? null;
    const identity = {
      fiscalYear: event ? numberValue(event.fiscal_year) : null,
      fiscalQuarter: event ? numberValue(event.fiscal_quarter) : null,
      scheduledDate: event?.scheduled_date ?? null,
      fiscalPeriodEnd: event?.fiscal_period_end ?? null,
    };
    let official = null;
    let fetchError: string | null = null;
    // Only reported events are audited against SEC XBRL. Upcoming/scheduled
    // events (e.g. NVDA) never receive actuals and need no companyfacts fetch.
    if (event && cik && event.status === "reported") {
      try {
        const facts = await fetchCompanyFacts(cik, { userAgent: SEC_USER_AGENT });
        official = resolveOfficialMetrics(facts, identity);
      } catch (error) {
        fetchError = error instanceof Error ? error.message : String(error);
        fetchFailures.push(`${target.symbol}: ${fetchError.slice(0, 160)}`);
      }
    }
    const audit = buildAuditRow({
      symbol: target.symbol,
      company: event?.company ?? null,
      cik,
      eventId: event?.id ?? `${target.symbol}-no-event`,
      scheduledDate: event?.scheduled_date ?? null,
      fiscalYear: identity.fiscalYear,
      fiscalQuarter: identity.fiscalQuarter,
      fiscalPeriodEnd: event?.fiscal_period_end ?? null,
      status: (event?.status ?? "unknown") as EarningsStatus,
      providerEpsActual: event ? numberValue(event.eps_actual) : null,
      providerRevenueActual: event ? numberValue(event.revenue_actual) : null,
      epsEstimate: event ? numberValue(event.eps_estimate) : null,
      revenueEstimate: event ? numberValue(event.revenue_estimate) : null,
      official,
      filing: {
        url: event?.sec_filing_url ?? null,
        accession: event?.sec_accession ?? null,
        form: event?.sec_form ?? null,
        filedAt: event?.sec_filed_at ?? null,
      },
    }, startedAt);
    audit.cik = cik;
    if (fetchError) audit.reasons = [fetchError, ...audit.reasons];
    rows.push(audit);
    console.error(`[backfill] ${index + 1}/${targets.length} ${target.symbol} -> ${audit.decision}${official === null && cik === null ? " (no CIK)" : ""}`);
    if (index < targets.length - 1) await sleep(options.paceMs);
  }

  const report = {
    generatedAt: startedAt,
    mode: options.apply ? "apply" : "dry-run",
    totals: tally(rows),
    rows,
  };
  fs.writeFileSync(options.outPath, `${JSON.stringify(report, null, 2)}\n`);
  console.error(`[backfill] audit report written to ${options.outPath}`);

  printSummary(rows);

  if (options.apply) {
    applyWrites(rows, options, startedAt, fetchFailures);
  }
}

function tally(rows: AuditRow[]): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const row of rows) {
    totals[row.decision] = (totals[row.decision] ?? 0) + 1;
  }
  return totals;
}

function printSummary(rows: AuditRow[]): void {
  const counts = tally(rows);
  console.error("\n== SUMMARY ==");
  for (const decision of [
    "match", "different-basis", "conflict", "official-only", "finnhub-only", "unresolved", "pending",
  ]) {
    console.error(`${decision.padEnd(16)} ${counts[decision] ?? 0}`);
  }
  console.error("== ROWS ==");
  for (const row of rows) {
    const gaapEps = row.sec.gaapDilutedEps === null ? "-" : String(row.sec.gaapDilutedEps);
    const providerEps = row.finnhub.epsActual === null ? "-" : String(row.finnhub.epsActual);
    const gaapRev = row.sec.gaapQuarterlyRevenue === null ? "-" : String(row.sec.gaapQuarterlyRevenue);
    const providerRev = row.finnhub.revenueActual === null ? "-" : String(row.finnhub.revenueActual);
    console.error(
      `${row.symbol.padEnd(6)} ${row.decision.padEnd(14)} eps(provider=${providerEps.padStart(8)} gaap=${gaapEps.padStart(8)}) rev(provider=${providerRev.padStart(11)} gaap=${gaapRev.padStart(11)})`,
    );
  }
}

function sqlLiteral(value: string | number | null): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  return `'${value.replace(/'/g, "''")}'`;
}

function applyWrites(rows: AuditRow[], options: CliOptions, updatedAt: string, fetchFailures: string[]): void {
  const statements: string[] = [];
  let changed = 0;
  for (const row of rows) {
    if (!row.write) continue;
    const write = row.write;
    // Canonical values are never cleared by a null re-resolution: the value
    // columns are COALESCE-wrapped, so a null write keeps the existing GAAP
    // figure (same rule as applyOfficialMetrics on the Worker side).
    statements.push(
      `UPDATE earnings_events SET
        eps_actual_gaap = COALESCE(${sqlLiteral(write.epsActualGaap)}, eps_actual_gaap),
        eps_actual_gaap_source = COALESCE(${sqlLiteral(write.epsActualGaapSource)}, eps_actual_gaap_source),
        eps_actual_adjusted = COALESCE(${sqlLiteral(write.epsActualAdjusted)}, eps_actual_adjusted),
        eps_actual_adjusted_source = COALESCE(${sqlLiteral(write.epsActualAdjustedSource)}, eps_actual_adjusted_source),
        revenue_actual_official = COALESCE(${sqlLiteral(write.revenueActualOfficial)}, revenue_actual_official),
        revenue_actual_source = COALESCE(${sqlLiteral(write.revenueActualSource)}, revenue_actual_source),
        eps_estimate_source = COALESCE(${sqlLiteral(write.epsEstimateSource)}, eps_estimate_source),
        revenue_estimate_source = COALESCE(${sqlLiteral(write.revenueEstimateSource)}, revenue_estimate_source),
        reported_at = COALESCE(${sqlLiteral(write.reportedAt)}, reported_at),
        reported_at_source = COALESCE(${sqlLiteral(write.reportedAtSource)}, reported_at_source),
        fiscal_period_end = COALESCE(${sqlLiteral(write.fiscalPeriodEnd)}, fiscal_period_end),
        data_quality_status = ${sqlLiteral(write.dataQualityStatus)},
        updated_at = ${sqlLiteral(updatedAt)}
      WHERE id = ${sqlLiteral(write.eventId)};`,
    );
    changed += 1;
  }
  const counts = tally(rows);
  // Diagnostics meta keys are stamped on EVERY apply run (even a no-op one)
  // so lastAttemptAt / counts stay fresh; LastError reflects fetch failures.
  const meta = [
    `INSERT INTO app_meta (key, value) VALUES ('earningsOfficialAuditLastAttemptAt', ${sqlLiteral(updatedAt)}) ON CONFLICT(key) DO UPDATE SET value = excluded.value;`,
    `INSERT INTO app_meta (key, value) VALUES ('earningsOfficialAuditLastSuccessAt', ${sqlLiteral(updatedAt)}) ON CONFLICT(key) DO UPDATE SET value = excluded.value;`,
    `INSERT INTO app_meta (key, value) VALUES ('earningsOfficialAuditCounts', ${sqlLiteral(JSON.stringify({
      audited: rows.filter((row) => row.decision !== "pending" && row.decision !== "unresolved").length,
      match: counts.match ?? 0,
      differentBasis: counts["different-basis"] ?? 0,
      conflict: counts.conflict ?? 0,
      officialOnly: counts["official-only"] ?? 0,
      finnhubOnly: counts["finnhub-only"] ?? 0,
      unresolved: counts.unresolved ?? 0,
      pending: counts.pending ?? 0,
    }))}) ON CONFLICT(key) DO UPDATE SET value = excluded.value;`,
  ];
  if (fetchFailures.length > 0) {
    meta.push(
      `INSERT INTO app_meta (key, value) VALUES ('earningsOfficialAuditLastError', ${sqlLiteral(fetchFailures[0]!.slice(0, 480))}) ON CONFLICT(key) DO UPDATE SET value = excluded.value;`,
    );
  } else {
    meta.push(`DELETE FROM app_meta WHERE key = 'earningsOfficialAuditLastError';`);
  }
  if (changed === 0) {
    console.error("[backfill] --apply: no official writes to perform (all unchanged or unresolved)");
    return;
  }
  const sqlFile = path.join(SCRIPT_DIR, `.earnings-official-backfill.${Date.now()}.sql`);
  fs.writeFileSync(sqlFile, [...statements, ...meta].join("\n"));
  try {
    const result = spawnSync("npx", ["--yes", `wrangler@${options.wrangler}`, "d1", "execute", options.db, "--remote", "--file", sqlFile], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    if (result.status !== 0) {
      throw new Error(`wrangler d1 execute --file failed (${result.status}):\n${result.stderr?.slice(0, 3000) || result.stdout?.slice(0, 3000)}`);
    }
    console.error(`[backfill] --apply: ${changed} official-metric UPDATE(s) + diagnostics meta keys applied to ${options.db}`);
  } finally {
    fs.unlinkSync(sqlFile);
  }
}

run().catch((error) => {
  console.error(`[backfill] fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exit(1);
});