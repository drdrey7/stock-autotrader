import type { EarningsEngineEvent } from "@stock-autotrader/contracts";
import {
  readEarningsMeta,
  readEarningsMonitoringEvents as readEarningsMonitoringEventsBase,
  setEarningsMeta,
  type Database,
} from "./storage-core";

export * from "./storage-core";

export const SEC_FILING_ROTATION_CURSOR_KEY = "earningsSecFilingRotationCursor";

const monitoringRotationKey = (event: Pick<EarningsEngineEvent, "symbol" | "id">): string =>
  `${event.symbol}\u0000${event.id}`;

/**
 * Rotate the deterministic monitoring order so a bounded SEC lookup budget
 * cannot repeatedly favour the same prefix. The cursor is a stable composite
 * key rather than an array index, so insertions/removals do not reset progress.
 */
export function rotateEarningsMonitoringEvents(
  events: EarningsEngineEvent[],
  cursor: string | null,
): EarningsEngineEvent[] {
  if (events.length <= 1 || !cursor) return events;

  const nextIndex = events.findIndex((event) => monitoringRotationKey(event) > cursor);
  const start = nextIndex >= 0 ? nextIndex : 0;
  if (start === 0) return events;
  return [...events.slice(start), ...events.slice(0, start)];
}

/**
 * Read today's monitoring candidates in a fair rotating order.
 *
 * The underlying query remains deterministic (symbol/id). Each successful read
 * advances the persistent cursor by one candidate. The monitor's existing SEC
 * lookup cap therefore sees a different prefix on successive runs without
 * increasing provider calls or changing retry/subrequest budgets.
 *
 * Cursor persistence is deliberately best-effort: rotation is an enrichment
 * fairness optimization and a transient app_meta write failure must never fail
 * the critical earnings monitor invocation.
 */
export async function readEarningsMonitoringEvents(
  db: Database,
  today: string,
): Promise<EarningsEngineEvent[]> {
  const events = await readEarningsMonitoringEventsBase(db, today);
  if (events.length === 0) return events;

  const cursor = await readEarningsMeta(db, SEC_FILING_ROTATION_CURSOR_KEY).catch(() => null);
  const rotated = rotateEarningsMonitoringEvents(events, cursor);
  const first = rotated[0];
  if (first) {
    await setEarningsMeta(db, SEC_FILING_ROTATION_CURSOR_KEY, monitoringRotationKey(first)).catch(() => undefined);
  }
  return rotated;
}
