export type ValuationFamily =
  | "mega-cap-quality"
  | "semiconductors"
  | "software-growth"
  | "payments-quality"
  | "healthcare"
  | "consumer-quality"
  | "bank"
  | "general";

export type AutomaticValuationMethod = "P/E" | "P/B" | "P/FCF";

export interface AutomaticIntrinsicValueInput {
  /** Current quote. Used for upside/downside and legacy compatibility only. */
  price: number | null;
  /** Persisted trailing P/E. Kept only for rolling-preview compatibility and bank legacy fallback. */
  peTtm: number | null;
  /** Persisted trailing EPS. Canonical P/E valuation anchor in production. */
  epsTtm?: number | null;
  /** Persisted trailing free cash flow per share. Canonical fallback when EPS is not usable. */
  fcfPerShareTtm?: number | null;
  /** Persisted current P/B. Legacy/rolling-preview bank fallback only. */
  priceToBook?: number | null;
  /** Shareholders' equity / shares outstanding. Canonical P/B valuation anchor in production. */
  bookValuePerShare?: number | null;
}

export interface AutomaticIntrinsicValue {
  family: ValuationFamily;
  method: AutomaticValuationMethod;
  bear: number;
  base: number;
  bull: number;
  bearMultiple: number;
  baseMultiple: number;
  bullMultiple: number;
  bearUpsidePct: number | null;
  baseUpsidePct: number | null;
  bullUpsidePct: number | null;
}

interface MultipleRange {
  bear: number;
  bull: number;
}

/**
 * Scenario assumptions live in one auditable table. Base is never an
 * independent assumption: it is the arithmetic midpoint of Bear and Bull.
 */
export const PE_MULTIPLES: Readonly<Partial<Record<ValuationFamily, MultipleRange>>> = Object.freeze({
  "mega-cap-quality": { bear: 28, bull: 34 },
  semiconductors: { bear: 27, bull: 35 },
  "software-growth": { bear: 30, bull: 38 },
  "payments-quality": { bear: 28, bull: 34 },
  healthcare: { bear: 22, bull: 27 },
  "consumer-quality": { bear: 24, bull: 30 },
  general: { bear: 22, bull: 28 },
});

/**
 * Conservative P/FCF fallback assumptions for businesses where GAAP EPS is
 * non-positive or unusable but trailing free cash flow per share is positive.
 * This is deliberately a fallback behind P/E, not a second value to average.
 */
export const PFCF_MULTIPLES: Readonly<Partial<Record<ValuationFamily, MultipleRange>>> = Object.freeze({
  "mega-cap-quality": { bear: 24, bull: 32 },
  semiconductors: { bear: 22, bull: 30 },
  "software-growth": { bear: 24, bull: 34 },
  "payments-quality": { bear: 24, bull: 32 },
  healthcare: { bear: 18, bull: 24 },
  "consumer-quality": { bear: 18, bull: 26 },
  general: { bear: 18, bull: 26 },
});

const BANK_BALANCE_SHEET_SYMBOLS = new Set(["GS", "JPM", "SOFI"]);
const MEGA_CAP_QUALITY_SYMBOLS = new Set(["AAPL", "GOOGL", "META", "MSFT"]);
const PAYMENT_QUALITY_SYMBOLS = new Set(["MA", "V"]);

const BANK_RE = /\bbanks?\b|banking|savings\s*&\s*loans|mortgage finance/i;
const SEMICONDUCTOR_RE = /semiconductor|chip|electronic equipment|semiconductor equipment/i;
const SOFTWARE_RE = /software|cloud|cybersecurity|internet content|internet services|application software/i;
const PAYMENT_RE = /payment|transaction processing/i;
const HEALTHCARE_RE = /pharma|biotech|health|medical|drug/i;
const CONSUMER_RE = /retail|consumer|restaurant|entertainment|media|automotive|travel|commerce/i;

