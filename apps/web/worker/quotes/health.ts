/**
 * Screener quote job health record. Persisted in app_meta (key `quotesHealth`)
 * so the API and a future /status expansion can show collector freshness and
 * "50/50 healthy" without a second parallel read model.
 */
export const QUOTES_HEALTH_META_KEY = "quotesHealth";

export interface QuotesHealthRecord {
  provider: string;
  status: "running" | "ok" | "degraded" | "skipped";
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  rowsWritten: number;
  lastShard: number | null;
  rateLimited: boolean;
}

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

export async function readQuotesHealth(db: D1Database): Promise<QuotesHealthRecord | null> {
  try {
    const row = await db.prepare("SELECT value FROM app_meta WHERE key = ? LIMIT 1")
      .bind(QUOTES_HEALTH_META_KEY)
      .first<{ value: string | null }>();
    if (!row?.value) return null;
    const parsed = JSON.parse(row.value) as Partial<QuotesHealthRecord>;
    if (!parsed || typeof parsed.provider !== "string") return null;
    const status = String(parsed.status ?? "");
    return {
      provider: parsed.provider,
      status: ["running", "ok", "degraded", "skipped"].includes(status)
        ? status as QuotesHealthRecord["status"]
        : "degraded",
      lastAttemptAt: typeof parsed.lastAttemptAt === "string" ? parsed.lastAttemptAt : new Date(0).toISOString(),
      lastSuccessAt: typeof parsed.lastSuccessAt === "string" ? parsed.lastSuccessAt : null,
      lastError: typeof parsed.lastError === "string" ? parsed.lastError : null,
      rowsWritten: Number.isFinite(Number(parsed.rowsWritten)) ? Number(parsed.rowsWritten) : 0,
      lastShard: Number.isInteger(Number(parsed.lastShard)) ? Number(parsed.lastShard) : null,
      rateLimited: parsed.rateLimited === true,
    };
  } catch {
    return null;
  }
}

