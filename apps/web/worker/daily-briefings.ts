import {
  briefingEditionTypeSchema,
  publishedDailyBriefingSchema,
  type BriefingEditionType,
  type DailyBriefing,
} from "@stock-autotrader/contracts";

type BriefingRow = {
  edition_date: string;
  edition_type: string;
  timezone: string;
  prepared_at: string;
  published_at: string;
  content_hash: string;
  event_id: string;
  payload_json: string;
};

type ExistingEventRow = { event_id: string };

export type BriefingFreshness = "fresh" | "stale" | "unavailable";

export interface BriefingStatus {
  available: boolean;
  freshness: BriefingFreshness;
  editionDate: string | null;
  editionType: BriefingEditionType | null;
  preparedAt: string | null;
  publishedAt: string | null;
  ageSeconds: number | null;
}

export type PublishBriefingResult =
  | { kind: "applied"; contentHash: string }
  | { kind: "skipped"; contentHash: string }
  | { kind: "rejected"; reason: string; contentHash: string };

const MAX_FRESH_AGE_MS = 26 * 60 * 60 * 1000;
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export async function briefingContentHash(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalJson(value)),
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function briefingFreshness(
  publishedAt: string | null,
  nowMs = Date.now(),
): BriefingFreshness {
  if (!publishedAt) return "unavailable";
  const publishedMs = Date.parse(publishedAt);
  if (!Number.isFinite(publishedMs)) return "unavailable";
  const ageMs = nowMs - publishedMs;
  if (ageMs < -FUTURE_TOLERANCE_MS || ageMs > MAX_FRESH_AGE_MS) return "stale";
  return "fresh";
}

async function parseStoredRow(row: BriefingRow): Promise<DailyBriefing> {
  let parsedPayload: unknown;
  try {
    parsedPayload = JSON.parse(row.payload_json);
  } catch {
    throw new Error("stored briefing payload is not valid JSON");
  }
  const briefing = publishedDailyBriefingSchema.parse(parsedPayload);
  if (
    briefing.editionDate !== row.edition_date ||
    briefing.editionType !== row.edition_type ||
    briefing.timezone !== row.timezone ||
    briefing.preparedAt !== row.prepared_at
  ) {
    throw new Error("stored briefing metadata does not match its payload");
  }
  if (await briefingContentHash(briefing) !== row.content_hash) {
    throw new Error("stored briefing content hash does not match its payload");
  }
  return briefing;
}

async function findByEdition(
  db: D1Database,
  editionDate: string,
  editionType: BriefingEditionType,
): Promise<BriefingRow | null> {
  return db
    .prepare(
      "SELECT edition_date, edition_type, timezone, prepared_at, published_at, content_hash, event_id, payload_json FROM daily_briefings WHERE edition_date = ? AND edition_type = ? LIMIT 1",
    )
    .bind(editionDate, editionType)
    .first<BriefingRow>();
}

async function findEvent(db: D1Database, eventId: string): Promise<ExistingEventRow | null> {
  return db
    .prepare("SELECT event_id FROM ingest_events WHERE event_id = ? LIMIT 1")
    .bind(eventId)
    .first<ExistingEventRow>();
}

async function logDuplicate(
  db: D1Database,
  eventId: string,
  eventType: string,
  contentHash: string,
): Promise<void> {
  await db.batch([
    db
      .prepare("INSERT OR IGNORE INTO ingest_events (event_id, event_type, received_at, status) VALUES (?, ?, ?, 'duplicate_briefing')")
      .bind(eventId, eventType, new Date().toISOString()),
    db
      .prepare("INSERT INTO ingest_log (event_id, event_type, status, detail, created_at) VALUES (?, ?, 'skipped_duplicate', ?, ?)")
      .bind(eventId, eventType, `content_hash=${contentHash}`, new Date().toISOString()),
  ]);
}

