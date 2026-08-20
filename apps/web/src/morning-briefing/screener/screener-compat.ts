import type { ScreenerApiResponse, ScreenerRow, Sma200wState, ScreenerSupportLevel } from "@stock-autotrader/contracts";

/**
 * Compatibility boundary for the Screener frontend against OLD production API
 * payloads.
 *
 * The Cloudflare PR preview proxies `/api/*` to the PRODUCTION worker, so the
 * branch frontend legitimately receives pre-PR2/Support `/api/screener` shapes,
 * whose rows OMIT the new SMA fields (sma200w, distanceToSma200wPct,
 * sma200wState, sma200wHistoryWeeks, sma200wAsOf) and/or the new supportLevels
 * field. Without normalization those read as `undefined`, and any `.toFixed()`
 * on them crashes the page.
 *
 * Rule: missing SMA fields are treated EXACTLY like unavailable data —
 *   sma200w           -> null
 *   distanceToSma200wPct -> null
 *   sma200wState      -> "Unavailable"
 *   sma200wHistoryWeeks  -> null
 *   sma200wAsOf       -> null
 *   supportLevels     -> []
 * so an old payload renders normally with honest "—" placeholders and zero JS
 * errors. This is deliberately defensive: new payloads pass through unchanged.
 */

const SMA_STATES = new Set<Sma200wState>(["Above", "Near", "Below", "NotEnoughHistory", "Unavailable"]);
const SUPPORT_LEVELS = new Set<number>([1, 2, 3, 4]);

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stateOrUnavailable(value: unknown): Sma200wState {
  return typeof value === "string" && SMA_STATES.has(value as Sma200wState)
    ? (value as Sma200wState)
    : "Unavailable";
}

/** Validate one raw support level; returns null when malformed. */
function normalizeSupportLevel(raw: unknown): ScreenerSupportLevel | null {
  if (typeof raw !== "object" || raw === null) return null;
  const c = raw as Record<string, unknown>;
  const level = c.level;
  const price = c.price;
  if (typeof level !== "number" || !SUPPORT_LEVELS.has(level)) return null;
  if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) return null;
  const method = typeof c.method === "string" && c.method.trim().length > 0 ? c.method : null;
  const asOf = typeof c.asOf === "string" && /^\d{4}-\d{2}-\d{2}$/.test(c.asOf) ? c.asOf : null;
  if (!method || !asOf) return null;
  const triggered = typeof c.triggered === "boolean" ? c.triggered : c.triggered === null ? null : null;
  return { level: level as ScreenerSupportLevel["level"], price, method, asOf, triggered };
}

/** Normalize one raw row, filling any missing SMA/support field with its unavailable default. */
export function normalizeScreenerRow(raw: Record<string, unknown>): ScreenerRow {
  // Spread first, then the SMA + support fields override explicitly — missing inputs
  // (undefined) become the safe defaults instead of propagating as undefined.
  const supportRaw = Array.isArray(raw.supportLevels) ? raw.supportLevels : [];
  const supportLevels: ScreenerSupportLevel[] = [];
  for (const item of supportRaw) {
    const parsed = normalizeSupportLevel(item);
    if (parsed) {
      // de-duplicate by level, keep first valid
      if (!supportLevels.some((s) => s.level === parsed.level)) supportLevels.push(parsed);
    }
  }
  return {
    ...(raw as unknown as ScreenerRow),
    sma200w: finiteOrNull(raw.sma200w),
    distanceToSma200wPct: finiteOrNull(raw.distanceToSma200wPct),
    sma200wState: stateOrUnavailable(raw.sma200wState),
    sma200wHistoryWeeks: typeof raw.sma200wHistoryWeeks === "number" && Number.isInteger(raw.sma200wHistoryWeeks)
      ? raw.sma200wHistoryWeeks
      : null,
    sma200wAsOf: typeof raw.sma200wAsOf === "string" ? raw.sma200wAsOf : null,
    supportLevels: supportLevels
      .sort((a, b) => a.level - b.level)
      .slice(0, 4),
  };
}

/**
 * Normalize a whole /api/screener payload. Returns null when the payload does
 * not even carry a Screener-shaped body (rows array + marketState): the caller
 * treats that as an unavailable-data error state — never a crash.
 */
export function normalizeScreenerResponse(raw: unknown): ScreenerApiResponse | null {
  if (typeof raw !== "object" || raw === null) return null;
  const candidate = raw as Record<string, unknown>;
  if (!Array.isArray(candidate.rows) || typeof candidate.marketState !== "string") return null;
  const rows = candidate.rows.map((item) =>
    normalizeScreenerRow(typeof item === "object" && item !== null ? item as Record<string, unknown> : {}),
  ) as ScreenerRow[];
  return { ...(candidate as unknown as Omit<ScreenerApiResponse, "rows">), rows };
}
