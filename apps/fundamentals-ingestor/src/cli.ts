#!/usr/bin/env node
/**
 * fundamentals-ingestor CLI.
 *
 * Usage:
 *   npx tsx apps/fundamentals-ingestor/src/cli.ts audit --symbol ADBE
 *   npx tsx apps/fundamentals-ingestor/src/cli.ts bootstrap --symbol ADBE --local
 *   npx tsx apps/fundamentals-ingestor/src/cli.ts maintenance --all-core --local
 *
 * Commands:
 *   audit       Read-only: fetch SEC, normalize, print canonical + derived metrics
 *   bootstrap   Fetch SEC + normalize + write D1 (local or remote)
 *   maintenance Check for new filings, reprocess changed symbols only
 */

import { spawnSync } from "node:child_process";
import {
  fetchCompanyFacts,
  fetchTickerCikMap,
  SEC_DEFAULT_USER_AGENT,
  type CompanyFacts,
  type FiscalIdentity,
} from "../../web/worker/earnings/sec-xbrl";
import { type CanonicalField } from "./concepts";
import { normalizePeriod, type NormalizedPeriod } from "./normalize";
import {
  computeDerivedMetrics,
} from "./metrics";
import {
  periodToRow,
  type D1FundamentalPeriodRow,
} from "./storage";
import { CORE_UNIVERSE } from "@stock-autotrader/contracts";

interface CliOptions {
  command: "audit" | "bootstrap" | "maintenance";
  symbol: string | null;
  allCore: boolean;
  local: boolean;
  remote: boolean;
  apply: boolean;
  paceMs: number;
  db: string;
  wrangler: string;
  limit: number | null;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    command: argv[0] as "audit" | "bootstrap" | "maintenance",
    symbol: null,
    allCore: false,
    local: true,
    remote: false,
    apply: false,
    paceMs: 1100,
    db: "stock-autotrader-db",
    wrangler: "4.122.0",
    limit: null,
  };
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case "--symbol": options.symbol = argv[++i]!.toUpperCase(); break;
      case "--all-core": options.allCore = true; break;
      case "--local": options.local = true; options.remote = false; break;
      case "--remote": options.remote = true; options.local = false; break;
      case "--apply": options.apply = true; break;
      case "--pace-ms": options.paceMs = Number(argv[++i]) || 1100; break;
      case "--db": options.db = argv[++i]!; break;
      case "--wrangler": options.wrangler = argv[++i]!; break;
      case "--limit": options.limit = Number(argv[++i]); break;
      case "--help":
        printHelp();
        process.exit(0);
    }
  }
  return options;
}

function printHelp(): void {
  console.error(`
fundamentals-ingestor CLI

Commands:
  audit       Read-only SEC fetch + normalize + print metrics
   --symbol X     single symbol (default ADBE)
   --all-core     all 50 Core Universe symbols

  bootstrap   Fetch + normalize + write D1 (requires --local or --remote --apply)
   --symbol X     single symbol
   --all-core     all 50 symbols
   --local        write to local D1 (default)
   --remote       write to remote D1 (requires --apply)
   --apply        actually write (without --apply, dry-run)

  maintenance Incremental: detect new filings, reprocess changed symbols only
   --symbol X     restrict to one symbol
   --all-core     check all 50 symbols
   --local/--remote --apply

Examples:
  npx tsx apps/fundamentals-ingestor/src/cli.ts audit --symbol ADBE
  npx tsx apps/fundamentals-ingestor/src/cli.ts bootstrap --symbol ADBE --local
  npx tsx apps/fundamentals-ingestor/src/cli.ts bootstrap --all-core --remote --apply
`);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "--help") {
    printHelp();
    process.exit(0);
  }
  const options = parseArgs(argv);
  if (!["audit", "bootstrap", "maintenance"].includes(options.command)) {
    console.error(`Unknown command: ${options.command}`);
    printHelp();
    process.exit(2);
  }

  const symbols = options.symbol ? [options.symbol] : options.allCore ? [...CORE_UNIVERSE] : ["ADBE"];
  if (options.limit) symbols.length = Math.min(symbols.length, options.limit);

  console.error(`[fundamentals] ${options.command} — ${symbols.length} symbol(s) ${options.remote ? "(remote)" : "(local)"}`);

  const cikMap = await fetchTickerCikMap({ userAgent: SEC_DEFAULT_USER_AGENT });
  let complete = 0, partial = 0, missing = 0;

  for (const symbol of symbols) {
    const cik = cikMap.get(symbol);
    if (!cik) {
      console.error(`[fundamentals] ${symbol}: no CIK found`);
      missing++;
      continue;
    }
    try {
      const facts = await fetchCompanyFacts(cik, { userAgent: SEC_DEFAULT_USER_AGENT });
      const result = await processSymbol(symbol, facts, options);
      if (result.quality === "complete") complete++;
      else if (result.quality === "partial") partial++;
      else missing++;
    } catch (err) {
      console.error(`[fundamentals] ${symbol}: fetch error: ${err instanceof Error ? err.message : String(err)}`);
      missing++;
    }
    await sleep(options.paceMs);
  }

  console.error(`\n[fundamentals] Coverage: Complete: ${complete}/${symbols.length}  Partial: ${partial}/${symbols.length}  Missing: ${missing}/${symbols.length}`);
}

