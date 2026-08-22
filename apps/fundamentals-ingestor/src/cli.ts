#!/usr/bin/env node
/**
 * fundamentals-ingestor CLI.
 *
 * Pipeline: SEC → parse → normalize (all periods) → TTM aggregation →
 * periods + snapshot → D1 UPSERT (restatement-aware).
 *
 * Commands:
 *   audit       Read-only SEC fetch + normalize + print all periods + TTM
 *   bootstrap   Fetch + normalize + write periods + snapshot to D1
 *   maintenance Incremental: detect new filings via D1, reprocess only changed
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
  type D1FundamentalSnapshotRow,
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
      case "--help": printHelp(); process.exit(0);
    }
  }
  return options;
}

function printHelp(): void {
  console.error(`
fundamentals-ingestor CLI

Commands:
  audit       Read-only SEC fetch + normalize + print all periods + TTM
  bootstrap   Fetch + normalize + write periods + snapshot to D1
  maintenance Incremental: detect new filings via D1, reprocess only changed

Options:
  --symbol X     single symbol (default ADBE)
  --all-core     all 50 Core Universe symbols
  --local        write to local D1 (default)
  --remote       write to remote D1 (requires --apply)
  --apply        actually write (without --apply, dry-run)
  --pace-ms N    SEC pacing between fetches (default 1100)
  --db NAME      D1 database name (default stock-autotrader-db)
  --wrangler V   wrangler version pin (default 4.122.0)
  --limit N      cap symbols this run

Examples:
  npx tsx apps/fundamentals-ingestor/src/cli.ts audit --symbol ADBE
  npx tsx apps/fundamentals-ingestor/src/cli.ts bootstrap --all-core --local --apply
  npx tsx apps/fundamentals-ingestor/src/cli.ts maintenance --all-core --remote --apply
`);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "--help") { printHelp(); process.exit(0); }
  const options = parseArgs(argv);
  if (!["audit", "bootstrap", "maintenance"].includes(options.command)) {
    console.error(`Unknown command: ${options.command}`); printHelp(); process.exit(2);
  }

  const symbols = options.symbol ? [options.symbol] : options.allCore ? [...CORE_UNIVERSE] : ["ADBE"];
  if (options.limit) symbols.length = Math.min(symbols.length, options.limit);

  console.error(`[fundamentals] ${options.command} — ${symbols.length} symbol(s) ${options.remote ? "(remote)" : "(local)"}`);

  const cikMap = await fetchTickerCikMap({ userAgent: SEC_DEFAULT_USER_AGENT });
  let complete = 0, partial = 0, missing = 0;

  for (const symbol of symbols) {
    const cik = cikMap.get(symbol);
    if (!cik) { console.error(`[fundamentals] ${symbol}: no CIK found`); missing++; continue; }
    try {
      const facts = await fetchCompanyFacts(cik, { userAgent: SEC_DEFAULT_USER_AGENT });

      // Maintenance: check if filing already processed (incremental)
      if (options.command === "maintenance" && options.apply) {
        const latestAccession = getLatestAccession(facts);
        const alreadyProcessed = await checkAlreadyProcessed(symbol, latestAccession, options);
        if (alreadyProcessed) {
          console.error(`  ${symbol}: filing ${latestAccession} already processed — skip`);
          continue;
        }
      }

      const result = await processSymbol(symbol, facts, options);
      if (result.quality === "complete") complete++;
      else if (result.quality === "partial") partial++;
      else missing++;
    } catch (err) {
      console.error(`[fundamentals] ${symbol}: error: ${err instanceof Error ? err.message : String(err)}`);
      missing++;
    }
    await sleep(options.paceMs);
  }

  console.error(`\n[fundamentals] Coverage: Complete: ${complete}/${symbols.length}  Partial: ${partial}/${symbols.length}  Missing: ${missing}/${symbols.length}`);
}

interface ProcessResult { quality: "complete" | "partial" | "none"; }

async function processSymbol(symbol: string, facts: CompanyFacts, options: CliOptions): Promise<ProcessResult> {
  const identities = extractFiscalIdentities(facts);
  if (identities.length === 0) {
    console.error(`  ${symbol}: no fiscal identities found`);
    return { quality: "none" };
  }

  // Normalize ALL periods (not just the first)
  const periods: NormalizedPeriod[] = [];
  for (const identity of identities) {
    const period = normalizePeriod(symbol, facts, identity);
    periods.push(period);
  }

  // Compute derived metrics from the most recent period
  const latest = periods[0]!;
  const derived = computeDerivedMetrics(extractTtmInputs(latest));

  if (options.command === "audit") {
    printAudit(symbol, latest, derived, periods);
    return { quality: latest.missingFields.length === 0 ? "complete" : latest.missingFields.length < 10 ? "partial" : "none" };
  }

  // Bootstrap + Maintenance: write periods + snapshot when --apply
  if (options.apply) {
    for (const period of periods) {
      await writePeriodToD1(period, options);
    }
    const snapshot = buildSnapshot(symbol, periods);
    await writeSnapshotToD1(snapshot, options);
  }

  return { quality: latest.missingFields.length === 0 ? "complete" : "partial" };
}

function extractTtmInputs(period: NormalizedPeriod) {
  return {
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
  };
}

function printAudit(symbol: string, latest: NormalizedPeriod, derived: ReturnType<typeof computeDerivedMetrics>, periods: NormalizedPeriod[]): void {
  console.error(`\n=== ${symbol} — Audit (${periods.length} periods) ===`);
  console.error(`  Fiscal: FY${latest.fiscalYear} ${latest.fiscalPeriod}  (${latest.periodStart} → ${latest.periodEnd})`);
  console.error(`  Filing: ${latest.form}  accession: ${latest.accession}  filed: ${latest.filingDate}`);
  console.error(`  Taxonomy: ${latest.taxonomy}`);
  console.error(`  Quality: ${latest.missingFields.length === 0 ? "complete" : `partial (${latest.missingFields.length} missing)`}`);

  const fields: CanonicalField[] = ["revenue", "operating_income", "pretax_income", "income_tax", "net_income", "diluted_eps", "operating_cash_flow", "capex", "cash", "total_debt", "shareholders_equity", "shares_outstanding"];
  for (const f of fields) {
    const field = latest.fields[f];
    if (field && field.value !== null) {
      const derivedFlag = field.derived ? ` [${field.derivation}]` : "";
      console.error(`  ${f}: ${field.value} (${field.concept}, ${field.taxonomy})${derivedFlag}`);
    } else {
      console.error(`  ${f}: NULL (${field?.blockers[0] || "no data"})`);
    }
  }

  console.error(`\n  Derived:`);
  console.error(`    FCF: ${derived.freeCashFlow?.toExponential(3) ?? "NULL"}`);
  console.error(`    FCF Margin: ${derived.fcfMarginPct?.toFixed(2) ?? "NULL"}%`);
  console.error(`    Debt/Equity: ${derived.debtToEquity?.toFixed(4) ?? "NULL"}`);
  console.error(`    ROIC: ${derived.roicPct?.toFixed(2) ?? "NULL"}%`);
  if (derived.blockers.length > 0) console.error(`    Blockers: ${derived.blockers.join("; ")}`);
}

async function writePeriodToD1(period: NormalizedPeriod, options: CliOptions): Promise<void> {
  const updatedAt = new Date().toISOString();
  const derived = computeDerivedMetrics(extractTtmInputs(period));
  const row = periodToRow(period, derived, updatedAt);
  const sql = buildUpsertSql(row);
  runWrangler(sql, options);
}

function buildSnapshot(symbol: string, periods: NormalizedPeriod[]): D1FundamentalSnapshotRow {
  const latest = periods[0]!;
  const updatedAt = new Date().toISOString();
  const derived = computeDerivedMetrics(extractTtmInputs(latest));

  return {
    symbol,
    latest_period_end: latest.periodEnd,
    revenue_ttm: latest.fields.revenue?.value ?? null,
    operating_income_ttm: latest.fields.operating_income?.value ?? null,
    pretax_income_ttm: latest.fields.pretax_income?.value ?? null,
    income_tax_ttm: latest.fields.income_tax?.value ?? null,
    net_income_ttm: latest.fields.net_income?.value ?? null,
    diluted_eps_ttm: latest.fields.diluted_eps?.value ?? null,
    operating_cash_flow_ttm: latest.fields.operating_cash_flow?.value ?? null,
    capex_ttm: latest.fields.capex?.value ?? null,
    free_cash_flow_ttm: derived.freeCashFlow,
    cash: latest.fields.cash?.value ?? null,
    short_term_investments: latest.fields.short_term_investments?.value ?? null,
    total_debt: latest.fields.total_debt?.value ?? null,
    shareholders_equity: latest.fields.shareholders_equity?.value ?? null,
    current_assets: latest.fields.current_assets?.value ?? null,
    current_liabilities: latest.fields.current_liabilities?.value ?? null,
    shares_outstanding: latest.fields.shares_outstanding?.value ?? null,
    roic_ttm: derived.roicPct,
    fcf_margin_ttm: derived.fcfMarginPct,
    debt_to_equity: derived.debtToEquity,
    coverage_status: latest.missingFields.length === 0 ? "complete" : "partial",
    blockers_json: JSON.stringify(latest.missingFields),
    source: "sec-xbrl",
    updated_at: updatedAt,
  };
}

async function writeSnapshotToD1(snapshot: D1FundamentalSnapshotRow, options: CliOptions): Promise<void> {
  const sql = buildSnapshotUpsertSql(snapshot);
  runWrangler(sql, options);
}

function buildUpsertSql(row: ReturnType<typeof periodToRow>): string {
  const v = (val: string | number | null): string => {
    if (val === null || val === undefined) return "NULL";
    if (typeof val === "number") return Number.isFinite(val) ? String(val) : "NULL";
    return `'${String(val).replace(/'/g, "''")}'`;
  };
  return `INSERT INTO stock_fundamental_periods (symbol, fiscal_year, fiscal_period, period_start, period_end, filing_date, form, accession, taxonomy, currency, revenue, gross_profit, operating_income, pretax_income, income_tax, net_income, diluted_eps, operating_cash_flow, capex, depreciation_amortization, free_cash_flow, cash, short_term_investments, total_debt, total_assets, total_liabilities, shareholders_equity, current_assets, current_liabilities, weighted_avg_diluted_shares, shares_outstanding, source, quality, provenance_json, updated_at) VALUES (${v(row.symbol)}, ${v(row.fiscal_year)}, ${v(row.fiscal_period)}, ${v(row.period_start)}, ${v(row.period_end)}, ${v(row.filing_date)}, ${v(row.form)}, ${v(row.accession)}, ${v(row.taxonomy)}, ${v(row.currency)}, ${v(row.revenue)}, ${v(row.gross_profit)}, ${v(row.operating_income)}, ${v(row.pretax_income)}, ${v(row.income_tax)}, ${v(row.net_income)}, ${v(row.diluted_eps)}, ${v(row.operating_cash_flow)}, ${v(row.capex)}, ${v(row.depreciation_amortization)}, ${v(row.free_cash_flow)}, ${v(row.cash)}, ${v(row.short_term_investments)}, ${v(row.total_debt)}, ${v(row.total_assets)}, ${v(row.total_liabilities)}, ${v(row.shareholders_equity)}, ${v(row.current_assets)}, ${v(row.current_liabilities)}, ${v(row.weighted_avg_diluted_shares)}, ${v(row.shares_outstanding)}, ${v(row.source)}, ${v(row.quality)}, ${v(row.provenance_json)}, ${v(row.updated_at)}) ON CONFLICT(symbol, fiscal_year, fiscal_period) DO UPDATE SET filing_date = excluded.filing_date, form = excluded.form, accession = excluded.accession, taxonomy = excluded.taxonomy, revenue = excluded.revenue, gross_profit = excluded.gross_profit, operating_income = excluded.operating_income, pretax_income = excluded.pretax_income, income_tax = excluded.income_tax, net_income = excluded.net_income, diluted_eps = excluded.diluted_eps, operating_cash_flow = excluded.operating_cash_flow, capex = excluded.capex, depreciation_amortization = excluded.depreciation_amortization, free_cash_flow = excluded.free_cash_flow, cash = excluded.cash, short_term_investments = excluded.short_term_investments, total_debt = excluded.total_debt, total_assets = excluded.total_assets, total_liabilities = excluded.total_liabilities, shareholders_equity = excluded.shareholders_equity, current_assets = excluded.current_assets, current_liabilities = excluded.current_liabilities, weighted_avg_diluted_shares = excluded.weighted_avg_diluted_shares, shares_outstanding = excluded.shares_outstanding, source = excluded.source, quality = excluded.quality, provenance_json = excluded.provenance_json, updated_at = excluded.updated_at WHERE excluded.filing_date IS NULL OR stock_fundamental_periods.filing_date IS NULL OR excluded.filing_date >= stock_fundamental_periods.filing_date;`;
}

function buildSnapshotUpsertSql(row: D1FundamentalSnapshotRow): string {
  const v = (val: string | number | null): string => {
    if (val === null || val === undefined) return "NULL";
    if (typeof val === "number") return Number.isFinite(val) ? String(val) : "NULL";
    return `'${String(val).replace(/'/g, "''")}'`;
  };
  return `INSERT INTO stock_fundamental_snapshots (symbol, latest_period_end, revenue_ttm, operating_income_ttm, pretax_income_ttm, income_tax_ttm, net_income_ttm, diluted_eps_ttm, operating_cash_flow_ttm, capex_ttm, free_cash_flow_ttm, cash, short_term_investments, total_debt, shareholders_equity, current_assets, current_liabilities, shares_outstanding, roic_ttm, fcf_margin_ttm, debt_to_equity, coverage_status, blockers_json, source, updated_at) VALUES (${v(row.symbol)}, ${v(row.latest_period_end)}, ${v(row.revenue_ttm)}, ${v(row.operating_income_ttm)}, ${v(row.pretax_income_ttm)}, ${v(row.income_tax_ttm)}, ${v(row.net_income_ttm)}, ${v(row.diluted_eps_ttm)}, ${v(row.operating_cash_flow_ttm)}, ${v(row.capex_ttm)}, ${v(row.free_cash_flow_ttm)}, ${v(row.cash)}, ${v(row.short_term_investments)}, ${v(row.total_debt)}, ${v(row.shareholders_equity)}, ${v(row.current_assets)}, ${v(row.current_liabilities)}, ${v(row.shares_outstanding)}, ${v(row.roic_ttm)}, ${v(row.fcf_margin_ttm)}, ${v(row.debt_to_equity)}, ${v(row.coverage_status)}, ${v(row.blockers_json)}, ${v(row.source)}, ${v(row.updated_at)}) ON CONFLICT(symbol) DO UPDATE SET latest_period_end = excluded.latest_period_end, revenue_ttm = excluded.revenue_ttm, operating_income_ttm = excluded.operating_income_ttm, pretax_income_ttm = excluded.pretax_income_ttm, income_tax_ttm = excluded.income_tax_ttm, net_income_ttm = excluded.net_income_ttm, diluted_eps_ttm = excluded.diluted_eps_ttm, operating_cash_flow_ttm = excluded.operating_cash_flow_ttm, capex_ttm = excluded.capex_ttm, free_cash_flow_ttm = excluded.free_cash_flow_ttm, cash = excluded.cash, short_term_investments = excluded.short_term_investments, total_debt = excluded.total_debt, shareholders_equity = excluded.shareholders_equity, current_assets = excluded.current_assets, current_liabilities = excluded.current_liabilities, shares_outstanding = excluded.shares_outstanding, roic_ttm = excluded.roic_ttm, fcf_margin_ttm = excluded.fcf_margin_ttm, debt_to_equity = excluded.debt_to_equity, coverage_status = excluded.coverage_status, blockers_json = excluded.blockers_json, source = excluded.source, updated_at = excluded.updated_at;`;
}

function runWrangler(command: string, options: CliOptions): void {
  const args = ["d1", "execute", options.db, "--config", "wrangler.jsonc"];
  if (options.remote) args.push("--remote"); else args.push("--local");
  args.push("--command", command);
  // Run wrangler from apps/web so it uses the same D1 local database
  const cwd = new URL("../../apps/web", import.meta.url).pathname;
  const result = spawnSync("npx", ["--yes", `wrangler@${options.wrangler}`, ...args], {
    encoding: "utf8", maxBuffer: 64 * 1024 * 1024, cwd,
  });
  if (result.status !== 0) {
    const err = result.stderr?.slice(0, 2000) || result.stdout?.slice(0, 2000) || "(no output)";
    throw new Error(`D1 write failed (exit ${result.status}): ${err}`);
  }
}

/**
 * Get the latest accession number from a CompanyFacts payload.
 * Used by maintenance to detect if a filing has already been processed.
 */
