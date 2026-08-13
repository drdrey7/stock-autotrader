import { describe, expect, it } from "vitest";
import type { Env } from "./index";
import { handleIngest } from "./ingest";
import { readXPosts, storeXPosts, type XPost, type XPostRow, xPostSchema } from "./x-posts";

type IngestEventRow = { event_id: string; event_type: string; received_at: string; status: string };

type PostRow = {
  id: string;
  author: string;
  text: string;
  created_at: string;
  url: string;
  symbol: string | null;
  company: string | null;
  universe: string | null;
  collected_at: string;
  chart_json: string | null;
  price: string | null;
  change: string | null;
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
    if (this.sql.includes("FROM app_meta")) {
      const match = this.sql.match(/key = '([^']+)'/);
      const value = match ? this.db.meta.get(match[1]!) : undefined;
      return (value === undefined ? null : { value }) as T | null;
    }
    throw new Error(`Unhandled SELECT: ${this.sql}`);
  }

  async run(): Promise<{ meta: { changes: number } }> {
    this.db.sqls.push(this.sql);
    if (this.sql.includes("INSERT OR IGNORE INTO ingest_events")) {
      const eventId = String(this.args[0]);
      if (this.db.events.has(eventId)) return { meta: { changes: 0 } };
      this.db.events.set(eventId, {
        event_id: eventId,
        event_type: String(this.args[1]),
        received_at: String(this.args[2]),
        status: String(this.args[3]),
      });
      return { meta: { changes: 1 } };
    }
    if (this.sql.includes("UPDATE ingest_events SET status")) {
      const eventId = String(this.args[0]);
      const claimStatus = String(this.args[1]);
      const event = this.db.events.get(eventId);
      if (!event || event.status !== claimStatus) return { meta: { changes: 0 } };
      event.status = "applied";
      return { meta: { changes: 1 } };
    }
    if (this.sql.includes("INSERT INTO x_posts")) {
      if (this.sql.includes("WHERE EXISTS")) {
        const eventId = String(this.args[12]);
        const claimStatus = String(this.args[13]);
        if (this.db.events.get(eventId)?.status !== claimStatus) return { meta: { changes: 0 } };
      }
      const id = String(this.args[0]);
      if (this.db.posts.has(id)) {
        // Without the ON CONFLICT upsert the row would be ignored, not
        // refreshed: mirror the real SQL contract in the fake.
        if (!this.sql.includes("ON CONFLICT")) return { meta: { changes: 0 } };
        const existing = this.db.posts.get(id)!;
        this.db.posts.set(id, { ...existing, collected_at: String(this.args[8]) });
        return { meta: { changes: 1 } };
      }
      this.db.posts.set(id, {
        id,
        author: String(this.args[1]),
        text: String(this.args[2]),
        created_at: String(this.args[3]),
        url: String(this.args[4]),
        symbol: this.args[5] === null ? null : String(this.args[5]),
        company: this.args[6] === null ? null : String(this.args[6]),
        universe: this.args[7] === null ? null : String(this.args[7]),
        collected_at: String(this.args[8]),
        chart_json: this.args[9] === null ? null : String(this.args[9]),
        price: this.args[10] === null ? null : String(this.args[10]),
        change: this.args[11] === null ? null : String(this.args[11]),
      });
      return { meta: { changes: 1 } };
    }
    if (this.sql.includes("INSERT INTO bot_events")) {
      return { meta: { changes: 1 } };
    }
    if (this.sql.includes("INSERT INTO app_meta")) {
      const keyValues = this.sql.match(/VALUES \('([^']+)', \?\)/);
      if (keyValues) {
        const key = keyValues[1]!;
        const value = String(this.args[0]);
        // Mirror the real SQL contract: an upsert carrying
        // `WHERE excluded.value > app_meta.value` must never regress
        // an existing newer timestamp.
        if (this.sql.includes("excluded.value > app_meta.value")) {
          const existing = this.db.meta.get(key);
          if (existing !== undefined && existing >= value) return { meta: { changes: 0 } };
        }
        // json_extract guard: the stored value is JSON and the upsert only
        // advances when the incoming asOf is strictly newer.
        if (this.sql.includes("json_extract")) {
          const existingRaw = this.db.meta.get(key);
          if (existingRaw !== undefined) {
            const incoming = JSON.parse(value) as { asOf: string };
            const existing = JSON.parse(existingRaw) as { asOf: string };
            if (incoming.asOf <= existing.asOf) return { meta: { changes: 0 } };
          }
        }
        this.db.meta.set(key, value);
        return { meta: { changes: 1 } };
      }
      const keySelect = this.sql.match(/SELECT '([^']+)', \?/);
      if (!keySelect) throw new Error(`Unhandled app_meta: ${this.sql}`);
      // The real statement must gate on the claim and only advance to a
      // newer timestamp; anything else is a contract regression.
      if (!this.sql.includes("WHERE EXISTS") || !this.sql.includes("excluded.value > app_meta.value")) {
        throw new Error(`Unhandled app_meta contract: ${this.sql}`);
      }
      const key = keySelect[1]!;
      const value = String(this.args[0]);
      // The collection-metadata upsert is conditional on the winning claim
      // and only advances to a newer timestamp, mirroring the real SQL.
      if (this.db.events.get(String(this.args[1]))?.status !== String(this.args[2])) return { meta: { changes: 0 } };
      const existing = this.db.meta.get(key);
      if (existing !== undefined && existing >= value) return { meta: { changes: 0 } };
      this.db.meta.set(key, value);
      return { meta: { changes: 1 } };
    }
    if (this.sql.includes("INSERT INTO earnings")) {
      return { meta: { changes: 1 } };
    }
    if (this.sql.includes("INSERT INTO ingest_log")) {
      return { meta: { changes: 1 } };
    }
    if (this.sql.includes("DELETE FROM earnings")) {
      return { meta: { changes: 1 } };
    }
    if (this.sql.includes("DELETE FROM ingest_events")) {
      this.db.events.delete(String(this.args[0]));
      return { meta: { changes: 1 } };
    }
    throw new Error(`Unhandled SQL: ${this.sql}`);
  }

  async all<T>(): Promise<{ results: T[] }> {
    if (!this.sql.includes("FROM x_posts")) throw new Error(`Unhandled SELECT: ${this.sql}`);
    let rows = [...this.db.posts.values()] as unknown as XPostRow[];
    const whereIdx = this.sql.indexOf("WHERE");
    if (whereIdx !== -1) {
      const where = this.sql.slice(whereIdx);
      if (where.includes("author = ?")) {
        const author = String(this.args[0]);
        rows = rows.filter((row) => row.author === author);
      }
      if (where.includes("symbol = ?")) {
        const symbol = String(where.includes("author = ?") ? this.args[1] : this.args[0]);
        rows = rows.filter((row) => row.symbol === symbol);
      }
    }
    rows = rows.sort((a, b) => b.created_at.localeCompare(a.created_at));
    const limit = Number(this.args[this.args.length - 1] ?? 50);
    return { results: rows.slice(0, limit) as T[] };
  }
}

