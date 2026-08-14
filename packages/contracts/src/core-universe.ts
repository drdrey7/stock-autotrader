import rawCoreUniverse from "./core-universe.v1.json";

export interface CoreUniverseConfig {
  readonly version: number;
  readonly symbols: readonly string[];
}

const CORE_UNIVERSE_V1_SIZE = 50;
const SYMBOL_PATTERN = /^[A-Z][A-Z0-9-]{0,11}$/;
const compareSymbols = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate the checked-in configuration at module initialization.
 * Configuration errors are programmer/deployment errors and must fail loudly;
 * this function intentionally does not normalize malformed symbols.
 */
export function validateCoreUniverseConfig(value: unknown): CoreUniverseConfig {
  if (!isRecord(value)) throw new Error("Core Universe config must be a JSON object");
  const keys = Object.keys(value).sort();
  if (keys.join(",") !== "symbols,version") {
    throw new Error("Core Universe config must contain only version and symbols");
  }
  if (!Number.isInteger(value.version) || Number(value.version) < 1) {
    throw new Error("Core Universe version must be a positive integer");
  }
  if (!Array.isArray(value.symbols)) throw new Error("Core Universe symbols must be an array");
  if (value.version === 1 && value.symbols.length !== CORE_UNIVERSE_V1_SIZE) {
    throw new Error(`Core Universe v1 must contain exactly ${CORE_UNIVERSE_V1_SIZE} symbols`);
  }

  const symbols = value.symbols.map((symbol, index) => {
    if (typeof symbol !== "string") throw new Error(`Core Universe symbol at index ${index} must be a string`);
    if (symbol !== symbol.trim() || !SYMBOL_PATTERN.test(symbol)) {
      throw new Error(`Core Universe symbol at index ${index} is not a normalized ticker: ${JSON.stringify(symbol)}`);
    }
    return symbol;
  });
  const uniqueSymbols = new Set(symbols);
  if (uniqueSymbols.size !== symbols.length) throw new Error("Core Universe symbols must be unique");
  const sortedSymbols = [...symbols].sort(compareSymbols);
  if (symbols.some((symbol, index) => symbol !== sortedSymbols[index])) {
    throw new Error("Core Universe symbols must use deterministic lexicographic ordering");
  }

  return { version: Number(value.version), symbols: Object.freeze(symbols) };
}

const config = validateCoreUniverseConfig(rawCoreUniverse as unknown);

export const CORE_UNIVERSE_VERSION = config.version;
export const CORE_UNIVERSE: readonly string[] = config.symbols;
export const CORE_UNIVERSE_SYMBOLS: ReadonlySet<string> = new Set(CORE_UNIVERSE);

/** Membership checks intentionally require a canonical uppercase symbol. */
export function isCoreUniverseSymbol(symbol: string): boolean {
  return CORE_UNIVERSE_SYMBOLS.has(symbol);
}
