export type ValuationFamily =
  | "mega-cap-quality"
  | "semiconductors"
  | "software-growth"
  | "payments-quality"
  | "healthcare"
  | "consumer-quality"
  | "bank"
  | "general";

export type AutomaticValuationMethod = "P/E" | "P/B";

export interface AutomaticIntrinsicValueInput {
  price: number | null;
  peTtm: number | null;
  priceToBook?: number | null;
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
 * ROE is recovered from two already-available market ratios:
 *   ROE = (P/B) / (P/E)
 *
 * Bear uses a higher required return / lower growth assumption; Bull uses the
 * opposite. Guardrails keep edge cases from producing absurd multiples.
 */
function bankMultiples(peTtm: number, priceToBook: number): MultipleRange | null {
  if (peTtm <= 0 || peTtm > 60 || priceToBook <= 0 || priceToBook > 10) return null;
  const roe = priceToBook / peTtm;
  if (!Number.isFinite(roe) || roe <= 0 || roe > 0.5) return null;

  const bear = clamp((roe - 0.02) / (0.12 - 0.02), 0.35, 3);
  const bull = clamp((roe - 0.035) / (0.09 - 0.035), 0.5, 4);
  if (bull < bear) return null;
  return { bear, bull };
}

/**
 * Excel-style, presentation-time IV. No provider calls, persistence or timers.
 *
 * Non-financials: IV = Price × Target P/E ÷ Current P/E.
 * Banks:          IV = Price × Target P/B ÷ Current P/B, where target P/B is
 *                 linked to ROE through a justified-P/B relationship.
 */
export function calculateAutomaticIntrinsicValue(
  symbol: string,
  industry: string | null,
  input: AutomaticIntrinsicValueInput,
): AutomaticIntrinsicValue | null {
  if (!positiveFinite(input.price)) return null;
  const family = classifyValuationFamily(symbol, industry);

  if (family === "bank") {
    if (!positiveFinite(input.peTtm) || !positiveFinite(input.priceToBook)) return null;
    const multiples = bankMultiples(input.peTtm, input.priceToBook);
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

  if (!positiveFinite(input.peTtm) || input.peTtm < 3 || input.peTtm > 150) return null;
  const multiples = PE_MULTIPLES[family];
  if (!multiples) return null;
  return buildResult(
    family,
    "P/E",
    input.price,
    input.price * (multiples.bear / input.peTtm),
    input.price * (multiples.bull / input.peTtm),
    multiples.bear,
    multiples.bull,
  );
}

/** Screener convention: negative means the stock trades below IV. */
export function intrinsicValueDistancePct(price: number | null, intrinsicValue: number | null): number | null {
  if (!positiveFinite(price) || !positiveFinite(intrinsicValue)) return null;
  return (price / intrinsicValue - 1) * 100;
}