function getLatestAccession(facts: CompanyFacts): string | null {
  let latest: string | null = null;
  let latestDate = "";
  for (const fact of facts.facts) {
    if (fact.accn && fact.filed && fact.filed > latestDate) {
      latestDate = fact.filed;
      latest = fact.accn;
    }
  }
  return latest;
}

/**
 * Check if the latest filing has already been processed for this symbol.
 * Queries D1 for existing period rows with the given accession.
 */
async function checkAlreadyProcessed(symbol: string, accession: string | null, options: CliOptions): Promise<boolean> {
  if (!accession) return false;
  const sql = `SELECT COUNT(*) as cnt FROM stock_fundamental_periods WHERE symbol = '${symbol}' AND accession = '${accession}';`;
  const args = ["d1", "execute", options.db, "--config", "apps/web/wrangler.jsonc"];
  if (options.remote) args.push("--remote"); else args.push("--local");
  args.push("--command", sql, "--json");
  const result = spawnSync("npx", ["--yes", `wrangler@${options.wrangler}`, ...args], {
    encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) return false; // If query fails, assume not processed
  try {
    const parsed = JSON.parse(result.stdout);
    const rows = Array.isArray(parsed) ? parsed[0]?.results?.[0] : parsed?.results?.[0];
    return (rows?.cnt ?? 0) > 0;
  } catch {
    return false;
  }
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
