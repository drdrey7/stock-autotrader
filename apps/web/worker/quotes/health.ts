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
 * the D1 HTTP API on every market-hours flush). It is the health of the ONLY
 * AUTOMATIC quote collector after the REST cron was removed.
 */
export const WS_INGESTOR_HEALTH_META_KEY = "quoteIngestorHealth";

/** Raw payload shape written by the ingestor (fields we map below). */
interface WsIngestorHealthRaw {
  connection_status?: unknown;
  last_flush_at?: unknown;
  last_successful_flush_at?: unknown;
  last_error?: unknown;
  last_flush_rows?: unknown;
}

function isoOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export async function readWsIngestorHealth(db: D1Database): Promise<QuotesHealthRecord | null> {
  try {
    const row = await db.prepare("SELECT value FROM app_meta WHERE key = ? LIMIT 1")
      .bind(WS_INGESTOR_HEALTH_META_KEY)
      .first<{ value: string | null }>();
    if (!row?.value) return null;
    const parsed = JSON.parse(row.value) as WsIngestorHealthRaw;
    if (!parsed || typeof parsed.connection_status !== "string") return null;
    return {
      provider: "finnhub-websocket",
      // The collector is healthy when its WebSocket is connected; anything
      // else (reconnecting/disconnected) degrades the label.
      status: parsed.connection_status === "connected" ? "ok" : "degraded",
      lastAttemptAt: isoOrNull(parsed.last_flush_at),
      lastSuccessAt: isoOrNull(parsed.last_successful_flush_at),
      lastError: typeof parsed.last_error === "string" ? parsed.last_error : null,
      rowsWritten: Number.isFinite(Number(parsed.last_flush_rows)) ? Number(parsed.last_flush_rows) : 0,
      lastShard: null,
      rateLimited: false,
    };
  } catch {
    return null;
  }
}

/**
 * Resolve the global quotes health record the API reports. The Finnhub
 * WebSocket ingestor is now the only automatic collector, so its record (when
 * it exists) IS the global provider; the REST shard record is only a fallback
 * (manual/diagnostic runs) used when no WebSocket record has ever been
 * written.
 */
export async function resolveQuotesHealth(db: D1Database): Promise<QuotesHealthRecord | null> {
  const ws = await readWsIngestorHealth(db);
  if (ws) return ws;
  return readQuotesHealth(db);
}
