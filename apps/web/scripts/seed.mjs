#!/usr/bin/env node
/**
 * Seed D1 with the central demo data (packages/contracts demo-data.ts).
 * Single source of truth: values are never duplicated here — the SQL is generated
 * from the demo-data bundle at runtime.
 *
 * Usage:
 *   node scripts/seed.mjs            # remote D1 (production)
 *   node scripts/seed.mjs --local    # local D1 (wrangler dev / CI)
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(__dirname, "..");
const repoDir = path.resolve(webDir, "../..");
const cacheDir = path.join(webDir, "node_modules/.cache");
// esbuild is hoisted to the workspace root by npm workspaces.
const esbuildBin = existsSync(path.join(webDir, "node_modules/.bin/esbuild"))
  ? path.join(webDir, "node_modules/.bin/esbuild")
  : path.join(repoDir, "node_modules/.bin/esbuild");
const bundlePath = path.join(cacheDir, "demo-data.cjs");
const coreBundlePath = path.join(cacheDir, "core-universe.cjs");
const sqlPath = path.join(cacheDir, "seed.sql");
const local = process.argv.includes("--local");

mkdirSync(cacheDir, { recursive: true });

// 1) Bundle the TS demo-data to CJS so we can import it here.
execFileSync(esbuildBin, [
  path.join(repoDir, "packages/contracts/src/demo-data.ts"),
  "--bundle",
  "--format=cjs",
  "--platform=node",
  `--outfile=${bundlePath}`,
], { stdio: "inherit" });

const { demoData } = await import(pathToFileURL(bundlePath).href);

// Bundle the validated Core configuration as well. The seed must consume the
// checked-in source of truth rather than maintain a second ticker list.
execFileSync(esbuildBin, [
  path.join(repoDir, "packages/contracts/src/core-universe.ts"),
  "--bundle",
  "--format=cjs",
  "--platform=node",
  `--outfile=${coreBundlePath}`,
], { stdio: "inherit" });

const { CORE_UNIVERSE, CORE_UNIVERSE_VERSION } = await import(pathToFileURL(coreBundlePath).href);

const esc = (v) => String(v).replace(/'/g, "''");
const q = (v) => `'${esc(v)}'`;
const json = (v) => q(JSON.stringify(v));

const lines = [];
const ins = (table, cols, rows) => {
  if (rows.length === 0) return;
  lines.push(`INSERT INTO ${table} (${cols}) VALUES`);
  lines.push(
    rows
      .map((r, i) => `(${r.map((v) => v ?? "NULL").join(",")})${i < rows.length - 1 ? "," : ";"}`)
      .join("\n"),
  );
};

// Reset (idempotent) — also reset AUTOINCREMENT counters so re-runs keep
// deterministic ids (scans.id=1, scan_candidates.id=1..n) and FK references.
lines.push(
  "DELETE FROM decision_reasons;",
  "DELETE FROM scan_candidates;",
  "DELETE FROM scans;",
  "DELETE FROM strategies;",
  "DELETE FROM stocks;",
  "DELETE FROM earnings;",
  "DELETE FROM shadow_positions;",
  "DELETE FROM bot_events;",
  "DELETE FROM research;",
  "DELETE FROM app_meta;",
  "DELETE FROM sqlite_sequence;",
);

const { status, portfolio, scan } = demoData;
const seedUpdatedAt = status.lastDataUpdate ?? status.latestScan ?? "2026-08-10T20:15:00Z";
const coreSymbolsSql = CORE_UNIVERSE.map(q);

// Reconcile the canonical Core baseline before inserting stock-specific demo
// rows. Existing universe lifecycle rows remain historical; only membership
// state changes, matching the runtime reconciliation behavior.
lines.push(
  `UPDATE earnings_universe
   SET active = 0,
       universe_version = ${Number(CORE_UNIVERSE_VERSION)},
       removed_at = COALESCE(removed_at, ${q(seedUpdatedAt)}),
       updated_at = ${q(seedUpdatedAt)}
   WHERE source = 'core'
     AND symbol NOT IN (${coreSymbolsSql.join(",")})
     AND (active = 1 OR removed_at IS NULL);`,
  `INSERT INTO earnings_universe
    (symbol, company, cik, exchange, investor_relations_url, index_memberships, metadata_provider, active, source, universe_version, added_at, removed_at, updated_at)
   VALUES
${CORE_UNIVERSE.map((symbol) => `(${q(symbol)},${q(symbol)},NULL,NULL,NULL,${q("[]")},${q("core-universe")},1,${q("core")},${Number(CORE_UNIVERSE_VERSION)},${q(seedUpdatedAt)},NULL,${q(seedUpdatedAt)})`).join(",\n")}
   ON CONFLICT(symbol) DO UPDATE SET
     active = 1,
     source = 'core',
     universe_version = excluded.universe_version,
     added_at = COALESCE(earnings_universe.added_at, excluded.added_at),
     removed_at = NULL,
     updated_at = excluded.updated_at;`,
);

// app_meta (portfolio + status extras + risk policy)
const metaRows = [
  ["initialCapital", String(portfolio.initialCapital)],
  ["equity", String(portfolio.equity)],
  ["returnPct", String(portfolio.returnPct)],
  ["cash", String(portfolio.cash)],
  ["invested", String(portfolio.invested)],
  ["openPositions", String(portfolio.openPositions)],
  ["openRiskPct", String(portfolio.openRiskPct)],
  ["grossExposurePct", String(portfolio.grossExposurePct)],
  ["riskPolicy", JSON.stringify(portfolio.riskPolicy)],
  ["engine", status.engine],
  ["nextScan", status.nextScan ?? ""],
  ["lastDataUpdate", status.lastDataUpdate ?? ""],
  ["apiHealth", status.apiHealth],
];
lines.push("INSERT INTO app_meta (key, value) VALUES");
lines.push(
  metaRows.map(([k, v], i) => `(${q(k)}, ${q(v)})${i < metaRows.length - 1 ? "," : ";"}`).join("\n"),
);

// stocks (from candidates + positions symbols)
const stockSymbols = new Set(demoData.candidates.map((c) => c.symbol));
demoData.positions.forEach((p) => stockSymbols.add(p.symbol));
const stockRows = [...stockSymbols].map((symbol) => {
  const c = demoData.candidates.find((x) => x.symbol === symbol);
  return c
    ? [q(c.symbol), q(c.company), q(c.sector), String(c.marketCap), String(c.price), q(c.updatedAt)]
    : null;
}).filter(Boolean);
ins("stocks", "symbol, company, sector, market_cap, price, updated_at", stockRows);

// strategies
ins(
  "strategies",
  "id, name, version, status, description, universe, typical_holding_period, signals_today, open_shadow_positions, metadata, updated_at",
  demoData.strategies.map((s) => [
    q(s.id), q(s.name), q(s.version), q(s.state), q(s.description),
    q(s.universe), q(s.holdingPeriod), String(s.signalsToday), String(s.openPositions),
    json(s.parameters), q("2026-08-10T20:15:00Z"),
  ]),
);

// scans + candidates + decision reasons
lines.push(`INSERT INTO scans (scanned_at, universe, passed_filters, candidates, setups, watch) VALUES (${[
  q(status.latestScan ?? "2026-08-10T20:15:00Z"), String(scan.universe), String(scan.passedFilters),
  String(scan.candidates), String(scan.setups), String(scan.watch),
].join(",")});`);
const candRows = [];
const reasonRows = [];
demoData.candidates.forEach((c, i) => {
  const cid = i + 1;
  candRows.push([
    "1", q(c.symbol), q(c.company), q(c.sector), String(c.marketCap), String(c.price),
    String(c.quantScore), q(c.strategyId), q(c.strategy), q(c.strategyVersion),
    q(c.trend), String(c.momentum), String(c.relativeStrength), String(c.relativeVolume),
    c.breakout ? q(c.breakout) : "NULL",
    c.earningsDate ? q(c.earningsDate) : "NULL",
    c.earningsProximityDays === null ? "NULL" : String(c.earningsProximityDays),
    q(c.status), q(c.direction), json(c.riskFlags), q(c.updatedAt),
  ]);
  c.reasons.forEach((r, j) => {
    reasonRows.push([
      String(cid),
      q(r.code), q(r.label), q(r.outcome),
      r.observed ? q(r.observed) : "NULL",
      r.threshold ? q(r.threshold) : "NULL",
    ]);
  });
});
ins(
  "scan_candidates",
  "scan_id, symbol, company, sector, market_cap, price, quant_score, strategy_id, strategy, strategy_version, trend, momentum, relative_strength, relative_volume, breakout, earnings_date, earnings_proximity_days, status, direction, risk_flags, updated_at",
  candRows,
);
ins("decision_reasons", "candidate_id, reason_code, reason_label, outcome, observed, threshold", reasonRows);

// earnings
ins(
  "earnings",
  "symbol, company, date, timing, event_signal, engine_relevant, signal, strategy, has_position, tracked, updated_at",
  demoData.earnings.map((e) => [
    q(e.symbol), q(e.company), q(e.date), q(e.timing), q(e.eventSignal),
    e.engineRelevant ? "1" : "0", e.signal ? q(e.signal) : "NULL", e.strategy ? q(e.strategy) : "NULL",
    e.hasPosition ? "1" : "0", e.tracked ? "1" : "0",
    q(e.updatedAt ?? "2026-08-10T20:15:00Z"),
  ]),
);

// shadow positions
ins(
  "shadow_positions",
  "symbol, strategy, entry_price, current_price, stop_price, quantity, risk_amount, unrealized_pnl, return_pct, r_multiple, opened_at, updated_at",
  demoData.positions.map((p) => [
    q(p.symbol), q(p.strategy), String(p.entryPrice), String(p.currentPrice), String(p.stopPrice),
    String(p.quantity), String(p.riskAmount), String(p.unrealizedPnl), String(p.returnPct),
    String(p.rMultiple), q(p.openedAt), q(p.openedAt),
  ]),
);

// bot events
ins(
  "bot_events",
  "event_id, event_type, message, severity, symbol, strategy_id, created_at",
  demoData.events.map((e) => [
    q(e.id), q(e.type), q(e.message), q(e.severity),
    e.symbol ? q(e.symbol) : "NULL", e.strategyId ? q(e.strategyId) : "NULL", q(e.createdAt),
  ]),
);

// research
ins(
  "research",
  "id, strategy_id, strategy, stage, period, status, metrics",
  demoData.research.map((r) => [q(r.id), q(r.strategyId), q(r.strategy), q(r.stage), q(r.period), q(r.status), json(r.metrics)]),
);

writeFileSync(sqlPath, lines.join("\n") + "\n");

// Apply via wrangler d1 execute
const args = ["d1", "execute", "stock-autotrader-db", "--file", sqlPath];
if (local) args.push("--local");
else args.push("--remote");
console.log(`Applying seed to ${local ? "local" : "remote"} D1...`);
execFileSync("npx", ["--yes", "wrangler@4", ...args], { stdio: "inherit", cwd: webDir });
unlinkSync(bundlePath);
unlinkSync(coreBundlePath);
console.log("Seed complete.");