export async function publishDailyBriefing(
  db: D1Database,
  eventId: string,
  eventTimestamp: string,
  briefing: DailyBriefing,
  publishedAt: string,
): Promise<PublishBriefingResult> {
  const parsed = publishedDailyBriefingSchema.parse(briefing);
  const contentHash = await briefingContentHash(parsed);
  const existingEdition = await findByEdition(db, parsed.editionDate, parsed.editionType);

  if (existingEdition) {
    if (existingEdition.content_hash !== contentHash) {
      return {
        kind: "rejected",
        reason: "edition already published with a different content hash",
        contentHash,
      };
    }
    await logDuplicate(db, eventId, "DAILY_BRIEFING_PUBLISHED", contentHash);
    return { kind: "skipped", contentHash };
  }

  if (await findEvent(db, eventId)) {
    return { kind: "skipped", contentHash };
  }

  try {
    await db.batch([
      db
        .prepare(
          "INSERT INTO daily_briefings (edition_date, edition_type, timezone, prepared_at, published_at, content_hash, event_id, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(
          parsed.editionDate,
          parsed.editionType,
          parsed.timezone,
          parsed.preparedAt,
          publishedAt,
          contentHash,
          eventId,
          canonicalJson(parsed),
        ),
      db
        .prepare("INSERT INTO ingest_events (event_id, event_type, received_at, status) VALUES (?, 'DAILY_BRIEFING_PUBLISHED', ?, 'applied')")
        .bind(eventId, publishedAt),
      db
        .prepare("INSERT INTO ingest_log (event_id, event_type, status, detail, created_at) VALUES (?, 'DAILY_BRIEFING_PUBLISHED', 'applied', ?, ?)")
        .bind(eventId, `event_timestamp=${eventTimestamp};content_hash=${contentHash}`, publishedAt),
    ]);
    return { kind: "applied", contentHash };
  } catch (error) {
    const racedEdition = await findByEdition(db, parsed.editionDate, parsed.editionType);
    if (racedEdition) {
      if (racedEdition.content_hash === contentHash) {
        await logDuplicate(db, eventId, "DAILY_BRIEFING_PUBLISHED", contentHash);
        return { kind: "skipped", contentHash };
      }
      return {
        kind: "rejected",
        reason: "edition already published with a different content hash",
        contentHash,
      };
    }
    throw error;
  }
}

export async function readLatestBriefing(
  db: D1Database,
  editionType?: BriefingEditionType,
): Promise<DailyBriefing | null> {
  const row = editionType
    ? await db
        .prepare(
          "SELECT edition_date, edition_type, timezone, prepared_at, published_at, content_hash, event_id, payload_json FROM daily_briefings WHERE edition_type = ? ORDER BY published_at DESC, id DESC LIMIT 1",
        )
        .bind(editionType)
        .first<BriefingRow>()
    : await db
        .prepare(
          "SELECT edition_date, edition_type, timezone, prepared_at, published_at, content_hash, event_id, payload_json FROM daily_briefings ORDER BY published_at DESC, id DESC LIMIT 1",
        )
        .first<BriefingRow>();

  return row ? parseStoredRow(row) : null;
}

export async function readBriefingByDateAndType(
  db: D1Database,
  editionDate: string,
  editionType: BriefingEditionType,
): Promise<DailyBriefing | null> {
  const row = await findByEdition(db, editionDate, editionType);
  return row ? parseStoredRow(row) : null;
}

export async function readBriefingStatus(db: D1Database, nowMs = Date.now()): Promise<BriefingStatus> {
  const row = await db
    .prepare(
      "SELECT edition_date, edition_type, timezone, prepared_at, published_at, content_hash, event_id, payload_json FROM daily_briefings ORDER BY published_at DESC, id DESC LIMIT 1",
    )
    .first<BriefingRow>();

  if (!row) {
    return {
      available: false,
      freshness: "unavailable",
      editionDate: null,
      editionType: null,
      preparedAt: null,
      publishedAt: null,
      ageSeconds: null,
    };
  }

  try {
    await parseStoredRow(row);
  } catch {
    return {
      available: false,
      freshness: "unavailable",
      editionDate: null,
      editionType: null,
      preparedAt: null,
      publishedAt: null,
      ageSeconds: null,
    };
  }

  const editionType = briefingEditionTypeSchema.safeParse(row.edition_type);
  const publishedMs = Date.parse(row.published_at);
  const ageSeconds = Number.isFinite(publishedMs) && publishedMs <= nowMs
    ? Math.floor((nowMs - publishedMs) / 1000)
    : null;

  return {
    available: true,
    freshness: briefingFreshness(row.published_at, nowMs),
    editionDate: row.edition_date,
    editionType: editionType.success ? editionType.data : null,
    preparedAt: row.prepared_at,
    publishedAt: row.published_at,
    ageSeconds,
  };
}