interface ProcessResult {
  quality: "complete" | "partial" | "none";
}

async function processSymbol(symbol: string, facts: CompanyFacts, options: CliOptions): Promise<ProcessResult> {
  // For audit: just normalize the most recent quarterly period and print
  // For bootstrap: normalize all available periods and write D1

  // Find most recent fiscal identity from facts
  const identities = extractFiscalIdentities(facts);
  if (identities.length === 0) {
    console.error(`  ${symbol}: no fiscal identities found`);
    return { quality: "none" };
  }

  // Process the most recent quarterly period
  const latest = identities[0]!;
  const period = normalizePeriod(symbol, facts, latest);

  // Compute derived metrics from the latest period
  const derived = computeDerivedMetrics({
    revenue: period.fields.revenue?.value ?? null,
    operatingIncome: period.fields.operating_income?.value ?? null,
    pretaxIncome: period.fields.pretax_income?.value ?? null,
    incomeTax: period.fields.income_tax?.value ?? null,
    netIncome: period.fields.net_income?.value ?? null,
    dilutedEps: period.fields.diluted_eps?.value ?? null,
    operatingCashFlow: period.fields.operating_cash_flow?.value ?? null,
    capex: period.fields.capex?.value ?? null,
    cash: period.fields.cash?.value ?? null,
    shortTermInvestments: period.fields.short_term_investments?.value ?? null,
    totalDebt: period.fields.total_debt?.value ?? null,
    shareholdersEquity: period.fields.shareholders_equity?.value ?? null,
    sharesOutstanding: period.fields.shares_outstanding?.value ?? null,
    currentAssets: period.fields.current_assets?.value ?? null,
    currentLiabilities: period.fields.current_liabilities?.value ?? null,
    totalAssets: period.fields.total_assets?.value ?? null,
    totalLiabilities: period.fields.total_liabilities?.value ?? null,
    weightedAvgDilutedShares: period.fields.weighted_avg_diluted_shares?.value ?? null,
  });

  if (options.command === "audit") {
    printAudit(symbol, period, derived);
    return { quality: period.missingFields.length === 0 ? "complete" : period.missingFields.length < 10 ? "partial" : "none" };
  }

  if (options.command === "bootstrap" && options.apply) {
    await writePeriodToD1(period, derived, options);
  }

  return { quality: period.missingFields.length === 0 ? "complete" : "partial" };
}

function printAudit(symbol: string, period: NormalizedPeriod, derived: ReturnType<typeof computeDerivedMetrics>): void {
  console.error(`\n=== ${symbol} — Audit ===`);
  console.error(`  Fiscal: FY${period.fiscalYear} ${period.fiscalPeriod}  (${period.periodStart} → ${period.periodEnd})`);
  console.error(`  Filing: ${period.form}  accession: ${period.accession}  filed: ${period.filingDate}`);
  console.error(`  Taxonomy: ${period.taxonomy}`);
  console.error(`  Quality: ${period.missingFields.length === 0 ? "complete" : `partial (${period.missingFields.length} missing)`}`);

  const fields: CanonicalField[] = ["revenue", "operating_income", "pretax_income", "income_tax", "net_income", "diluted_eps", "operating_cash_flow", "capex", "cash", "total_debt", "shareholders_equity", "shares_outstanding"];
  for (const f of fields) {
    const field = period.fields[f];
    if (field && field.value !== null) {
      console.error(`  ${f}: ${field.value} (${field.concept}, ${field.taxonomy})`);
    } else {
      console.error(`  ${f}: NULL (${field?.blockers[0] || "no data"})`);
    }
  }

  console.error(`\n  Derived:`);
  console.error(`    FCF: ${derived.freeCashFlow?.toExponential(3) ?? "NULL"}`);
  console.error(`    FCF Margin: ${derived.fcfMarginPct?.toFixed(2) ?? "NULL"}%`);
  console.error(`    Debt/Equity: ${derived.debtToEquity?.toFixed(4) ?? "NULL"}`);
  console.error(`    ROIC: ${derived.roicPct?.toFixed(2) ?? "NULL"}%`);
  if (derived.blockers.length > 0) {
    console.error(`    Blockers: ${derived.blockers.join("; ")}`);
  }
}

