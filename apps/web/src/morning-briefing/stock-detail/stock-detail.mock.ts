import { isCoreUniverseSymbol } from "@stock-autotrader/contracts";
import type {
  StockDetail,
  StockDetailDataSource,
  StockLinePoint,
  StockPricePoint,
  StockSupportLevel,
} from "./stock-detail.types";

const MOCK_AS_OF = "2026-08-21T20:00:00.000Z";
const MOCK_WEEK_COUNT = 260;
const SMA_WINDOW_WEEKS = 200;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const MOCK_END_UTC = Date.UTC(2026, 7, 21);

const COMPANY_NAMES: Readonly<Record<string, string>> = Object.freeze({
  AAPL: "Apple Inc.",
  ADBE: "Adobe Inc.",
  AFRM: "Affirm Holdings, Inc.",
  AMAT: "Applied Materials, Inc.",
  AMD: "Advanced Micro Devices, Inc.",
  AMZN: "Amazon.com, Inc.",
  ARM: "Arm Holdings plc",
  ASML: "ASML Holding N.V.",
  AVGO: "Broadcom Inc.",
  COIN: "Coinbase Global, Inc.",
  COST: "Costco Wholesale Corporation",
  CRCL: "Circle Internet Group, Inc.",
  CRM: "Salesforce, Inc.",
  CRWD: "CrowdStrike Holdings, Inc.",
  CRWV: "CoreWeave, Inc.",
  DDOG: "Datadog, Inc.",
  DELL: "Dell Technologies Inc.",
  GOOGL: "Alphabet Inc.",
  GS: "The Goldman Sachs Group, Inc.",
  HOOD: "Robinhood Markets, Inc.",
  INTC: "Intel Corporation",
  JPM: "JPMorgan Chase & Co.",
  KLAC: "KLA Corporation",
  LLY: "Eli Lilly and Company",
  LRCX: "Lam Research Corporation",
  MA: "Mastercard Incorporated",
  META: "Meta Platforms, Inc.",
  MSFT: "Microsoft Corporation",
  MU: "Micron Technology, Inc.",
  NBIS: "Nebius Group N.V.",
  NET: "Cloudflare, Inc.",
  NFLX: "Netflix, Inc.",
  NOW: "ServiceNow, Inc.",
  NVDA: "NVIDIA Corporation",
  NVO: "Novo Nordisk A/S",
  ORCL: "Oracle Corporation",
  PANW: "Palo Alto Networks, Inc.",
  PLTR: "Palantir Technologies Inc.",
  QCOM: "QUALCOMM Incorporated",
  RDDT: "Reddit, Inc.",
  SHOP: "Shopify Inc.",
  SNDK: "Sandisk Corporation",
  SNOW: "Snowflake Inc.",
  SOFI: "SoFi Technologies, Inc.",
  TSLA: "Tesla, Inc.",
  TSM: "Taiwan Semiconductor Manufacturing Company Limited",
  UBER: "Uber Technologies, Inc.",
  UNH: "UnitedHealth Group Incorporated",
  V: "Visa Inc.",
  WMT: "Walmart Inc.",
});

const NASDAQ_SYMBOLS = new Set([
  "AAPL", "ADBE", "AFRM", "AMAT", "AMD", "AMZN", "ARM", "ASML", "AVGO", "COIN",
  "COST", "CRWD", "CRWV", "DDOG", "GOOGL", "HOOD", "INTC", "KLAC", "LRCX", "META",
  "MSFT", "MU", "NBIS", "NFLX", "NVDA", "PANW", "PLTR", "QCOM", "SHOP", "SNDK", "SOFI",
  "TSLA", "WMT",
]);

interface VisualFixture {
  targetPrice: number;
  change: number;
  changePct: number;
  intrinsicValue: number;
  bear: number;
  bull: number;
  dcf: number;
  multiples: number;
  manual: number;
  supports: readonly [number, number, number, number];
  marketCap: string;
  peTtm: number;
  roicPct: number;
  fcfMarginPct: number;
  debtToEquity: number;
}

/** Matches the supplied design reference only; it is deliberately not production market data. */
const MSFT_VISUAL_FIXTURE: VisualFixture = {
  targetPrice: 481.2,
  change: 5.88,
  changePct: 1.24,
  intrinsicValue: 529.2,
  bear: 419,
  bull: 650,
  dcf: 518.4,
  multiples: 540.8,
  manual: 570,
  supports: [450, 420, 390, 350],
  marketCap: "$3.58T",
  peTtm: 32.1,
  roicPct: 28.4,
  fcfMarginPct: 34.2,
  debtToEquity: 0.35,
};

