/**
 * Runtime universe invariant.
 *
 * The current active universe is the active Core source in earnings_universe.
 * The predicate is centralized so a future Trending source can be added here
 * without changing every public stock-specific read path.
 */
export const ACTIVE_UNIVERSE_SOURCE = "core" as const;
export const ACTIVE_UNIVERSE_PREDICATE = "u.active = 1 AND u.source = 'core'" as const;

export function activeUniverseExistsSql(symbolExpression: string): string {
  return `EXISTS (SELECT 1 FROM earnings_universe AS u WHERE u.symbol = ${symbolExpression} AND ${ACTIVE_UNIVERSE_PREDICATE})`;
}
