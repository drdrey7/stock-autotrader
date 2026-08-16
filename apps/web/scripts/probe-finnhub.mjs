#!/usr/bin/env node
/**
 * Temporary Finnhub diagnostic probe — PR #50 historical-earnings audit.
 *
 * Exercises the exact server-side request path production uses (bulk
 * Earnings Calendar with X-Finnhub-Token) plus the targeted variants, for
 * MSFT and AAPL, and prints a compact summary. The API token is never
 * printed; only endpoint results are emitted.
 *
 * Run: FINNHUB_API_KEY=... node scripts/probe-finnhub.mjs
 */
const FINNHUB_BASE = "https://finnhub.io/api/v1";

const token = process.env.FINNHUB_API_KEY;
if (!token || token.trim().length < 8) {
  console.error("FINNHUB_API_KEY missing");
  process.exit(2);
}

// Canonical New York date, same convention as worker/earnings/logic.ts.
function newYorkDate(instant = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(instant);
  const value = (type) => parts.find((part) => part.type === type)?.value;
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function addDays(dateKey, days) {
  const date = new Date(`${dateKey}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function fetchJson(path, params) {
  const url = new URL(`${FINNHUB_BASE}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json", "X-Finnhub-Token": token },
      signal: controller.signal,
    });
    const body = await response.json().catch(() => null);
    return { status: response.status, body };
  } finally {
    clearTimeout(timeout);
  }
}

const compactRows = (rows) => (rows ?? []).slice(0, 12).map((row) => ({
  symbol: row.symbol,
  date: row.date ?? null,
  hour: row.hour ?? null,
  quarter: row.quarter ?? null,
  year: row.year ?? null,
  epsEstimate: row.epsEstimate ?? null,
  epsActual: row.epsActual ?? null,
  revenueEstimate: row.revenueEstimate ?? null,
  revenueActual: row.revenueActual ?? null,
}));

const compactEarnings = (payload) => (payload?.earnings ?? []).slice(0, 8).map((row) => ({
  period: row.period ?? null,
  epsEstimate: row.epsEstimate ?? null,
  epsActual: row.epsActual ?? null,
  epsSurprise: row.epsSurprise ?? null,
  epsSurprisePercent: row.epsSurprisePercent ?? null,
  actualRevenue: row.actualRevenue ?? null,
  estimateRevenue: row.estimateRevenue ?? null,
}));

const compactSurprises = (payload) => (payload?.data ?? []).slice(0, 8).map((row) => ({
  period: row.period ?? null,
  actual: row.actual ?? null,
  estimate: row.estimate ?? null,
  surprise: row.surprise ?? null,
  surprisePercent: row.surprisePercent ?? null,
}));

const today = newYorkDate();
const bulkFrom = addDays(today, -30);
const report = { today, bulkFrom };

const symbols = ["MSFT", "AAPL"];

for (const symbol of symbols) {
  const entry = { symbol };

  // 1. Bulk calendar window (exact production range for the backfill).
  const bulk = await fetchJson("/calendar/earnings", { from: bulkFrom, to: today });
  entry.bulkCalendar = {
    status: bulk.status,
    count: Array.isArray(bulk.body?.earningsCalendar) ? bulk.body.earningsCalendar.length : null,
    rows: compactRows(bulk.body?.earningsCalendar),
    error: bulk.body?.error ?? null,
  };

  // 2. Targeted calendar query for the same window (symbol filter).
  const targeted = await fetchJson("/calendar/earnings", { from: bulkFrom, to: today, symbol });
  entry.targetedCalendar = {
    status: targeted.status,
    count: Array.isArray(targeted.body?.earningsCalendar) ? targeted.body.earningsCalendar.length : null,
    rows: compactRows(targeted.body?.earningsCalendar),
    error: targeted.body?.error ?? null,
  };

  // 3. Historical per-symbol earnings (period + EPS + revenue when exposed).
  const history = await fetchJson("/stock/earnings", { symbol, limit: 4 });
  entry.stockEarnings = {
    status: history.status,
    count: Array.isArray(history.body?.earnings) ? history.body.earnings.length : null,
    rows: compactEarnings(history.body),
    error: history.body?.error ?? null,
  };

  // 4. Earnings surprises (actual vs estimate, no announcement date).
  const surprises = await fetchJson("/stock/earnings-surprises", { symbol, limit: 4 });
  entry.earningsSurprises = {
    status: surprises.status,
    count: Array.isArray(surprises.body?.data) ? surprises.body.data.length : null,
    rows: compactSurprises(surprises.body),
    error: surprises.body?.error ?? null,
  };

  report.symbols = [...(report.symbols ?? []), entry];
}

console.log(JSON.stringify(report, null, 2));