function hashSymbol(symbol: string): number {
  let hash = 2166136261;
  for (let index = 0; index < symbol.length; index += 1) {
    hash ^= symbol.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededRandom(seed: number): () => number {
  let state = seed || 0x6d2b79f5;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function isoWeek(index: number): string {
  const weeksBeforeEnd = MOCK_WEEK_COUNT - 1 - index;
  return new Date(MOCK_END_UTC - weeksBeforeEnd * WEEK_MS).toISOString().slice(0, 10);
}

function buildPriceHistory(symbol: string, targetPrice?: number): StockPricePoint[] {
  const random = seededRandom(hashSymbol(symbol));
  const initialPrice = 28 + (hashSymbol(symbol) % 185);
  let previousClose = initialPrice;
  const history: StockPricePoint[] = [];

  for (let index = 0; index < MOCK_WEEK_COUNT; index += 1) {
    const open = Math.max(3, previousClose * (1 + (random() - 0.5) * 0.025));
    const weeklyReturn = 0.0022 + (random() - 0.48) * 0.075;
    const close = Math.max(3, open * (1 + weeklyReturn));
    const wick = 0.006 + random() * 0.025;
    const high = Math.max(open, close) * (1 + wick);
    const low = Math.max(1, Math.min(open, close) * (1 - wick * (0.7 + random() * 0.5)));
    history.push({
      time: isoWeek(index),
      open: round(open),
      high: round(high),
      low: round(low),
      close: round(close),
    });
    previousClose = close;
  }

  if (!targetPrice) return history;
  const lastClose = history.at(-1)?.close ?? targetPrice;
  const scale = targetPrice / lastClose;
  return history.map((point) => ({
    ...point,
    open: point.open === undefined ? undefined : round(point.open * scale),
    high: point.high === undefined ? undefined : round(point.high * scale),
    low: point.low === undefined ? undefined : round(point.low * scale),
    close: round(point.close * scale),
  }));
}

function buildSma200w(history: StockPricePoint[]): StockLinePoint[] {
  if (history.length < SMA_WINDOW_WEEKS) return [];
  const values: StockLinePoint[] = [];
  let rollingSum = 0;
  for (let index = 0; index < history.length; index += 1) {
    rollingSum += history[index]!.close;
    if (index >= SMA_WINDOW_WEEKS) rollingSum -= history[index - SMA_WINDOW_WEEKS]!.close;
    if (index >= SMA_WINDOW_WEEKS - 1) {
      values.push({ time: history[index]!.time, value: round(rollingSum / SMA_WINDOW_WEEKS) });
    }
  }
  return values;
}

function makeSupports(price: number, fixture?: VisualFixture): StockSupportLevel[] {
  const values = fixture?.supports ?? [price * 0.92, price * 0.84, price * 0.76, price * 0.68];
  return values.map((supportPrice, index) => ({
    level: (index + 1) as 1 | 2 | 3 | 4,
    price: round(supportPrice),
  }));
}

function buildIntrinsicValueHistory(base: number, history: StockPricePoint[]): StockLinePoint[] {
  const points: StockLinePoint[] = [];
  // Quarterly-style mock snapshots intentionally stop before the current point:
  // current IV is rendered separately as a horizontal price line.
  for (let index = 0; index < history.length; index += 13) {
    const progress = index / Math.max(1, history.length - 1);
    const value = base * (0.82 + progress * 0.18);
    points.push({ time: history[index]!.time, value: round(value) });
  }
  return points;
}

function compactMarketCap(seed: number): string {
  const billions = 18 + (seed % 860);
  return billions >= 1000 ? `$${round(billions / 1000, 2)}T` : `$${billions}B`;
}

export function createMockStockDetail(rawSymbol: string): StockDetail | null {
  const symbol = rawSymbol.trim().toUpperCase();
  if (!isCoreUniverseSymbol(symbol)) return null;

  const seed = hashSymbol(symbol);
  const fixture = symbol === "MSFT" ? MSFT_VISUAL_FIXTURE : undefined;
  const history = buildPriceHistory(symbol, fixture?.targetPrice);
  const last = history.at(-1)!;
  const previous = history.at(-2)!;
  const change = fixture?.change ?? round(last.close - previous.close);
  const changePct = fixture?.changePct ?? round((last.close / previous.close - 1) * 100);
  const random = seededRandom(seed ^ 0x9e3779b9);
  const intrinsicValue = fixture?.intrinsicValue ?? round(last.close * (0.88 + random() * 0.34));
  const dcf = fixture?.dcf ?? round(intrinsicValue * (0.94 + random() * 0.08));
  const multiples = fixture?.multiples ?? round(intrinsicValue * (0.94 + random() * 0.1));
  const manual = fixture?.manual ?? round(intrinsicValue * (0.96 + random() * 0.12));
  const bear = fixture?.bear ?? round(intrinsicValue * 0.8);
  const bull = fixture?.bull ?? round(intrinsicValue * 1.22);
  const sma200wHistory = buildSma200w(history);
  const sma200w = sma200wHistory.at(-1)?.value ?? null;

  return {
    source: "mock",
    symbol,
    companyName: COMPANY_NAMES[symbol] ?? symbol,
    exchange: NASDAQ_SYMBOLS.has(symbol) ? "NASDAQ" : "NYSE",
    sector: symbol === "MSFT" ? "Software" : null,
    logoUrl: null,
    quote: {
      price: last.close,
      change,
      changePct,
      state: "Cached",
      scaleState: "safe",
      marketState: "closed",
      asOf: MOCK_AS_OF,
    },
    valuation: {
      intrinsicValue,
      upsidePct: round((intrinsicValue / last.close - 1) * 100),
      scenarios: { bear, base: intrinsicValue, bull },
      methods: {
        dcf,
        multiples,
        manual,
        selected: intrinsicValue,
        selectedMethod: "Blend",
      },
    },
    technical: {
      sma200w,
      smaDistancePct: sma200w === null ? null : round((last.close / sma200w - 1) * 100, 1),
      sma200wHistory,
      supports: makeSupports(last.close, fixture),
    },
    metrics: {
      marketCap: fixture?.marketCap ?? compactMarketCap(seed),
      peTtm: fixture?.peTtm ?? round(14 + random() * 34, 1),
      roicPct: fixture?.roicPct ?? round(6 + random() * 28, 1),
      fcfMarginPct: fixture?.fcfMarginPct ?? round(7 + random() * 31, 1),
      debtToEquity: fixture?.debtToEquity ?? round(0.08 + random() * 1.2, 2),
    },
    chart: {
      priceHistory: history,
      intrinsicValueHistory: buildIntrinsicValueHistory(intrinsicValue, history),
    },
  };
}

export const mockStockDetailDataSource: StockDetailDataSource = {
  async getStockDetail(symbol: string): Promise<StockDetail | null> {
    return createMockStockDetail(symbol);
  },
};
