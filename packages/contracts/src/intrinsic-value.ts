export type ValuationFamily =
  | "mega-cap-quality"
  | "semiconductors"
  | "quality-software"
  | "growth-software"
  | "hypergrowth-revenue"
  | "software-growth"
  | "payments-quality"
  | "healthcare"
  | "consumer-quality"
  | "bank"
  | "capital-markets"
  | "growth-financial"
  | "financial-platform"
  | "general";

export const automaticValuationMethods = ["P/E", "P/FCF", "P/S", "P/B"] as const;
export type AutomaticValuationMethod = (typeof automaticValuationMethods)[number];
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
  /** Human-readable method composition, ordered by effective model weight. */
  method: string;
  methods: AutomaticValuationMethod[];
  confidence: AutomaticValuationConfidence;
  bear: number;
  /** Product contract: arithmetic midpoint of the displayed Bear/Bull scenarios. */
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
  "quality-software": { "P/FCF": 0.45, "P/S": 0.35, "P/E": 0.20 },
  "growth-software": { "P/FCF": 0.40, "P/S": 0.40, "P/E": 0.20 },
  "hypergrowth-revenue": { "P/S": 0.60, "P/FCF": 0.25, "P/E": 0.15 },
  "payments-quality": { "P/E": 0.50, "P/FCF": 0.35, "P/S": 0.15 },
  "capital-markets": { "P/E": 0.55, "P/B": 0.25, "P/S": 0.20 },
  "financial-platform": { "P/E": 0.45, "P/FCF": 0.35, "P/S": 0.20 },
  healthcare: { "P/E": 0.50, "P/FCF": 0.35, "P/S": 0.15 },
  "consumer-quality": { "P/E": 0.45, "P/FCF": 0.35, "P/S": 0.20 },
  general: { "P/E": 0.40, "P/FCF": 0.35, "P/S": 0.25 },
});

/**
 * Explicit valuation profile for every Core Universe symbol (deterministic and
 * auditable, no scattered per-symbol branching). A symbol missing from this
 * registry falls back to industry-based classification for non-Core tickers
 * only; every Core symbol must be present here (enforced by a unit test).
 *
 * The taxonomy separates semiconductors, software (quality/growth/hypergrowth)
 * and finance (bank / capital-markets / growth-financial / financial-platform)
 * so economically distinct businesses are not lumped into a generic profile
 * (e.g. HOOD and COIN no longer fall into `general`). Semiconductor fabless and
 * wafer-manufacturing names share one `semiconductors` profile because their
 * method weights and behaviour are identical (a split would be false precision).
 * Method weights remain profile-driven and are NOT recalibrated to match any
 * external benchmark.
 */
export const CORE_VALUATION_PROFILES: Readonly<Record<string, ValuationFamily>> = Object.freeze({
  // mega-cap platform quality (steady, dominant)
  AAPL: "mega-cap-quality",
  AMZN: "mega-cap-quality",
  GOOGL: "mega-cap-quality",
  META: "mega-cap-quality",
  MSFT: "mega-cap-quality",
  NFLX: "mega-cap-quality",
  // DELL: large-cap hardware / IT-infrastructure systems vendor — not a
  // semiconductor. Earnings/FCF anchored with a low P/S weight suits a
  // thin-margin systems business, so it maps to mega-cap-quality.
  DELL: "mega-cap-quality",
  // semiconductors and semiconductor-equipment (fabless design / foundry / wafers / capex-heavy equipment)
  AMD: "semiconductors",
  ARM: "semiconductors",
  AVGO: "semiconductors",
  INTC: "semiconductors",
  MU: "semiconductors",
  NVDA: "semiconductors",
  QCOM: "semiconductors",
  SNDK: "semiconductors",
  AMAT: "semiconductors",
  ASML: "semiconductors",
  KLAC: "semiconductors",
  LRCX: "semiconductors",
  TSM: "semiconductors",
  // durable / profitable software
  ADBE: "quality-software",
  CRM: "quality-software",
  CRWD: "quality-software",
  NOW: "quality-software",
  ORCL: "quality-software",
  PANW: "quality-software",
  SHOP: "quality-software",
  // higher-growth software
  DDOG: "growth-software",
  NET: "growth-software",
  PLTR: "growth-software",
  SNOW: "growth-software",
  // revenue-anchored hypergrowth (often loss-making)
  CRWV: "hypergrowth-revenue",
  NBIS: "hypergrowth-revenue",
  // payments / transaction processing
  MA: "payments-quality",
  V: "payments-quality",
  // banks vs capital markets (economically distinct)
  JPM: "bank",
  GS: "capital-markets",
  // balance-sheet consumer finance
  SOFI: "growth-financial",
  // technology-driven financial platforms
  AFRM: "financial-platform",
  COIN: "financial-platform",
  CRCL: "financial-platform",
  HOOD: "financial-platform",
  // healthcare
  LLY: "healthcare",
  NVO: "healthcare",
  UNH: "healthcare",
  // consumer / retail / discretionary
  COST: "consumer-quality",
  RDDT: "consumer-quality",
  TSLA: "consumer-quality",
  UBER: "consumer-quality",
  WMT: "consumer-quality",
});

