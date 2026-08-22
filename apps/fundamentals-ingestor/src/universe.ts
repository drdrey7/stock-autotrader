/**
 * Core Universe access — the 50 symbols this ingestor covers.
 * Reuses the canonical contract, never re-derives the list.
 */
import { CORE_UNIVERSE } from "@stock-autotrader/contracts";

export const FUNDAMENTALS_UNIVERSE: readonly string[] = CORE_UNIVERSE;

export function isFundamentalsUniverseSymbol(symbol: string): boolean {
  return CORE_UNIVERSE.includes(symbol);
}