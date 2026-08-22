import type { StockDetailApiResponse } from "@stock-autotrader/contracts";

/**
 * Branch-preview-only visual fixture.
 *
 * This module is imported exclusively by preview-worker.ts. It is never part
 * of the production Worker or Stock Detail runtime dependency graph. The real
 * endpoint continues to be validated against migrated local D1 in CI.
 */

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const END_WEEK_MS = Date.parse("2026-08-14T00:00:00.000Z");

const COMPANIES = {
  MSFT: "Microsoft Corporation",
  NVDA: "NVIDIA Corporation",
  CRCL: "Circle Internet Group, Inc.",
} as const;

type PreviewSymbol = keyof typeof COMPANIES;

function weeklyHistory(symbol: PreviewSymbol) {
  const count = symbol === "CRCL" ? 60 : 260;
  const base = symbol === "MSFT" ? 345 : symbol === "NVDA" ? 92 : 82;
  const slope = symbol === "MSFT" ? 0.58 : symbol === "NVDA" ? 0.34 : 0.8;

  return Array.from({ length: count }, (_, index) => {
    const time = new Date(END_WEEK_MS - (count - 1 - index) * WEEK_MS).toISOString().slice(0, 10);
    const trend = base + index * slope;
    const wave = Math.sin(index / 4.5) * (symbol === "MSFT" ? 8 : 5);
    const close = Math.max(5, trend + wave);
    const open = close * (1 + Math.sin(index / 3.1) * 0.012);
    const high = Math.max(open, close) * 1.018;
    const low = Math.min(open, close) * 0.982;
    return {
      time,
      open: Number(open.toFixed(2)),
      high: Number(high.toFixed(2)),
      low: Number(low.toFixed(2)),
      close: Number(close.toFixed(2)),
      volume: 1_000_000 + index * 7_500,
    };
  });
}

function smaHistory(history: ReturnType<typeof weeklyHistory>) {
  if (history.length < 200) return [];
  const result: Array<{ time: string; value: number }> = [];
  let sum = 0;
  for (let index = 0; index < history.length; index += 1) {
    sum += history[index]!.close;
    if (index >= 200) sum -= history[index - 200]!.close;
    if (index >= 199) {
      result.push({ time: history[index]!.time, value: Number((sum / 200).toFixed(4)) });
    }
  }
  return result;
}

export function previewStockDetailFixture(rawSymbol: string): StockDetailApiResponse | null {
  const symbol = rawSymbol.trim().toUpperCase();
  if (!(symbol in COMPANIES)) return null;
  const typedSymbol = symbol as PreviewSymbol;
  const history = weeklyHistory(typedSymbol);
  const sma200wHistory = smaHistory(history);

  const quotePrice = typedSymbol === "MSFT" ? 500 : typedSymbol === "NVDA" ? 180 : 130;
  const ivBase = typedSymbol === "MSFT" ? 570.31 : typedSymbol === "NVDA" ? 212.04 : null;
  const supports = typedSymbol === "MSFT"
    ? [
        { level: 1 as const, price: 450, method: "manual", asOf: "2026-08-03", triggered: false },
        { level: 2 as const, price: 420, method: "manual", asOf: "2026-08-03", triggered: false },
      ]
    : typedSymbol === "NVDA"
      ? [
          { level: 1 as const, price: 204.99, method: "manual", asOf: "2026-08-03", triggered: true },
          { level: 2 as const, price: 187.16, method: "manual", asOf: "2026-08-03", triggered: true },
          { level: 3 as const, price: 169.34, method: "manual", asOf: "2026-08-03", triggered: false },
          { level: 4 as const, price: 151.51, method: "manual", asOf: "2026-08-03", triggered: false },
        ]
      : [];
  const currentSma = sma200wHistory.at(-1)?.value ?? null;

  return {
    schemaVersion: 2,
    generatedAt: "2026-08-21T15:00:00.000Z",
    symbol: typedSymbol,
    company: {
      name: COMPANIES[typedSymbol],
      exchange: null,
      sector: null,
      logoUrl: null,
    },
    quote: {
      price: quotePrice,
      changeAbs: typedSymbol === "MSFT" ? 5.88 : 1.5,
      changePct: typedSymbol === "MSFT" ? 1.24 : 0.75,
      provider: "preview-fixture",
      asOf: "2026-08-21T14:59:00.000Z",
      updatedAt: "2026-08-21T14:59:05.000Z",
      state: "Live",
      marketState: "regular",
      scaleState: "safe",
    },
    valuation: {
      intrinsicValue: ivBase === null ? null : {
        low: typedSymbol === "MSFT" ? 520 : null,
        base: ivBase,
        high: typedSymbol === "MSFT" ? 625 : null,
        method: "manual",
        asOf: "2026-08-03",
        upsidePct: (ivBase / quotePrice - 1) * 100,
      },
    },
    fundamentals: {
      marketCap: null,
      peTtm: null,
      roicPct: null,
      fcfMarginPct: null,
      debtToEquity: null,
      coverageStatus: "none",
      asOf: null,
    },
    technical: {
      sma200w: currentSma,
      distanceToSma200wPct: currentSma === null ? null : (quotePrice / currentSma - 1) * 100,
      sma200wState: currentSma === null ? "NotEnoughHistory" : quotePrice < currentSma ? "Below" : "Above",
      sma200wHistoryWeeks: history.length,
      sma200wAsOf: currentSma === null ? null : "2026-08-14T20:00:00.000Z",
      supports,
      sma200wHistory,
    },
    chart: {
      interval: "1w",
      priceHistory: history,
      intrinsicValueHistory: [],
    },
    freshness: {
      quoteAsOf: "2026-08-21T14:59:00.000Z",
      historyAsOf: "2026-08-15T06:00:00.000Z",
      valuationAsOf: ivBase === null ? null : "2026-08-03",
      technicalAsOf: currentSma === null ? null : "2026-08-15T06:00:00.000Z",
      fundamentalsAsOf: null,
    },
  };
}