export function classifyValuationFamily(symbol: string, industry: string | null): ValuationFamily {
  const normalizedSymbol = symbol.trim().toUpperCase();
  if (BANK_BALANCE_SHEET_SYMBOLS.has(normalizedSymbol)) return "bank";
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

function positiveFinite(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function roundMultiple(value: number): number {
  return Math.round(value * 100) / 100;
}

function roundPct(value: number): number {
  return Math.round(value * 10) / 10;
}

function upsidePct(value: number, price: number | null): number | null {
  if (!positiveFinite(price)) return null;
  return roundPct((value / price - 1) * 100);
}

function buildResult(
  family: ValuationFamily,
  method: AutomaticValuationMethod,
  price: number | null,
  bearValue: number,
  bullValue: number,
  bearMultiple: number,
  bullMultiple: number,
): AutomaticIntrinsicValue | null {
  if (![bearValue, bullValue, bearMultiple, bullMultiple].every(Number.isFinite)) return null;
  if (bearValue <= 0 || bullValue < bearValue || bearMultiple <= 0 || bullMultiple < bearMultiple) return null;

  const bear = roundMoney(bearValue);
  const bull = roundMoney(bullValue);
  const base = roundMoney((bear + bull) / 2);
  const roundedBearMultiple = roundMultiple(bearMultiple);
  const roundedBullMultiple = roundMultiple(bullMultiple);
  const baseMultiple = roundMultiple((roundedBearMultiple + roundedBullMultiple) / 2);

  return {
    family,
    method,
    bear,
    base,
    bull,
    bearMultiple: roundedBearMultiple,
    baseMultiple,
    bullMultiple: roundedBullMultiple,
    bearUpsidePct: upsidePct(bear, price),
    baseUpsidePct: upsidePct(base, price),
    bullUpsidePct: upsidePct(bull, price),
  };
}

/**
 * Justified P/B relationship used for balance-sheet financials:
 *   P/B = (ROE - g) / (r - g)
 *
 * Production obtains ROE from stable per-share fundamentals:
 *   ROE ≈ EPS TTM / Book Value Per Share.
 */
function bankMultiplesFromRoe(roe: number): MultipleRange | null {
  if (!Number.isFinite(roe) || roe <= 0 || roe > 0.5) return null;
  const bear = clamp((roe - 0.02) / (0.12 - 0.02), 0.35, 3);
  const bull = clamp((roe - 0.035) / (0.09 - 0.035), 0.5, 4);
  if (bull < bear) return null;
  return { bear, bull };
}

function legacyBankMultiples(peTtm: number, priceToBook: number): MultipleRange | null {
  if (peTtm <= 0 || peTtm > 60 || priceToBook <= 0 || priceToBook > 10) return null;
  return bankMultiplesFromRoe(priceToBook / peTtm);
}

/**
 * Deterministic per-share automatic IV. No provider calls or persistence.
 *
 * Canonical production routing:
 *   Banks:          Book Value Per Share × justified Target P/B.
 *   Other stocks:   EPS TTM × Target P/E when EPS is positive.
 *                   Otherwise FCF/Share TTM × Target P/FCF when FCF is positive.
 *
 * A current quote is deliberately optional for canonical valuation. When it is
 * absent the IV remains available and only upside/downside is null. Pre-profit
 * companies with neither positive EPS nor positive FCF fail closed.
 */
export function calculateAutomaticIntrinsicValue(
  symbol: string,
  industry: string | null,
  input: AutomaticIntrinsicValueInput,
): AutomaticIntrinsicValue | null {
  const family = classifyValuationFamily(symbol, industry);

  if (family === "bank") {
    if (positiveFinite(input.epsTtm) && positiveFinite(input.bookValuePerShare)) {
      const multiples = bankMultiplesFromRoe(input.epsTtm / input.bookValuePerShare);
      if (!multiples) return null;
      return buildResult(
        family,
        "P/B",
        input.price,
        input.bookValuePerShare * multiples.bear,
        input.bookValuePerShare * multiples.bull,
        multiples.bear,
        multiples.bull,
      );
    }

    if (!positiveFinite(input.price) || !positiveFinite(input.peTtm) || !positiveFinite(input.priceToBook)) return null;
    const multiples = legacyBankMultiples(input.peTtm, input.priceToBook);
    if (!multiples) return null;
    return buildResult(
      family,
      "P/B",
      input.price,
      input.price * (multiples.bear / input.priceToBook),
      input.price * (multiples.bull / input.priceToBook),
      multiples.bear,
      multiples.bull,
    );
  }

  const peMultiples = PE_MULTIPLES[family];
  if (!peMultiples) return null;
  if (positiveFinite(input.epsTtm)) {
    return buildResult(
      family,
      "P/E",
      input.price,
      input.epsTtm * peMultiples.bear,
      input.epsTtm * peMultiples.bull,
      peMultiples.bear,
      peMultiples.bull,
    );
  }

  const pfcfMultiples = PFCF_MULTIPLES[family];
  if (pfcfMultiples && positiveFinite(input.fcfPerShareTtm)) {
    return buildResult(
      family,
      "P/FCF",
      input.price,
      input.fcfPerShareTtm * pfcfMultiples.bear,
      input.fcfPerShareTtm * pfcfMultiples.bull,
      pfcfMultiples.bear,
      pfcfMultiples.bull,
    );
  }

  // Rolling-preview compatibility for an older Stock Detail API contract.
  if (!positiveFinite(input.price) || !positiveFinite(input.peTtm) || input.peTtm < 3 || input.peTtm > 150) return null;
  return buildResult(
    family,
    "P/E",
    input.price,
    input.price * (peMultiples.bear / input.peTtm),
    input.price * (peMultiples.bull / input.peTtm),
    peMultiples.bear,
    peMultiples.bull,
  );
}

/** Screener convention: negative means the stock trades below IV. */
export function intrinsicValueDistancePct(price: number | null, intrinsicValue: number | null): number | null {
  if (!positiveFinite(price) || !positiveFinite(intrinsicValue)) return null;
  return (price / intrinsicValue - 1) * 100;
}
