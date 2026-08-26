export type ValuationFamily =
  | "mega-cap-quality"
  | "semiconductors"
  | "software-growth"
  | "payments-quality"
  | "healthcare"
  | "consumer-quality"
  | "bank"
  | "growth-financial"
  | "general";

export type AutomaticValuationMethod = "P/E" | "P/FCF" | "P/S" | "P/B";
export type AutomaticValuationConfidence = "High" | "Medium" | "Low";

export interface MultipleHistoryInput {
  p25: number | null;
  median: number | null;
  p75: number | null;
  samples: number | null;
}

export interface AutomaticIntrinsicValueInput {
  /** Current quote. It only drives displayed upside/downside, never fair value. */
  price: number | null;
  epsTtm?: number | null;
  fcfPerShareTtm?: number | null;
  revenuePerShareTtm?: number | null;
  bookValuePerShare?: number | null;
  revenueGrowthTtmYoyPct?: number | null;
  revenueGrowth3yPct?: number | null;
  revenueGrowth5yPct?: number | null;
  roeTtmPct?: number | null;
  roicPct?: number | null;
  fcfMarginPct?: number | null;
  debtToEquity?: number | null;
  peHistory?: MultipleHistoryInput | null;
  pfcfHistory?: MultipleHistoryInput | null;
  psHistory?: MultipleHistoryInput | null;
  pbHistory?: MultipleHistoryInput | null;
}

export interface AutomaticIntrinsicValue {
  family: ValuationFamily;
  /** Human-readable method composition, ordered by model weight. */
  method: string;
  methods: AutomaticValuationMethod[];
  confidence: AutomaticValuationConfidence;
  bear: number;
  base: number;
  bull: number;
  bearUpsidePct: number | null;
  baseUpsidePct: number | null;
  bullUpsidePct: number | null;
}

interface NormalizedHistory {
  p25: number;
  median: number;
  p75: number;
  samples: number;
}

interface Candidate {
  method: AutomaticValuationMethod;
  weight: number;
  samples: number;
  bear: number;
  base: number;
  bull: number;
}

const BANK_SYMBOLS = new Set(["GS", "JPM"]);
const GROWTH_FINANCIAL_SYMBOLS = new Set(["SOFI"]);
const MEGA_CAP_QUALITY_SYMBOLS = new Set(["AAPL", "GOOGL", "META", "MSFT"]);
const PAYMENT_QUALITY_SYMBOLS = new Set(["MA", "V"]);

const BANK_RE = /\bbanks?\b|banking|savings\s*&\s*loans|mortgage finance/i;
const SEMICONDUCTOR_RE = /semiconductor|chip|electronic equipment|semiconductor equipment/i;
const SOFTWARE_RE = /software|cloud|cybersecurity|internet content|internet services|application software/i;
const PAYMENT_RE = /payment|transaction processing/i;
const HEALTHCARE_RE = /pharma|biotech|health|medical|drug/i;
const CONSUMER_RE = /retail|consumer|restaurant|entertainment|media|automotive|travel|commerce/i;

const METHOD_WEIGHTS: Readonly<Record<ValuationFamily, Readonly<Partial<Record<AutomaticValuationMethod, number>>>>> = Object.freeze({
  bank: { "P/B": 0.75, "P/E": 0.25 },
  "growth-financial": { "P/B": 0.55, "P/E": 0.30, "P/S": 0.15 },
  "mega-cap-quality": { "P/E": 0.45, "P/FCF": 0.45, "P/S": 0.10 },
  semiconductors: { "P/E": 0.45, "P/FCF": 0.40, "P/S": 0.15 },
  "software-growth": { "P/FCF": 0.45, "P/S": 0.35, "P/E": 0.20 },
  "payments-quality": { "P/E": 0.50, "P/FCF": 0.35, "P/S": 0.15 },
  healthcare: { "P/E": 0.50, "P/FCF": 0.35, "P/S": 0.15 },
  "consumer-quality": { "P/E": 0.45, "P/FCF": 0.35, "P/S": 0.20 },
  general: { "P/E": 0.40, "P/FCF": 0.35, "P/S": 0.25 },
});

