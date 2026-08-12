import { describe, expect, it } from "vitest";
import type { Env } from "./index";
import { handleIngest } from "./ingest";
import { readXPosts, storeXPosts, type XPost, type XPostRow } from "./x-posts";

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
    throw new Error(`Unhandled SELECT: ${this.sql}`);
  }

  async run(): Promise<{ meta: { changes: number } }> {
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
    if (this.sql.includes("INSERT OR IGNORE INTO x_posts")) {
      if (this.sql.includes("WHERE EXISTS")) {
        const eventId = String(this.args[12]);
        const claimStatus = String(this.args[13]);
        if (this.db.events.get(eventId)?.status !== claimStatus) return { meta: { changes: 0 } };
      }
      const id = String(this.args[0]);
      if (this.db.posts.has(id)) return { meta: { changes: 0 } };
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
  created_at: "2026-08-12T10:15:00Z",
  url: "https://x.com/nolimitgains/status/post-aaa",
  symbol: "NVDA",
  company: "NVIDIA Corporation",
  universe: "Both",
};

const postB: XPost = {
  id: "post-bbb",
  author: "@nolimitgains",
  text: "$AAPL holding the breakout zone.",
  created_at: "2026-08-12T11:02:00Z",
  url: "https://x.com/nolimitgains/status/post-bbb",
  symbol: "AAPL",
  company: "Apple Inc.",
  universe: "S&P 500",
};

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

  it("skips duplicate post ids within the same event", async () => {
    const db = new FakeD1();
    const result = await storeXPosts(db as unknown as D1Database, "event-abcdef12", "2026-08-12T12:00:00Z", [postA, { ...postA }]);
    expect(result).toEqual({ kind: "applied", applied: 1, skipped: 1 });
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
    await storeXPosts(db as unknown as D1Database, "event-timezones", "2026-08-12T12:00:00Z", [
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
});
