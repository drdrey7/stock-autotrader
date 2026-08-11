import { describe, expect, it } from "vitest";
import { exampleDailyBriefing } from "../src/daily-briefing-example";
import worker, { type Env } from "./index";
import { handleIngest } from "./ingest";
import {
  briefingContentHash,
  briefingFreshness,
  canonicalJson,
  publishDailyBriefing,
  readBriefingByDateAndType,
  readBriefingStatus,
  readLatestBriefing,
} from "./daily-briefings";

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

class FakeStatement {
  private args: unknown[] = [];

  constructor(private readonly db: FakeD1, private readonly sql: string) {}

  bind(...args: unknown[]): this {
    this.args = args;
    return this;
  }

  async first<T>(): Promise<T | null> {
    if (this.sql.includes("FROM ingest_events")) {
      const eventId = String(this.args[0]);
      return this.db.events.has(eventId) ? ({ event_id: eventId } as T) : null;
    }
    if (this.sql.includes("FROM daily_briefings WHERE edition_date")) {
      return this.db.briefings.get(`${this.args[0]}:${this.args[1]}`) as T | null;
    }

    const requestedEdition = this.sql.includes("WHERE edition_type = ?") ? String(this.args[0]) : null;
    const rows = [...this.db.briefings.values()]
      .filter((row) => requestedEdition === null || row.edition_type === requestedEdition)
      .sort((left, right) => right.published_at.localeCompare(left.published_at));
    return (rows[0] as T | undefined) ?? null;
  }

  async run(): Promise<{ meta: { changes: number } }> {
    if (this.sql.includes("INSERT INTO daily_briefings")) {
      const row: BriefingRow = {
        edition_date: String(this.args[0]),
        edition_type: String(this.args[1]),
        timezone: String(this.args[2]),
        prepared_at: String(this.args[3]),
        published_at: String(this.args[4]),
        content_hash: String(this.args[5]),
        event_id: String(this.args[6]),
        payload_json: String(this.args[7]),
      };
      const key = `${row.edition_date}:${row.edition_type}`;
      if (this.db.briefings.has(key)) throw new Error("UNIQUE constraint failed: daily_briefings.edition_date");
      this.db.briefings.set(key, row);
      return { meta: { changes: 1 } };
    }
    if (this.sql.includes("INSERT OR IGNORE INTO ingest_events")) {
      const eventId = String(this.args[0]);
      if (this.db.events.has(eventId)) return { meta: { changes: 0 } };
      this.db.events.add(eventId);
      return { meta: { changes: 1 } };
    }
    if (this.sql.includes("INSERT INTO ingest_events")) {
      const eventId = String(this.args[0]);
      if (this.db.events.has(eventId)) throw new Error("UNIQUE constraint failed: ingest_events.event_id");
      this.db.events.add(eventId);
      return { meta: { changes: 1 } };
    }
    if (this.sql.includes("INSERT INTO ingest_log")) {
      this.db.logs += 1;
      return { meta: { changes: 1 } };
    }
    throw new Error(`Unhandled SQL: ${this.sql}`);
  }
}

export class FakeD1 {
  readonly briefings = new Map<string, BriefingRow>();
  readonly events = new Set<string>();
  logs = 0;

  prepare(sql: string): FakeStatement {
    return new FakeStatement(this, sql);
  }

  async batch(statements: FakeStatement[]): Promise<unknown[]> {
    const briefings = new Map(this.briefings);
    const events = new Set(this.events);
    const logs = this.logs;
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    } catch (error) {
      this.briefings.clear();
      for (const [key, row] of briefings) this.briefings.set(key, row);
      this.events.clear();
      for (const eventId of events) this.events.add(eventId);
      this.logs = logs;
      throw error;
    }
  }
}

const fixedNow = Date.parse("2026-08-12T12:00:00.000Z");