class FakeD1 {
  readonly events = new Map<string, IngestEventRow>();
  readonly posts = new Map<string, PostRow>();
  readonly meta = new Map<string, string>();
  readonly sqls: string[] = [];

  prepare(sql: string): FakeStatement {
    return new FakeStatement(this, sql);
  }

  async batch(statements: FakeStatement[]): Promise<{ meta: { changes: number } }[]> {
    const results: { meta: { changes: number } }[] = [];
    for (const statement of statements) {
      results.push(await statement.run());
    }
    return results;
  }
}

function env(db: FakeD1): Env {
  return { DB: db as unknown as D1Database, INGEST_SECRET: "test", ASSETS: {} as never };
}

async function signIngestBody(secret: string, timestamp: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${body}`));
  return `sha256=${Array.from(new Uint8Array(mac)).map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

const postA: XPost = {
  id: "post-aaa",
  author: "@nolimitgains",
  text: "$NVDA reclaiming the 20D with volume.",
  created_at: "2026-08-11T10:15:00Z",
  url: "https://x.com/nolimitgains/status/post-aaa",
  symbol: "NVDA",
  company: "NVIDIA Corporation",
  universe: "Both",
};

const postB: XPost = {
  id: "post-bbb",
  author: "@nolimitgains",
  text: "$AAPL holding the breakout zone.",
  created_at: "2026-08-11T11:02:00Z",
  url: "https://x.com/nolimitgains/status/post-bbb",
  symbol: "AAPL",
  company: "Apple Inc.",
  universe: "S&P 500",
};

describe("xPostSchema provenance", () => {
  it("accepts the declared author and post id on the canonical X host", () => {
    expect(xPostSchema.safeParse(postA).success).toBe(true);
  });

  it("rejects empty userinfo even when the canonical host and path match", () => {
    const result = xPostSchema.safeParse({
      ...postA,
      url: "https://@x.com/nolimitgains/status/post-aaa",
    });
    expect(result.success).toBe(false);
  });

  it("rejects raw ASCII controls before URL normalization", () => {
    for (const control of ["\u0001", "\t", "\n", "\r", "\u007f"]) {
      const result = xPostSchema.safeParse({
        ...postA,
        url: `https://x.com/nolimitgains/status/post-${control}aaa`,
      });
      expect(result.success).toBe(false);
    }
  });

  it("rejects raw outer whitespace before URL parser normalization", () => {
    for (const url of [
      " https://x.com/nolimitgains/status/post-aaa",
      "https://x.com/nolimitgains/status/post-aaa ",
      "https://x.com/nolimitgains/status/post-aaa\n",
    ]) {
      expect(xPostSchema.safeParse({ ...postA, url }).success).toBe(false);
    }
  });

  it("rejects URL parser normalization of backslashes and Unicode hostnames", () => {
    const invalidUrls = [
      "https://x.com" + "\\" + "nolimitgains/status/post-aaa",
      "https://x.com/nolimitgains" + "\\" + "status/post-aaa",
      "https://ｘ.com/nolimitgains/status/post-aaa",
      "https://x。com/nolimitgains/status/post-aaa",
    ];
    for (const url of invalidUrls) {
      expect(xPostSchema.safeParse({ ...postA, url }).success).toBe(false);
    }
  });

  it("rejects raw path dot-segments instead of accepting URL-normalized paths", () => {
    for (const url of [
      "https://x.com/nolimitgains/status/./post-aaa",
      "https://x.com/nolimitgains/status/post-aaa/.",
      "https://x.com/nolimitgains/status//post-aaa",
      "https://x.com/nolimitgains/status/post-aaa\\..\\",
      "https://x.com/nolimitgains/status/post%20aaa",
      "https://x.com/nolimitgains/status/post%00aaa",
      "https://x.com/nolimitgains/status/post%2Faaa",
      "https://x.com/nolimitgains/status/post%5Caaa",
      "https://x.com:/nolimitgains/status/post-aaa",
      "https://x.com/nolimitgains/status/foöbar",
      "https://x.com/nolimitgains/status/foo%C3%B6bar",
    ]) {
      const result = xPostSchema.safeParse({ ...postA, url });
      expect(result.success).toBe(false);
    }
  });

  it("rejects an arbitrary HTTPS URL even when the author is allowlisted", () => {
    const result = xPostSchema.safeParse({
      ...postA,
      url: "https://example.com/nolimitgains/status/post-aaa",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a symbol outside the declared universe", () => {
    const result = xPostSchema.safeParse({
      ...postA,
      symbol: "ONON",
      universe: "S&P 500",
    });
    expect(result.success).toBe(false);
  });
});

describe("storeXPosts", () => {
  it("stores posts and claims the event idempotently", async () => {
    const db = new FakeD1();
    const first = await storeXPosts(db as unknown as D1Database, "event-12345678", "2026-08-12T12:00:00Z", [postA, postB]);
    expect(first).toEqual({ kind: "applied", applied: 2, skipped: 0 });
    expect(db.posts.size).toBe(2);

    const replay = await storeXPosts(db as unknown as D1Database, "event-12345678", "2026-08-12T12:00:00Z", [
      { ...postA, id: "post-ccc" },
    ]);
    expect(replay).toEqual({ kind: "skipped", reason: "duplicate event" });
    expect(db.posts.size).toBe(2);
  });

  it("upserts duplicate post ids within the same event without duplicating rows", async () => {
    const db = new FakeD1();
    const result = await storeXPosts(db as unknown as D1Database, "event-abcdef12", "2026-08-12T12:00:00Z", [postA, { ...postA }]);
    expect(result).toEqual({ kind: "applied", applied: 2, skipped: 0 });
    expect(db.posts.size).toBe(1);
    expect(db.posts.get(postA.id)?.collected_at).toBe("2026-08-12T12:00:00Z");
  });

  it("rejects future-dated posts before writing the event or feed row", async () => {
    const db = new FakeD1();
    const receivedAt = "2026-08-12T12:00:00.000Z";
    const futurePost = {
      ...postA,
      created_at: "2026-08-12T12:10:00.000Z",
    };
    const result = await storeXPosts(
      db as unknown as D1Database,
      "event-future-1",
      receivedAt,
      [futurePost],
    );
    expect(result).toEqual({ kind: "rejected", reason: "post created_at is in the future" });
    expect(db.events.size).toBe(0);
    expect(db.posts.size).toBe(0);
  });
});

describe("readXPosts", () => {
  it("returns posts newest first with author filter", async () => {
    const db = new FakeD1();
    await storeXPosts(db as unknown as D1Database, "event-12345678", "2026-08-12T12:00:00Z", [postA, postB]);
    const rows = await readXPosts(db as unknown as D1Database, { author: "@nolimitgains", limit: 10 });
    expect(rows.map((row) => row.id)).toEqual(["post-bbb", "post-aaa"]);
    expect(rows[0]?.company).toBe("Apple Inc.");
  });

  it("sorts timestamps with different offsets chronologically", async () => {
    const db = new FakeD1();
    await storeXPosts(db as unknown as D1Database, "event-timezones", "2026-08-12T14:00:00Z", [
      { ...postA, id: "post-utc", created_at: "2026-08-12T12:00:00Z" },
      { ...postB, id: "post-offset", created_at: "2026-08-12T09:00:00-04:00" },
    ]);
    const rows = await readXPosts(db as unknown as D1Database, { limit: 10 });
    expect(rows.map((row) => row.id)).toEqual(["post-offset", "post-utc"]);
    expect(rows[0]?.created_at).toBe("2026-08-12T13:00:00.000Z");
  });

  it("filters by symbol", async () => {
    const db = new FakeD1();
    await storeXPosts(db as unknown as D1Database, "event-12345678", "2026-08-12T12:00:00Z", [postA, postB]);
    const rows = await readXPosts(db as unknown as D1Database, { symbol: "NVDA", limit: 10 });
    expect(rows.map((row) => row.id)).toEqual(["post-aaa"]);
  });

  it("clamps the limit", async () => {
    const db = new FakeD1();
    await storeXPosts(db as unknown as D1Database, "event-12345678", "2026-08-12T12:00:00Z", [postA, postB]);
    const rows = await readXPosts(db as unknown as D1Database, { limit: 1 });
    expect(rows).toHaveLength(1);
  });

  it("parses chart_json into a number array", async () => {
    const db = new FakeD1();
    const withChart: XPost = {
      ...postA,
      chart: [340.1, 341.5, 339.8, 343.8],
      price: "343.80",
      change: "-3.84",
    };
    await storeXPosts(db as unknown as D1Database, "event-12345678", "2026-08-12T12:00:00Z", [withChart]);
    const rows = await readXPosts(db as unknown as D1Database, { symbol: "NVDA", limit: 10 });
    expect(rows[0]?.chart).toEqual([340.1, 341.5, 339.8, 343.8]);
    expect(rows[0]?.price).toBe("343.80");
    expect(rows[0]?.change).toBe("-3.84");
  });
});

describe("ingest X_POSTS_COLLECTED", () => {
  async function signedRequest(body: unknown): Promise<Request> {
    const rawBody = JSON.stringify(body);
    const timestamp = new Date().toISOString();
    const signature = await signIngestBody("test", timestamp, rawBody);
    return new Request("https://example.com/ingest/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-ingest-signature": signature,
        "x-ingest-timestamp": timestamp,
      },
      body: rawBody,
    });
  }

  it("applies a valid event through handleIngest", async () => {
    const db = new FakeD1();
    const request = await signedRequest({
      events: [
        {
          type: "X_POSTS_COLLECTED",
          event_id: "xcollect-0001",
          timestamp: new Date().toISOString(),
          payload: { posts: [postA, postB] },
        },
      ],
    });
    const response = await handleIngest(request, env(db));
    const body = (await response.json()) as { applied: string[] };
    expect(response.status).toBe(200);
    expect(body.applied).toEqual(["xcollect-0001"]);
    expect(db.posts.size).toBe(2);
  });

  it("rejects posts with a syntactically valid but non-allowlisted handle", async () => {
    const db = new FakeD1();
    const request = await signedRequest({
      events: [
        {
          type: "X_POSTS_COLLECTED",
          event_id: "xcollect-0002b",
          timestamp: new Date().toISOString(),
          payload: { posts: [{ ...postA, author: "@another_account" }] },
        },
      ],
    });
    const response = await handleIngest(request, env(db));
    const body = (await response.json()) as { rejected: { event_id: string; reason: string }[] };
    expect(body.rejected).toHaveLength(1);
    expect(body.rejected[0]?.reason).toBe("invalid schema");
    expect(db.posts.size).toBe(0);
  });

  it("rejects posts with a non-allowlisted handle at the schema layer", async () => {
    const db = new FakeD1();
    const request = await signedRequest({
      events: [
        {
          type: "X_POSTS_COLLECTED",
          event_id: "xcollect-0002",
          timestamp: new Date().toISOString(),
          payload: { posts: [{ ...postA, author: "no-handle" }] },
        },
      ],
    });
    const response = await handleIngest(request, env(db));
    const body = (await response.json()) as { rejected: { event_id: string; reason: string }[] };
    expect(body.rejected).toHaveLength(1);
    expect(body.rejected[0]?.reason).toBe("invalid schema");
    expect(db.posts.size).toBe(0);
  });

  it("rejects a signed event timestamp materially in the future before writing", async () => {
    const db = new FakeD1();
    const request = await signedRequest({
      events: [{
        type: "X_POSTS_COLLECTED",
        event_id: "xcollect-future-01",
        timestamp: new Date(Date.now() + 10 * 60_000).toISOString(),
        payload: { posts: [postA] },
      }],
    });
    const response = await handleIngest(request, env(db));
    const body = (await response.json()) as { rejected: { event_id: string; reason: string }[] };
    expect(response.status).toBe(200);
    expect(body.rejected).toEqual([
      { event_id: "xcollect-future-01", reason: "event timestamp is in the future" },
    ]);
    expect(db.events.size).toBe(0);
    expect(db.posts.size).toBe(0);
  });

  it("rejects a future timestamp before claiming a generic event", async () => {
    const db = new FakeD1();
    const request = await signedRequest({
      events: [{
        type: "SYSTEM_STATUS",
        event_id: "status-future-01",
        timestamp: new Date(Date.now() + 10 * 60_000).toISOString(),
        payload: { engine: "online", apiHealth: "healthy" },
      }],
    });
    const response = await handleIngest(request, env(db));
    const body = (await response.json()) as { rejected: { event_id: string; reason: string }[] };
    expect(response.status).toBe(200);
    expect(body.rejected).toEqual([
      { event_id: "status-future-01", reason: "event timestamp is in the future" },
    ]);
    expect(db.events.size).toBe(0);
  });

  it("rejects an unsigned request", async () => {
    const db = new FakeD1();
    const request = new Request("https://example.com/ingest/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        events: [
          {
            type: "X_POSTS_COLLECTED",
            event_id: "xcollect-0003",
            timestamp: new Date().toISOString(),
            payload: { posts: [postA] },
          },
        ],
      }),
    });
    const response = await handleIngest(request, env(db));
    expect(response.status).toBe(401);
    expect(db.posts.size).toBe(0);
  });

  it("records publication metadata for a valid empty earnings calendar", async () => {
    const db = new FakeD1();
    const timestamp = new Date().toISOString();
    const request = await signedRequest({
      events: [{
        type: "EARNINGS_UPDATED",
        event_id: "earn-empty-0001",
        timestamp,
        payload: { items: [] },
      }],
    });
    const response = await handleIngest(request, env(db));
    const body = (await response.json()) as { applied: string[] };
    expect(response.status).toBe(200);
    expect(body.applied).toEqual(["earn-empty-0001"]);
    expect(db.meta.get("earningsUpdatedAt")).toBe(timestamp);
    expect(db.events.size).toBe(1);
  });

  it("records collection metadata when a run contains only duplicate posts", async () => {
    const db = new FakeD1();
    const firstTimestamp = new Date().toISOString();
    const first = await signedRequest({
      events: [{
        type: "X_POSTS_COLLECTED",
        event_id: "xcollect-dup-0001",
        timestamp: firstTimestamp,
        payload: { posts: [postA] },
      }],
    });
    const firstResponse = await handleIngest(first, env(db));
    expect(((await firstResponse.json()) as { applied: string[] }).applied).toEqual(["xcollect-dup-0001"]);
    expect(db.posts.size).toBe(1);

    const duplicateTimestamp = new Date(Date.now() + 1_000).toISOString();
    const duplicate = await signedRequest({
      events: [{
        type: "X_POSTS_COLLECTED",
        event_id: "xcollect-dup-0002",
        timestamp: duplicateTimestamp,
        payload: { posts: [postA] },
      }],
    });
    const duplicateResponse = await handleIngest(duplicate, env(db));
    const body = (await duplicateResponse.json()) as { applied: string[] };
    expect(duplicateResponse.status).toBe(200);
    expect(body.applied).toEqual(["xcollect-dup-0002"]);
    expect(db.posts.size).toBe(1);
    expect(db.meta.get("xPostsUpdatedAt")).toBe(duplicateTimestamp);
    expect(db.posts.get(postA.id)?.collected_at).toBe(duplicateTimestamp);
  });

  it("does not regress X collection metadata on a retried event or an older delivery", async () => {
    const db = new FakeD1();
    const firstTimestamp = new Date().toISOString();
    const first = await signedRequest({
      events: [{
        type: "X_POSTS_COLLECTED",
        event_id: "xcollect-regress-0001",
        timestamp: firstTimestamp,
        payload: { posts: [postA] },
      }],
    });
    await handleIngest(first, env(db));
    expect(db.meta.get("xPostsUpdatedAt")).toBe(firstTimestamp);

    // Retry of the same event with an older timestamp: claim loses, metadata
    // must not be overwritten.
    const older = new Date(Date.now() - 60_000).toISOString();
    const retry = await signedRequest({
      events: [{
        type: "X_POSTS_COLLECTED",
        event_id: "xcollect-regress-0001",
        timestamp: older,
        payload: { posts: [postA] },
      }],
    });
    const retryResponse = await handleIngest(retry, env(db));
    expect(((await retryResponse.json()) as { skipped: string[] }).skipped).toEqual(["xcollect-regress-0001"]);
    expect(db.meta.get("xPostsUpdatedAt")).toBe(firstTimestamp);
  });

  it("clears superseded earnings before marking an empty snapshot applied", async () => {
    const db = new FakeD1();
    const t1 = new Date().toISOString();
    const first = await signedRequest({
      events: [{
        type: "EARNINGS_UPDATED",
        event_id: "earn-replace-0001",
        timestamp: t1,
        payload: { items: [{
          symbol: "AAPL", company: "Apple Inc.", date: "2026-08-20", timing: "BMO",
          eventSignal: "Confirmed", engineRelevant: false, signal: null, strategy: null,
          hasPosition: false, tracked: false, updatedAt: t1,
        }] },
      }],
    });
    const firstResponse = await handleIngest(first, env(db));
    expect(((await firstResponse.json()) as { applied: string[] }).applied).toEqual(["earn-replace-0001"]);

    const t2 = new Date(Date.now() + 1_000).toISOString();
    db.sqls.length = 0;
    const second = await signedRequest({
      events: [{
        type: "EARNINGS_UPDATED",
        event_id: "earn-replace-0002",
        timestamp: t2,
        payload: { items: [] },
      }],
    });
    const secondResponse = await handleIngest(second, env(db));
    expect(((await secondResponse.json()) as { applied: string[] }).applied).toEqual(["earn-replace-0002"]);
    expect(db.meta.get("earningsUpdatedAt")).toBe(t2);
    expect(db.sqls.some((sql) => sql.includes("DELETE FROM earnings"))).toBe(true);
    expect(db.sqls.some((sql) => sql.includes("INSERT INTO earnings"))).toBe(false);
  });

  it("does not regress earningsUpdatedAt on an out-of-order older event", async () => {
    const db = new FakeD1();
    const t2 = new Date().toISOString();
    const newer = await signedRequest({
      events: [{
        type: "EARNINGS_UPDATED",
        event_id: "earn-ooo-0002",
        timestamp: t2,
        payload: { items: [{
          symbol: "MSFT", company: "Microsoft Corp.", date: "2026-08-21", timing: "AMC",
          eventSignal: "Confirmed", engineRelevant: false, signal: null, strategy: null,
          hasPosition: false, tracked: false, updatedAt: t2,
        }] },
      }],
    });
    const newerResponse = await handleIngest(newer, env(db));
    expect(((await newerResponse.json()) as { applied: string[] }).applied).toEqual(["earn-ooo-0002"]);
    expect(db.meta.get("earningsUpdatedAt")).toBe(t2);

    const t1 = new Date(Date.now() - 60_000).toISOString();
    db.sqls.length = 0;
    const older = await signedRequest({
      events: [{
        type: "EARNINGS_UPDATED",
        event_id: "earn-ooo-0001",
        timestamp: t1,
        payload: { items: [] },
      }],
    });
    const olderResponse = await handleIngest(older, env(db));
    expect(((await olderResponse.json()) as { applied: string[] }).applied).toEqual(["earn-ooo-0001"]);
    // Metadata keeps the newer timestamp; the older event cannot regress freshness.
    expect(db.meta.get("earningsUpdatedAt")).toBe(t2);
  });

  it("normalizes explicit UTC offsets before comparing publication order", async () => {
    const db = new FakeD1();
    // 08:00-04:00 == 12:00Z
    const offset = await signedRequest({
      events: [{
        type: "EARNINGS_UPDATED",
        event_id: "earn-offset-0001",
        timestamp: "2026-08-13T08:00:00-04:00",
        payload: { items: [] },
      }],
    });
    const offsetResponse = await handleIngest(offset, env(db));
    expect(((await offsetResponse.json()) as { applied: string[] }).applied).toEqual(["earn-offset-0001"]);
    expect(db.meta.get("earningsUpdatedAt")).toBe("2026-08-13T12:00:00.000Z");

    // 11:00Z is earlier than 12:00Z but compares lexically larger than the
    // raw -04:00 string; the normalized comparison must reject it.
    const laterLexically = await signedRequest({
      events: [{
        type: "EARNINGS_UPDATED",
        event_id: "earn-offset-0002",
        timestamp: "2026-08-13T11:00:00Z",
        payload: { items: [] },
      }],
    });
    const laterResponse = await handleIngest(laterLexically, env(db));
    expect(((await laterResponse.json()) as { applied: string[] }).applied).toEqual(["earn-offset-0002"]);
    expect(db.meta.get("earningsUpdatedAt")).toBe("2026-08-13T12:00:00.000Z");
  });

  it("merges the index context with the screening snapshot instead of replacing it", async () => {
    const db = new FakeD1();
    const scanSnapshot = {
      provider: "csv",
      status: "healthy" as const,
      asOf: "2026-08-13",
      lastSuccessfulUpdate: "2026-08-13T15:00:00Z",
      universe: { total: 100, eligible: 80, excluded: 20 },
      benchmarks: [
        { symbol: "SPY", date: "2026-08-13", open: 1, high: 2, low: 0.9, close: 1.5, adjustedClose: 1.5, volume: 1000 },
        { symbol: "QQQ", date: "2026-08-13", open: 2, high: 3, low: 1.9, close: 2.5, adjustedClose: 2.5, volume: 900 },
      ],
      warnings: [],
      updatedAt: "2026-08-13T15:00:00Z",
    };
    const scanResponse = await handleIngest(await signedRequest({
      events: [{ type: "MARKET_DATA_UPDATED", event_id: "mkt-scan-0001", timestamp: new Date().toISOString(), payload: scanSnapshot }],
    }), env(db));
    expect(((await scanResponse.json()) as { applied: string[] }).applied).toEqual(["mkt-scan-0001"]);
    expect(JSON.parse(db.meta.get("marketData")!).universe).toEqual({ total: 100, eligible: 80, excluded: 20 });

    // The intraday index-context snapshot carries no universe of its own; it
    // must keep the screening universe and add the live indices.
    const indexSnapshot = {
      provider: "yfinance",
      status: "healthy" as const,
      asOf: "2026-08-13",
      lastSuccessfulUpdate: "2026-08-13T15:30:00Z",
      universe: { total: 0, eligible: 0, excluded: 0 },
      benchmarks: [
        { symbol: "SPY", date: "2026-08-13", open: 1, high: 2, low: 0.9, close: 1.5, adjustedClose: 1.5, volume: 1000 },
        { symbol: "QQQ", date: "2026-08-13", open: 2, high: 3, low: 1.9, close: 2.5, adjustedClose: 2.5, volume: 900 },
      ],
      indices: [
        { symbol: "SPX", name: "S&P 500", value: 6427.18, change: 0.62, updatedAt: "2026-08-13T15:30:00Z" },
        { symbol: "NDX", name: "Nasdaq", value: 23724.31, change: 0.78, updatedAt: "2026-08-13T15:30:00Z" },
        { symbol: "DJI", name: "Dow Jones", value: 45118.26, change: 0.48, updatedAt: "2026-08-13T15:30:00Z" },
        { symbol: "VIX", name: "VIX", value: 15.41, change: -1.26, updatedAt: "2026-08-13T15:30:00Z" },
      ],
      warnings: [],
      updatedAt: "2026-08-13T15:30:00Z",
    };
    const indexResponse = await handleIngest(await signedRequest({
      events: [{ type: "MARKET_DATA_UPDATED", event_id: "mkt-idx-0002", timestamp: new Date().toISOString(), payload: indexSnapshot }],
    }), env(db));
    expect(((await indexResponse.json()) as { applied: string[] }).applied).toEqual(["mkt-idx-0002"]);
    const merged = JSON.parse(db.meta.get("marketData")!);
    expect(merged.universe).toEqual({ total: 100, eligible: 80, excluded: 20 });
    expect(merged.indices).toHaveLength(4);
    expect(merged.provider).toBe("yfinance");

    // And the other way around: a later screening snapshot without indices
    // must not erase the live index context.
    const secondScan = { ...scanSnapshot, lastSuccessfulUpdate: "2026-08-13T16:00:00Z", updatedAt: "2026-08-13T16:00:00Z" };
    const scan2Response = await handleIngest(await signedRequest({
      events: [{ type: "MARKET_DATA_UPDATED", event_id: "mkt-scan-0003", timestamp: new Date().toISOString(), payload: secondScan }],
    }), env(db));
    expect(((await scan2Response.json()) as { applied: string[] }).applied).toEqual(["mkt-scan-0003"]);
    const afterScan = JSON.parse(db.meta.get("marketData")!);
    expect(afterScan.universe).toEqual({ total: 100, eligible: 80, excluded: 20 });
    expect(afterScan.indices).toHaveLength(4);
  });

  it("keeps the aggregate degraded when screening is degraded and only indices refresh", async () => {
    const db = new FakeD1();
    const degradedScan = {
      provider: "csv",
      status: "degraded" as const,
      asOf: "2026-08-13",
      lastSuccessfulUpdate: "2026-08-13T14:00:00Z",
      universe: { total: 100, eligible: 80, excluded: 20 },
      benchmarks: [
        { symbol: "SPY", date: "2026-08-13", open: 1, high: 2, low: 0.9, close: 1.5, adjustedClose: 1.5, volume: 1000 },
        { symbol: "QQQ", date: "2026-08-13", open: 2, high: 3, low: 1.9, close: 2.5, adjustedClose: 2.5, volume: 900 },
      ],
      warnings: ["csv source failed"],
      updatedAt: "2026-08-13T14:00:00Z",
    };
    await handleIngest(await signedRequest({
      events: [{ type: "MARKET_DATA_UPDATED", event_id: "mkt-deg-0001", timestamp: new Date().toISOString(), payload: degradedScan }],
    }), env(db));

    // A healthy index-context event must not flip the aggregate to healthy
    // while the preserved screening universe is still degraded.
    const indexSnapshot = {
      provider: "yfinance",
      status: "healthy" as const,
      asOf: "2026-08-13",
      lastSuccessfulUpdate: "2026-08-13T15:30:00Z",
      universe: { total: 0, eligible: 0, excluded: 0 },
      benchmarks: [
        { symbol: "SPY", date: "2026-08-13", open: 1, high: 2, low: 0.9, close: 1.5, adjustedClose: 1.5, volume: 1000 },
        { symbol: "QQQ", date: "2026-08-13", open: 2, high: 3, low: 1.9, close: 2.5, adjustedClose: 2.5, volume: 900 },
      ],
      indices: [
        { symbol: "SPX", name: "S&P 500", value: 6427.18, change: 0.62, updatedAt: "2026-08-13T15:30:00Z" },
        { symbol: "NDX", name: "Nasdaq", value: 23724.31, change: 0.78, updatedAt: "2026-08-13T15:30:00Z" },
        { symbol: "DJI", name: "Dow Jones", value: 45118.26, change: 0.48, updatedAt: "2026-08-13T15:30:00Z" },
        { symbol: "VIX", name: "VIX", value: 15.41, change: -1.26, updatedAt: "2026-08-13T15:30:00Z" },
      ],
      warnings: [],
      updatedAt: "2026-08-13T15:30:00Z",
    };
    await handleIngest(await signedRequest({
      events: [{ type: "MARKET_DATA_UPDATED", event_id: "mkt-idx-0004", timestamp: new Date().toISOString(), payload: indexSnapshot }],
    }), env(db));
    const merged = JSON.parse(db.meta.get("marketData")!);
    expect(merged.status).toBe("degraded");
    expect(merged.warnings).toEqual(["csv source failed"]);
    expect(merged.indices).toHaveLength(4);
    expect(merged.universe).toEqual({ total: 100, eligible: 80, excluded: 20 });
  });

  it("stores sentiment and never regresses on an older reading", async () => {
    const db = new FakeD1();
    const first = await signedRequest({
      events: [{
        type: "SENTIMENT_UPDATED",
        event_id: "sent-0001",
        timestamp: "2026-08-13T13:00:00Z",
        payload: { provider: "cnn-fear-greed", score: 62, rating: "greed", asOf: "2026-08-13T12:46:16+00:00" },
      }],
    });
    const firstResponse = await handleIngest(first, env(db));
    expect(((await firstResponse.json()) as { applied: string[] }).applied).toEqual(["sent-0001"]);
    expect(JSON.parse(db.meta.get("sentiment")!).score).toBe(62);

    // An older reading (same day, earlier asOf) must not overwrite the newer one.
    db.sqls.length = 0;
    const older = await signedRequest({
      events: [{
        type: "SENTIMENT_UPDATED",
        event_id: "sent-0002",
        timestamp: "2026-08-13T12:00:00Z",
        payload: { provider: "cnn-fear-greed", score: 40, rating: "fear", asOf: "2026-08-13T11:00:00Z" },
      }],
    });
    const olderResponse = await handleIngest(older, env(db));
    expect(((await olderResponse.json()) as { applied: string[] }).applied).toEqual(["sent-0002"]);
    expect(JSON.parse(db.meta.get("sentiment")!).score).toBe(62);
    expect(JSON.parse(db.meta.get("sentiment")!).rating).toBe("greed");

    // A newer reading advances.
    db.sqls.length = 0;
    const nowIso = new Date().toISOString();
    const newer = await signedRequest({
      events: [{
        type: "SENTIMENT_UPDATED",
        event_id: "sent-0003",
        timestamp: nowIso,
        payload: { provider: "cnn-fear-greed", score: 55, rating: "neutral", asOf: new Date(Date.now() + 60_000).toISOString() },
      }],
    });
    const newerResponse = await handleIngest(newer, env(db));
    expect(((await newerResponse.json()) as { applied: string[] }).applied).toEqual(["sent-0003"]);
    expect(JSON.parse(db.meta.get("sentiment")!).score).toBe(55);
  });

  it("compares sentiment asOf chronologically across offsets", async () => {
    const db = new FakeD1();
    const first = await signedRequest({
      events: [{
        type: "SENTIMENT_UPDATED",
        event_id: "sent-off-1",
        timestamp: "2026-08-13T12:00:00Z",
        payload: { provider: "cnn-fear-greed", score: 60, rating: "greed", asOf: "2026-08-13T12:00:00+00:00" },
      }],
    });
    const firstResponse = await handleIngest(first, env(db));
    expect(((await firstResponse.json()) as { applied: string[] }).applied).toEqual(["sent-off-1"]);

    // 09:00-04:00 is 13:00Z — chronologically NEWER than 12:00Z, even though
    // the raw string "09:00-04:00" compares lower than "12:00+00:00".
    db.sqls.length = 0;
    const offset = await signedRequest({
      events: [{
        type: "SENTIMENT_UPDATED",
        event_id: "sent-off-2",
        timestamp: "2026-08-13T13:30:00Z",
        payload: { provider: "cnn-fear-greed", score: 70, rating: "extreme_greed", asOf: "2026-08-13T09:00:00-04:00" },
      }],
    });
    const offsetResponse = await handleIngest(offset, env(db));
    expect(((await offsetResponse.json()) as { applied: string[] }).applied).toEqual(["sent-off-2"]);
    const stored = JSON.parse(db.meta.get("sentiment")!);
    expect(stored.score).toBe(70);
    // The stored asOf is normalized to UTC so the guard stays chronological.
    expect(stored.asOf).toBe("2026-08-13T13:00:00.000Z");
  });
});
