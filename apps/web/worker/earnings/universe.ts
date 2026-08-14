const normalizeSymbol = (symbol: string): string => symbol.trim().toUpperCase().replace(/\./g, "-");
import {
  CORE_UNIVERSE,
  CORE_UNIVERSE_SYMBOLS,
  CORE_UNIVERSE_VERSION,
  isCoreUniverseSymbol,
} from "@stock-autotrader/contracts";

// Keep the provider/normalization adapter local so Finnhub and SEC provider
// behavior remains unchanged while the source of membership moves to Core.
export const EARNINGS_UNIVERSE_VERSION = CORE_UNIVERSE_VERSION;
export const EARNINGS_UNIVERSE_SYMBOLS = CORE_UNIVERSE_SYMBOLS;
export { CORE_UNIVERSE, CORE_UNIVERSE_SYMBOLS, CORE_UNIVERSE_VERSION, isCoreUniverseSymbol };

export function isInEarningsUniverse(symbol: string): boolean {
  return isCoreUniverseSymbol(normalizeSymbol(symbol));
}

export { normalizeSymbol };