export function classifyValuationFamily(symbol: string, industry: string | null): ValuationFamily {
  const normalizedSymbol = symbol.trim().toUpperCase();
  if (BANK_SYMBOLS.has(normalizedSymbol)) return "bank";
  if (GROWTH_FINANCIAL_SYMBOLS.has(normalizedSymbol)) return "growth-financial";
  if (MEGA_CAP_QUALITY_SYMBOLS.has(normalizedSymbol)) return "mega-cap-quality";
  if (PAYMENT_QUALITY_SYMBOLS.has(normalizedSymbol)) return "payments-quality";

  const value = industry?.trim() ?? "";
  if (BANK_RE.test(value)) return "bank";
  if (SEMICONDUCTOR_RE.test(value)) return "semiconductors";
  if (SOFTWARE_RE.test(value)) return "software-growth";
  if (PAYMENT_RE.test(value)) return "payments-quality";
  if (HEALTHCARE_RE.test(value)) return "healthcare";
  if (CONSUMER_RE.test(value)) return "consumer-quality";
  return "general";
}

function finite(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function positiveFinite(value: number | null | undefined): value is number {
  return finite(value) && value > 0;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function roundPct(value: number): number {
  return Math.round(value * 10) / 10;
}

function upsidePct(value: number, price: number | null): number | null {
  if (!positiveFinite(price)) return null;
  return roundPct((value / price - 1) * 100);
}

function normalizedSignal(value: number | null | undefined, center: number, scale: number): number {
  if (!finite(value) || scale <= 0) return 0;
  return clamp((value - center) / scale, -1, 1);
}

function reasonablePercent(value: number | null | undefined): number | null {
  if (!finite(value) || value < -100 || value > 100) return null;
  return value;
}

function average(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * Slow-moving, bounded growth signal. The model rewards durable growth and
 * modest acceleration, but no growth observation can move the signal outside
 * [-1, 1]. Growth-financials deliberately down-weight volatile TTM revenue.
 */
function growthSignal(input: AutomaticIntrinsicValueInput, family: ValuationFamily): number {
  const growth3y = finite(input.revenueGrowth3yPct) ? input.revenueGrowth3yPct : null;
  const growth5y = finite(input.revenueGrowth5yPct) ? input.revenueGrowth5yPct : null;
  const ttm = finite(input.revenueGrowthTtmYoyPct) ? input.revenueGrowthTtmYoyPct : null;
  const longValues = [growth3y, growth5y].filter((value): value is number => value !== null);
  if (longValues.length === 0) return normalizedSignal(ttm, 10, 30);

  const longGrowth = average(longValues);
  const level = normalizedSignal(longGrowth, 10, 30);
  const momentum = ttm === null ? 0 : normalizedSignal(ttm - longGrowth, 0, family === "growth-financial" ? 80 : 50);
  const longWeight = family === "growth-financial" ? 0.80 : 0.65;
  return clamp(longWeight * level + (1 - longWeight) * momentum, -1, 1);
}

function qualitySignal(input: AutomaticIntrinsicValueInput): number {
  const roic = reasonablePercent(input.roicPct);
  const margin = reasonablePercent(input.fcfMarginPct);
  const signals: number[] = [];
  if (roic !== null) signals.push(normalizedSignal(roic, 10, 20));
  if (margin !== null) signals.push(normalizedSignal(margin, 10, 20));
  return average(signals);
}

function leverageSignal(input: AutomaticIntrinsicValueInput): number {
  return normalizedSignal(input.debtToEquity, 1, 2);
}

function roeSignal(input: AutomaticIntrinsicValueInput): number {
  const roe = reasonablePercent(input.roeTtmPct);
  return normalizedSignal(roe, 12, 12);
}

function normalizeHistory(input: MultipleHistoryInput | null | undefined): NormalizedHistory | null {
  if (!input) return null;
  if (!positiveFinite(input.p25) || !positiveFinite(input.median) || !positiveFinite(input.p75)) return null;
  if (typeof input.samples !== "number" || !Number.isFinite(input.samples) || !Number.isInteger(input.samples) || input.samples <= 0) return null;
  if (input.p25 > input.median || input.median > input.p75) return null;
  return { p25: input.p25, median: input.median, p75: input.p75, samples: input.samples };
}

function logInterpolate(left: number, right: number, fraction: number): number {
  const bounded = clamp(fraction, 0, 1);
  return Math.exp(Math.log(left) + (Math.log(right) - Math.log(left)) * bounded);
}

function targetPosition(
  family: ValuationFamily,
  method: AutomaticValuationMethod,
  growth: number,
  quality: number,
  leverage: number,
  roe: number,
): number {
  if (method === "P/B") {
    if (family === "bank") return clamp(0.5 + 0.20 * roe, 0.25, 0.75);
    return clamp(0.5 + 0.10 * growth + 0.16 * roe, 0.20, 0.80);
  }
  if (method === "P/S") {
    return clamp(0.5 + 0.28 * growth + 0.08 * quality - 0.05 * leverage, 0.20, 0.82);
  }
  if (family === "bank") return clamp(0.5 + 0.12 * roe, 0.30, 0.70);
  if (family === "growth-financial") {
    return clamp(0.5 + 0.08 * growth + 0.10 * roe, 0.25, 0.75);
  }
  const position = 0.5 + 0.12 * growth + 0.08 * quality - 0.06 * leverage;
  return clamp(position, 0.22, family === "semiconductors" ? 0.68 : 0.78);
}

function scenarioMultiples(
  history: NormalizedHistory,
  method: AutomaticValuationMethod,
  position: number,
  growth: number,
  roe: number,
): { bear: number; base: number; bull: number } {
  const lowerDivisor = method === "P/B" ? 1.6 : 1.8;
  const positiveGrowth = Math.max(0, growth);
  const positiveRoe = Math.max(0, roe);
  const upperMultiplier = method === "P/S"
    ? 2.5 + 1.5 * positiveGrowth
    : method === "P/B"
      ? 1.7 + 0.3 * positiveRoe
      : 1.8 + 0.4 * positiveGrowth;

  let bear = Math.max(history.p25, history.median / lowerDivisor);
  let bull = Math.min(history.p75, history.median * upperMultiplier);
  if (bear > history.median) bear = history.median;
  if (bull < history.median) bull = history.median;

  const base = position <= 0.5
    ? logInterpolate(bear, history.median, position / 0.5)
    : logInterpolate(history.median, bull, (position - 0.5) / 0.5);

  // Sparse histories should not masquerade as precise ranges. Keep the central
  // estimate, but widen Bear/Bull around it until more observations accumulate.
  if (history.samples < 4) {
    bear = Math.min(bear, base * 0.75);
    bull = Math.max(bull, base * 1.35);
  } else if (history.samples < 8) {
    bear = Math.min(bear, base * 0.82);
    bull = Math.max(bull, base * 1.25);
  }

  return { bear, base, bull };
}

function buildCandidate(
  family: ValuationFamily,
  method: AutomaticValuationMethod,
  perShare: number | null | undefined,
  historyInput: MultipleHistoryInput | null | undefined,
  growth: number,
  quality: number,
  leverage: number,
  roe: number,
): Candidate | null {
  const weight = METHOD_WEIGHTS[family][method] ?? 0;
  const history = normalizeHistory(historyInput);
  if (weight <= 0 || !positiveFinite(perShare) || !history) return null;
  const position = targetPosition(family, method, growth, quality, leverage, roe);
  const multiples = scenarioMultiples(history, method, position, growth, roe);
  const bear = perShare * multiples.bear;
  const base = perShare * multiples.base;
  const bull = perShare * multiples.bull;
  if (![bear, base, bull].every(Number.isFinite) || bear <= 0 || base < bear || bull < base) return null;
  return { method, weight, samples: history.samples, bear, base, bull };
}

function weightedGeometricMean(candidates: readonly Candidate[], field: "bear" | "base" | "bull"): number {
  const totalWeight = candidates.reduce((sum, candidate) => sum + candidate.weight, 0);
  const weightedLog = candidates.reduce(
    (sum, candidate) => sum + candidate.weight * Math.log(candidate[field]),
    0,
  );
  return Math.exp(weightedLog / totalWeight);
}

function confidenceOf(candidates: readonly Candidate[]): AutomaticValuationConfidence {
  const totalWeight = candidates.reduce((sum, candidate) => sum + candidate.weight, 0);
  const effectiveSamples = candidates.reduce(
    (sum, candidate) => sum + candidate.weight * candidate.samples,
    0,
  ) / totalWeight;
  const meaningful = candidates.filter((candidate) => candidate.weight / totalWeight >= 0.15);
  if (candidates.length >= 2 && effectiveSamples >= 10 && meaningful.every((candidate) => candidate.samples >= 6)) {
    return "High";
  }
  if (effectiveSamples >= 6) return "Medium";
  return "Low";
}

/**
 * Automatic IV V2: deterministic relative valuation from last-known-good D1
 * fundamentals. The company's own trailing 5-year multiple distribution is the
 * anchor; current growth/quality/leverage can only move the Base within bounded
 * historical bands. Current market price never enters the fair-value equation.
 */
export function calculateAutomaticIntrinsicValue(
  symbol: string,
  industry: string | null,
  input: AutomaticIntrinsicValueInput,
): AutomaticIntrinsicValue | null {
  const family = classifyValuationFamily(symbol, industry);
  const growth = growthSignal(input, family);
  const quality = qualitySignal(input);
  const leverage = leverageSignal(input);
  const roe = roeSignal(input);

  const candidates = [
    buildCandidate(family, "P/E", input.epsTtm, input.peHistory, growth, quality, leverage, roe),
    buildCandidate(family, "P/FCF", input.fcfPerShareTtm, input.pfcfHistory, growth, quality, leverage, roe),
    buildCandidate(family, "P/S", input.revenuePerShareTtm, input.psHistory, growth, quality, leverage, roe),
    buildCandidate(family, "P/B", input.bookValuePerShare, input.pbHistory, growth, quality, leverage, roe),
  ].filter((candidate): candidate is Candidate => candidate !== null);

  if (candidates.length === 0) return null;
  const ordered = [...candidates].sort((left, right) => right.weight - left.weight);
  const bear = roundMoney(weightedGeometricMean(ordered, "bear"));
  const base = roundMoney(weightedGeometricMean(ordered, "base"));
  const bull = roundMoney(weightedGeometricMean(ordered, "bull"));
  if (bear <= 0 || base < bear || bull < base) return null;

  return {
    family,
    method: ordered.map((candidate) => candidate.method).join(" + "),
    methods: ordered.map((candidate) => candidate.method),
    confidence: confidenceOf(ordered),
    bear,
    base,
    bull,
    bearUpsidePct: upsidePct(bear, input.price),
    baseUpsidePct: upsidePct(base, input.price),
    bullUpsidePct: upsidePct(bull, input.price),
  };
}

/** Screener convention: negative means the stock trades below IV. */
export function intrinsicValueDistancePct(price: number | null, intrinsicValue: number | null): number | null {
  if (!positiveFinite(price) || !positiveFinite(intrinsicValue)) return null;
  return (price / intrinsicValue - 1) * 100;
}
