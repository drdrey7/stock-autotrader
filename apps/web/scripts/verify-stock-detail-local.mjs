import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WRANGLER = ["--yes", "wrangler@4.123.0"];
const DB = "stock-autotrader-db";
const PORT = 8792;
const ORIGIN = `http://127.0.0.1:${PORT}`;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url, timeoutMs = 5_000) {
  return fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function weeklyRows(count = 459) {
  const end = Date.parse("2026-08-14T00:00:00.000Z");
  return Array.from({ length: count }, (_, index) => {
    const close = index + 1;
    const week = new Date(end - (count - 1 - index) * 7 * 86_400_000).toISOString().slice(0, 10);
    return `(${sqlString("MSFT")},${sqlString(week)},${close},${close + 2},${Math.max(0.5, close - 2)},${close},${1_000_000 + index},1,${close},${sqlString("alpha-vantage")},${sqlString("2026-08-15T06:00:00.000Z")})`;
  }).join(",\n");
}

function installFixtures() {
  const sum199 = (261 + 459) * 199 / 2;
  const sql = `
UPDATE earnings_universe
   SET company = 'Microsoft Corporation', active = 1, source = 'core', logo_url = 'https://example.com/msft.png'
 WHERE symbol = 'MSFT';
UPDATE earnings_universe
   SET company = 'Adobe Inc.', active = 1, source = 'core'
 WHERE symbol = 'ADBE';
INSERT OR REPLACE INTO stock_fundamentals_snapshot
(symbol, market_cap, pe_ttm, revenue_ttm, operating_income_ttm, pretax_income_ttm,
 income_tax_ttm, operating_cash_flow_ttm, capex_ttm, free_cash_flow_ttm, cash,
 short_term_investments, total_debt, shareholders_equity, roic_pct, fcf_margin_pct,
 debt_to_equity, accounting_as_of, market_as_of, accounting_source, market_source,
 accounting_filing_accession, updated_at)
VALUES ('ADBE', 109431750000, 15.1379, 25198000000, 9090000000, 9111000000,
 1882000000, 10481000000, 201000000, 10280000000, 4919000000,
 707000000, NULL, 11518000000, NULL, 40.79688864195571,
 NULL, '2026-05-29', datetime('now'), 'edgartools', 'finnhub',
 '0000796343-26-000112', datetime('now'));
DELETE FROM split_events WHERE symbol = 'MSFT';
DELETE FROM weekly_prices WHERE symbol = 'MSFT';
INSERT OR REPLACE INTO latest_quotes
(symbol, price, change_abs, change_pct, day_high, day_low, day_open, previous_close, provider, provider_timestamp, updated_at)
VALUES ('MSFT', 500, 5, 1, 505, 490, 492, 495, 'finnhub', '2026-08-21T14:59:00.000Z', '2026-08-21T14:59:05.000Z');
INSERT OR REPLACE INTO technical_metrics
(symbol, anchor_week, completed_weeks_available, sum_199, anchor_close, closed_sma_200w, historical_data_as_of, calculated_at, status, source)
VALUES ('MSFT', '2026-08-14', 459, ${sum199}, 459, 359.5, '2026-08-14T20:00:00.000Z', '2026-08-15T06:00:00.000Z', 'ok', 'alpha-vantage');
INSERT OR REPLACE INTO stock_intrinsic_values
(symbol, method, low_value, base_value, high_value, as_of_date, updated_at)
VALUES ('MSFT', 'manual', NULL, 570.31, NULL, '2026-08-03', '2026-08-03T00:00:00.000Z');
DELETE FROM stock_support_levels WHERE symbol = 'MSFT';
INSERT INTO stock_support_levels (symbol, method, level, price, as_of_date, updated_at) VALUES
('MSFT', 'manual', 1, 450, '2026-08-03', '2026-08-03T00:00:00.000Z'),
('MSFT', 'manual', 2, 420, '2026-08-03', '2026-08-03T00:00:00.000Z');
INSERT INTO weekly_prices
(symbol, week_end_date, raw_open, raw_high, raw_low, raw_close, volume, split_adjustment_factor, split_adjusted_close, source, source_fetched_at)
VALUES
${weeklyRows()};
`;

  const temp = mkdtempSync(join(tmpdir(), "stock-detail-d1-"));
  const file = join(temp, "fixtures.sql");
  writeFileSync(file, sql);
  try {
    const result = spawnSync("npx", [...WRANGLER, "d1", "execute", DB, "--local", "--file", file], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: "pipe",
      timeout: 45_000,
    });
    if (result.status !== 0) {
      const reason = result.error ? `\n${result.error.message}` : "";
      throw new Error(`Failed to install local Stock Detail fixtures:${reason}\n${result.stdout}\n${result.stderr}`);
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

async function waitForWorker(child) {
  const deadline = Date.now() + 25_000;
  let lastError = "worker did not start";
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`wrangler dev exited early with ${child.exitCode}`);
    try {
      const response = await fetchWithTimeout(`${ORIGIN}/healthz`, 2_000);
      if (response.ok) return;
      lastError = `healthz returned ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(250);
  }
  throw new Error(lastError);
}

function signalWorkerGroup(child, signal) {
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ESRCH")) throw error;
      return;
    }
  }
  child.kill(signal);
}

async function stopWorker(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const waitForExit = async (timeoutMs) => {
    if (child.exitCode !== null || child.signalCode !== null) return true;
    let onExit;
    const exited = new Promise((resolve) => {
      onExit = () => resolve(true);
      child.once("exit", onExit);
    });
    const result = await Promise.race([exited, sleep(timeoutMs).then(() => false)]);
    if (!result && onExit) child.off("exit", onExit);
    return result;
  };
  signalWorkerGroup(child, "SIGTERM");
  if (!(await waitForExit(3_000))) {
    signalWorkerGroup(child, "SIGKILL");
    await waitForExit(2_000);
  }
  child.stdout?.destroy();
  child.stderr?.destroy();
}

async function main() {
  installFixtures();
  const child = spawn("npx", [...WRANGLER, "dev", "--local", "--port", String(PORT)], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, CI: "1" },
    detached: process.platform !== "win32",
  });
  let logs = "";
  child.stdout.on("data", (chunk) => { logs += String(chunk); });
  child.stderr.on("data", (chunk) => { logs += String(chunk); });

  try {
    await waitForWorker(child);

    const response = await fetchWithTimeout(`${ORIGIN}/api/stocks/MSFT/detail`);
    if (response.status !== 200) {
      const body = await response.text();
      throw new Error(`MSFT detail returned ${response.status}: ${body}`);
    }
    const detail = await response.json();
    assert(detail.schemaVersion === 1, "unexpected Stock Detail schemaVersion");
    assert(detail.symbol === "MSFT", "MSFT symbol was not preserved");
    assert(detail.company?.name === "Microsoft Corporation", "company metadata missing");
    assert(detail.company?.logoUrl === "https://example.com/msft.png", "company logo missing");
    assert(detail.quote?.price === 500, "real persisted quote not served");
    assert(detail.valuation?.intrinsicValue?.base === 570.31, "manual IV not served");
    assert(detail.technical?.supports?.length === 2, "manual supports not served");
    assert(detail.chart?.priceHistory?.length === 260, "visible chart history must be capped at 260 weeks");
    assert(detail.chart.priceHistory[0]?.close === 200, "199 warm-up rows were not trimmed from payload");
    assert(detail.chart.priceHistory.at(-1)?.close === 459, "latest completed weekly candle changed unexpectedly");
    assert(detail.technical?.sma200wHistory?.length === 260, "historical SMA should use warm-up and cover 5Y window");
    assert(Math.abs(detail.technical.sma200wHistory.at(-1).value - 359.5) < 1e-9, "historical SMA math is wrong");
    assert(detail.chart.intrinsicValueHistory?.length === 0, "historical IV must not be fabricated");
    assert(!detail.chart.priceHistory.some((point) => point.time === "2026-08-21"), "current week candle was fabricated");

    const adbeResponse = await fetchWithTimeout(`${ORIGIN}/api/stocks/ADBE/detail`);
    assert(adbeResponse.status === 200, `ADBE detail returned ${adbeResponse.status}`);
    const adbe = await adbeResponse.json();
    assert(adbe.fundamentals?.marketCap === "$109.4B", "ADBE market cap card was not served from D1");
    assert(adbe.fundamentals?.peTtm === 15.1379, "ADBE P/E card was not served from D1");
    assert(adbe.fundamentals?.roicPct === null, "ADBE ROIC must remain unavailable with missing debt");
    assert(Math.abs(adbe.fundamentals?.fcfMarginPct - 40.79688864195571) < 1e-9, "ADBE FCF margin card was not served from D1");
    assert(adbe.fundamentals?.debtToEquity === null, "ADBE debt/equity must remain unavailable with missing debt");

    const lowercase = await fetchWithTimeout(`${ORIGIN}/api/stocks/msft/detail`);
    assert(lowercase.status === 200, `lowercase ticker returned ${lowercase.status}`);
    assert((await lowercase.json()).symbol === "MSFT", "lowercase ticker was not normalized");

    const invalid = await fetchWithTimeout(`${ORIGIN}/api/stocks/INVALID/detail`);
    assert(invalid.status === 404, `invalid ticker returned ${invalid.status}`);
    assert((await invalid.json()).error === "stock_not_found", "invalid ticker error contract changed");

    console.log("Stock Detail local D1 integration: PASS");
  } catch (error) {
    if (logs) console.error(logs.slice(-8_000));
    throw error;
  } finally {
    await stopWorker(child);
  }
}

await main();