export async function writeQuotesHealth(db: D1Database, health: QuotesHealthRecord): Promise<void> {
  await db.prepare(
    "INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).bind(QUOTES_HEALTH_META_KEY, JSON.stringify(health)).run();
}

export async function rememberQuotesHealth(db: D1Database, health: QuotesHealthRecord): Promise<void> {
  try {
    await writeQuotesHealth(db, health);
  } catch (error) {
    console.error(JSON.stringify({ job: "quotes-shard", phase: "health-write", status: "failed", error: errorMessage(error).slice(0, 180) }));
  }
}

/**
 * Finnhub WebSocket ingestor health (apps/quote-ingestor writes this key via
 * the D1 HTTP API). It is the health of the ONLY AUTOMATIC quote collector
 * after the REST cron was removed — see README in apps/quote-ingestor.
 *
 * The ingestor persists a heartbeat (~1/minute, all day) so the Worker gets a
 * process-alive signal that is NEVER derived from quote timestamps (a quiet
 * symbol with no trades must not look like a dead collector).
 */
export const WS_INGESTOR_HEALTH_META_KEY = "quoteIngestorHealth";

export interface WsIngestorHealthData {
  provider: "finnhub-websocket";
  connectionStatus: string | null;
  connectedAt: string | null;
  lastWsHeartbeatAt: string | null;
  updatedAt: string | null;
  lastMessageAt: string | null;
  lastFlushAt: string | null;
  lastSuccessfulFlushAt: string | null;
  lastError: string | null;
  lastFlushRows: number;
  subscriptionsExpected: number;
  symbolsSeenRecently: number;
  reconnectCount: number;
}

export type WSCollectorState = "Healthy" | "Degraded" | "Disconnected" | "Unavailable";

/**
 * Heartbeat TTL windows for the WebSocket collector. Deployed process-alive
 * signal → Worker-side liveness, even if the ingestor died without writing a
 * "disconnected" record (the heartbeat simply stops).
 */
export const WS_HEARTBEAT_HEALTHY_SECONDS = 120; // <= 2 min: healthy/current
export const WS_HEARTBEAT_DEGRADED_SECONDS = 300; // > 2 min and <= 5 min: degraded

const isoOrNull = (value: unknown): string | null => (typeof value === "string" ? value : null);
const numOrZero = (value: unknown): number => (Number.isFinite(Number(value)) ? Number(value) : 0);

export async function readWsIngestorHealth(db: D1Database): Promise<WsIngestorHealthData | null> {
  try {
    const row = await db.prepare("SELECT value FROM app_meta WHERE key = ? LIMIT 1")
      .bind(WS_INGESTOR_HEALTH_META_KEY)
      .first<{ value: string | null }>();
    if (!row?.value) return null;
    const parsed = JSON.parse(row.value) as Record<string, unknown>;
    if (!parsed || typeof parsed.provider !== "string" || parsed.provider !== "finnhub-websocket") return null;
    return {
      provider: "finnhub-websocket",
      connectionStatus: typeof parsed.connection_status === "string" ? parsed.connection_status : null,
      connectedAt: isoOrNull(parsed.connected_at),
      lastWsHeartbeatAt: isoOrNull(parsed.last_ws_heartbeat_at),
      updatedAt: isoOrNull(parsed.updated_at),
      lastMessageAt: isoOrNull(parsed.last_message_at),
      lastFlushAt: isoOrNull(parsed.last_flush_at),
      lastSuccessfulFlushAt: isoOrNull(parsed.last_successful_flush_at),
      lastError: typeof parsed.last_error === "string" ? parsed.last_error : null,
      lastFlushRows: numOrZero(parsed.last_flush_rows),
      subscriptionsExpected: numOrZero(parsed.subscriptions_expected),
      symbolsSeenRecently: numOrZero(parsed.symbols_seen_recently),
      reconnectCount: numOrZero(parsed.reconnect_count),
    };
  } catch {
    return null;
  }
}

const parseDate = (value: string | null): number => {
  const ms = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(ms) ? ms : Number.NaN;
};

/**
 * Collector liveness from the ingestor HEALTH HEARTBEAT only — never from
 * quote rows (a symbol with zero trades for 20 minutes is normal and must not
 * demote the collector).
 *
 * TTL semantics (P2 #2B):
 *  - heartbeat <= 2 min old -> Healthy (a fresh "reconnecting"/"disconnected"
 *    state degrades to Degraded — the collector is momentarily not streaming);
 *  - 2..5 min old -> Degraded;
 *  - > 5 min old (or no heartbeat at all) -> Disconnected (assume dead).
 */
export function collectorStateFromWsHealth(ws: WsIngestorHealthData | null, now: Date): WSCollectorState {
  if (!ws) return "Unavailable";
  const heartbeatMs = parseDate(ws.lastWsHeartbeatAt) || parseDate(ws.updatedAt);
  if (!Number.isFinite(heartbeatMs)) return "Disconnected";
  const ageSeconds = (now.getTime() - heartbeatMs) / 1000;
  if (ageSeconds <= WS_HEARTBEAT_HEALTHY_SECONDS) {
    return ws.connectionStatus === "connected" ? "Healthy" : "Degraded";
  }
  if (ageSeconds <= WS_HEARTBEAT_DEGRADED_SECONDS) return "Degraded";
  return "Disconnected";
}

/**
 * Resolve the global quotes health record — the Finnhub WebSocket ingestor is
 * the only automatic collector, so its record (when it exists) IS the global
 * provider; the REST shard record is only a fallback (manual/diagnostic runs)
 * used when no WebSocket record has ever been written.
 */
export async function resolveQuotesHealth(db: D1Database, now = new Date()): Promise<QuotesHealthRecord | null> {
  const ws = await readWsIngestorHealth(db);
  if (ws) {
    const state = collectorStateFromWsHealth(ws, now);
    return {
      provider: "finnhub-websocket",
      status: state === "Healthy" ? "ok" : state === "Disconnected" ? "skipped" : "degraded",
      lastAttemptAt: ws.lastFlushAt,
      lastSuccessAt: ws.lastSuccessfulFlushAt,
      lastError: ws.lastError,
      rowsWritten: ws.lastFlushRows,
      lastShard: null,
      rateLimited: false,
    };
  }
  return readQuotesHealth(db);
}