async function signIngestBody(secret: string, timestamp: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${body}`));
  const hex = [...new Uint8Array(mac)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `sha256=${hex}`;
}

describe("DailyBriefing publication helpers", () => {
  it("canonicalizes object keys before hashing", async () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
    expect(await briefingContentHash({ b: 1, a: 2 })).toBe(await briefingContentHash({ a: 2, b: 1 }));
  });

  it("changes the content hash when the payload changes", async () => {
    const original = await briefingContentHash(exampleDailyBriefing);
    const changed = await briefingContentHash({ ...exampleDailyBriefing, marketSummary: "Changed" });
    expect(changed).not.toBe(original);
  });

  it("classifies missing, fresh, stale, and future publication timestamps", () => {
    expect(briefingFreshness(null, fixedNow)).toBe("unavailable");
    expect(briefingFreshness("2026-08-11T13:00:00.000Z", fixedNow)).toBe("fresh");
    expect(briefingFreshness("2026-08-10T09:00:00.000Z", fixedNow)).toBe("stale");
    expect(briefingFreshness("2026-08-12T13:00:00.000Z", fixedNow)).toBe("stale");
    expect(briefingFreshness("not-a-timestamp", fixedNow)).toBe("unavailable");
  });

  it("publishes once, skips the same content, and rejects altered content for an edition", async () => {
    const db = new FakeD1();
    const briefing = JSON.parse(JSON.stringify({ ...exampleDailyBriefing, example: false }));

    const first = await publishDailyBriefing(
      db as unknown as D1Database,
      "brief-event-001",
      "2026-08-12T12:00:00.000Z",
      briefing,
      "2026-08-12T12:00:01.000Z",
    );
    expect(first.kind).toBe("applied");

    const replay = await publishDailyBriefing(
      db as unknown as D1Database,
      "brief-event-002",
      "2026-08-12T12:00:02.000Z",
      briefing,
      "2026-08-12T12:00:02.000Z",
    );
    expect(replay.kind).toBe("skipped");

    const altered = { ...briefing, marketSummary: "Altered after publication" };
    const conflict = await publishDailyBriefing(
      db as unknown as D1Database,
      "brief-event-003",
      "2026-08-12T12:00:03.000Z",
      altered,
      "2026-08-12T12:00:03.000Z",
    );
    expect(conflict.kind).toBe("rejected");

    await expect(readLatestBriefing(db as unknown as D1Database)).resolves.toMatchObject({
      editionDate: "2026-08-11",
      editionType: "pre_market",
      example: false,
    });
    await expect(readBriefingByDateAndType(db as unknown as D1Database, "2026-08-11", "pre_market")).resolves.toMatchObject({
      title: "Pre-market briefing",
    });
    await expect(readBriefingStatus(db as unknown as D1Database, Date.parse("2026-08-12T12:00:03.000Z"))).resolves.toMatchObject({
      available: true,
      freshness: "fresh",
      ageSeconds: 2,
    });
    expect(db.briefings.size).toBe(1);

    const stored = db.briefings.get("2026-08-11:pre_market");
    if (!stored) throw new Error("Expected stored briefing row");
    stored.payload_json = JSON.stringify({ ...briefing, marketSummary: "Tampered at rest" });
    await expect(readLatestBriefing(db as unknown as D1Database)).rejects.toThrow("content hash");
    await expect(readBriefingStatus(db as unknown as D1Database, fixedNow)).resolves.toMatchObject({
      available: false,
      freshness: "unavailable",
    });
  });

  it("serves the validated briefing through the read-only API routes", async () => {
    const db = new FakeD1();
    const env = {
      DB: db as unknown as D1Database,
      ASSETS: { fetch: async () => new Response("assets") },
    } as unknown as Env;
    const briefing = JSON.parse(JSON.stringify({ ...exampleDailyBriefing, example: false }));

    const notFound = await worker.fetch(new Request("https://example.test/api/briefs/latest"), env);
    expect(notFound.status).toBe(404);

    await publishDailyBriefing(db as unknown as D1Database, "brief-route-001", "2026-08-12T12:00:00.000Z", briefing, "2026-08-12T12:00:01.000Z");

    const latest = await worker.fetch(new Request("https://example.test/api/briefs/latest?editionType=pre_market"), env);
    expect(latest.status).toBe(200);
    await expect(latest.json()).resolves.toMatchObject({
      editionDate: "2026-08-11",
      editionType: "pre_market",
      example: false,
    });

    const invalidFilter = await worker.fetch(new Request("https://example.test/api/briefs/latest?editionType=intraday"), env);
    expect(invalidFilter.status).toBe(400);

    const invalidIdentifier = await worker.fetch(new Request("https://example.test/api/briefs/2026-08-11/intraday"), env);
    expect(invalidIdentifier.status).toBe(400);

    const byDate = await worker.fetch(new Request("https://example.test/api/briefs/2026-08-11/pre_market"), env);
    expect(byDate.status).toBe(200);

    const ingestEnv = { ...env, INGEST_SECRET: "test-secret" } as Env;
    const unsigned = await handleIngest(
      new Request("https://example.test/ingest/events", {
        method: "POST",
        body: JSON.stringify({ events: [] }),
      }),
      ingestEnv,
    );
    expect(unsigned.status).toBe(401);

    const signedDb = new FakeD1();
    const signedEnv = { ...env, DB: signedDb, INGEST_SECRET: "test-secret" } as unknown as Env;
    const timestamp = new Date().toISOString();
    const signedBody = JSON.stringify({
      events: [{
        type: "DAILY_BRIEFING_PUBLISHED",
        event_id: "signed-brief-001",
        timestamp,
        payload: briefing,
      }],
    });
    const signature = await signIngestBody("test-secret", timestamp, signedBody);
    const signed = await handleIngest(
      new Request("https://example.test/ingest/events", {
        method: "POST",
        body: signedBody,
        headers: {
          "X-Ingest-Signature": signature,
          "X-Ingest-Timestamp": timestamp,
        },
      }),
      signedEnv,
    );
    expect(signed.status).toBe(200);

    const tamperedTimestamp = new Date(Date.parse(timestamp) + 1000).toISOString();
    const replayWithFreshTimestamp = await handleIngest(
      new Request("https://example.test/ingest/events", {
        method: "POST",
        body: signedBody,
        headers: {
          "X-Ingest-Signature": signature,
          "X-Ingest-Timestamp": tamperedTimestamp,
        },
      }),
      signedEnv,
    );
    expect(replayWithFreshTimestamp.status).toBe(401);
  });
});