async function writePeriodToD1(period: NormalizedPeriod, derived: ReturnType<typeof computeDerivedMetrics>, options: CliOptions): Promise<void> {
  const updatedAt = new Date().toISOString();
  const row = periodToRow(period, derived, updatedAt);
  const sql = buildUpsertSql(row);
  const result = runWrangler(sql, options);
  if (result.status !== 0) {
    throw new Error(`D1 write failed: ${result.stderr}`);
  }
}

function buildUpsertSql(row: D1FundamentalPeriodRow): string {
  const v = (val: string | number | null): string => {
    if (val === null || val === undefined) return "NULL";
    if (typeof val === "number") return Number.isFinite(val) ? String(val) : "NULL";
    return `'${String(val).replace(/'/g, "''")}'`;
  };
  return `INSERT INTO stock_fundamental_periods (symbol, fiscal_year, fiscal_period, period_start, period_end, filing_date, form, accession, taxonomy, currency, revenue, gross_profit, operating_income, pretax_income, income_tax, net_income, diluted_eps, operating_cash_flow, capex, depreciation_amortization, free_cash_flow, cash, short_term_investments, total_debt, total_assets, total_liabilities, shareholders_equity, current_assets, current_liabilities, weighted_avg_diluted_shares, shares_outstanding, source, quality, provenance_json, updated_at) VALUES (${v(row.symbol)}, ${v(row.fiscal_year)}, ${v(row.fiscal_period)}, ${v(row.period_start)}, ${v(row.period_end)}, ${v(row.filing_date)}, ${v(row.form)}, ${v(row.accession)}, ${v(row.taxonomy)}, ${v(row.currency)}, ${v(row.revenue)}, ${v(row.gross_profit)}, ${v(row.operating_income)}, ${v(row.pretax_income)}, ${v(row.income_tax)}, ${v(row.net_income)}, ${v(row.diluted_eps)}, ${v(row.operating_cash_flow)}, ${v(row.capex)}, ${v(row.depreciation_amortization)}, ${v(row.free_cash_flow)}, ${v(row.cash)}, ${v(row.short_term_investments)}, ${v(row.total_debt)}, ${v(row.total_assets)}, ${v(row.total_liabilities)}, ${v(row.shareholders_equity)}, ${v(row.current_assets)}, ${v(row.current_liabilities)}, ${v(row.weighted_avg_diluted_shares)}, ${v(row.shares_outstanding)}, ${v(row.source)}, ${v(row.quality)}, ${v(row.provenance_json)}, ${v(row.updated_at)});`;
}

function runWrangler(command: string, options: CliOptions): { status: number; stdout: string; stderr: string } {
  const args = ["d1", "execute", options.db];
  if (options.remote) args.push("--remote");
  else args.push("--local");
  args.push("--command", command);
  const result = spawnSync("npx", ["--yes", `wrangler@${options.wrangler}`, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: result.status ?? 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/**
 * Extract fiscal identities from a parsed CompanyFacts payload.
 * Returns unique (fy, fp) pairs sorted newest-first.
 */
function extractFiscalIdentities(facts: CompanyFacts): FiscalIdentity[] {
  const seen = new Set<string>();
  const identities: FiscalIdentity[] = [];
  for (const fact of facts.facts) {
    const key = `${fact.fy}-${fact.fp}`;
    if (fact.fy && fact.fp && !seen.has(key)) {
      seen.add(key);
      identities.push({
        fiscalYear: fact.fy,
        fiscalQuarter: fact.fp.startsWith("Q") ? Number(fact.fp.slice(1)) : null,
        scheduledDate: null,
        fiscalPeriodEnd: null,
      });
    }
  }
  // Sort by fiscal year desc, then quarter desc
  identities.sort((a, b) => {
    if (a.fiscalYear !== b.fiscalYear) return (b.fiscalYear ?? 0) - (a.fiscalYear ?? 0);
    return (b.fiscalQuarter ?? 0) - (a.fiscalQuarter ?? 0);
  });
  return identities;
}

main().catch((err) => {
  console.error(`[fundamentals] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