const IS_SEMICONDUCTOR_FAMILY = new Set<ValuationFamily>(["semiconductors"]);

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

/**
 * Canonical profile resolution for Automatic IV. Explicit Core Universe mapping
 * always wins; anything not in the 50 uses industry/legacy classification.
 * Every Core symbol is present in CORE_VALUATION_PROFILES (enforced by a test),
 * so no Core symbol can ever drift into `general` or the regex fallback.
 */
export function resolveValuationProfile(symbol: string, industry: string | null): ValuationFamily {
  const normalizedSymbol = symbol.trim().toUpperCase();
  const explicit = CORE_VALUATION_PROFILES[normalizedSymbol];
  if (explicit) return explicit;
  return classifyValuationFamily(symbol, industry);
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
  // Negative D/E normally means negative equity. It is not evidence of safer
  // leverage, so treat it as unavailable rather than rewarding the multiple.
  if (!finite(input.debtToEquity) || input.debtToEquity < 0) return 0;
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

function sampleReliability(samples: number): number {
  if (samples >= 12) return 1;
  if (samples >= 8) return 0.90;
  if (samples >= 4) return 0.70;
  if (samples >= 2) return 0.45;
  return 0.25;
}

function dispersionReliability(history: NormalizedHistory): number {
  const spread = history.p75 / history.p25;
  if (spread <= 2) return 1;
  if (spread <= 4) return 0.90;
  if (spread <= 8) return 0.75;
  return 0.60;
}

/** Sparse or extremely dispersed histories remain usable, but cannot dominate a dense anchor. */
function historyReliability(history: NormalizedHistory): number {
  return sampleReliability(history.samples) * dispersionReliability(history);
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
  return clamp(position, 0.22, IS_SEMICONDUCTOR_FAMILY.has(family) ? 0.68 : 0.78);
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

  let rawBear = Math.max(history.p25, history.median / lowerDivisor);
  let rawBull = Math.min(history.p75, history.median * upperMultiplier);
  if (rawBear > history.median) rawBear = history.median;
  if (rawBull < history.median) rawBull = history.median;

  // Growth/quality/leverage pick a bounded central target inside the historical
  // distribution. Move the entire historical scenario band around that target
  // so the product-level Base contract can remain the arithmetic midpoint.
  const target = position <= 0.5
    ? logInterpolate(rawBear, history.median, position / 0.5)
    : logInterpolate(history.median, rawBull, (position - 0.5) / 0.5);
  const rawMidpoint = (rawBear + rawBull) / 2;
  const bandScale = target / rawMidpoint;
  let bear = rawBear * bandScale;
  let bull = rawBull * bandScale;

  // Sparse histories should not masquerade as precise. Widen symmetrically
  // around the target so sparse observations increase uncertainty, not bias.
  const minimumHalfWidth = history.samples < 4
    ? target * 0.30
    : history.samples < 8
      ? target * 0.20
      : 0;
  const currentHalfWidth = (bull - bear) / 2;
  const halfWidth = Math.min(Math.max(currentHalfWidth, minimumHalfWidth), target * 0.75);
  bear = target - halfWidth;
  bull = target + halfWidth;

  return { bear, base: target, bull };
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
  const baseWeight = METHOD_WEIGHTS[family][method] ?? 0;
  const history = normalizeHistory(historyInput);
  if (baseWeight <= 0 || !positiveFinite(perShare) || !history) return null;
  const reliability = historyReliability(history);
  const weight = baseWeight * reliability;
  if (weight <= 0) return null;
  const position = targetPosition(family, method, growth, quality, leverage, roe);
  const multiples = scenarioMultiples(history, method, position, growth, roe);
  const bear = perShare * multiples.bear;
  const base = perShare * multiples.base;
  const bull = perShare * multiples.bull;
  if (![bear, base, bull].every(Number.isFinite) || bear <= 0 || base < bear || bull < base) return null;
  return { method, weight, samples: history.samples, bear, base, bull };
}

function weightedGeometricMean(candidates: readonly Candidate[], field: "bear" | "bull"): number {
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
  if (meaningful.length >= 2 && effectiveSamples >= 10 && meaningful.every((candidate) => candidate.samples >= 6)) {
    return "High";
  }
  if (effectiveSamples >= 6) return "Medium";
  return "Low";
}

/**
 * Automatic IV V2: deterministic relative valuation from last-known-good D1
 * fundamentals. The company's own trailing 5-year multiple distribution is the
 * anchor; current growth/quality/leverage shifts a bounded scenario band while
 * history quality determines each method's effective blend weight. Current
 * market price never enters the fair-value equation.
 */
export function calculateAutomaticIntrinsicValue(
  symbol: string,
  industry: string | null,
  input: AutomaticIntrinsicValueInput,
): AutomaticIntrinsicValue | null {
  const family = resolveValuationProfile(symbol, industry);
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
  const bull = roundMoney(weightedGeometricMean(ordered, "bull"));
  const base = roundMoney((bear + bull) / 2);
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