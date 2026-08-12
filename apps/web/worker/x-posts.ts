import { z } from "zod";

export const X_POSTS_EVENT_TYPE = "X_POSTS_COLLECTED" as const;

const isoTimestampSchema = z.string().datetime({ offset: true });

export const xPostSchema = z.strictObject({
  id: z.string().min(4).max(120),
  author: z.string().regex(/^@[A-Za-z0-9_]{1,30}$/, "author must be an @handle"),
  text: z.string().trim().min(1).max(4_000),
  created_at: isoTimestampSchema,
  url: z.string().url().refine((value) => value.startsWith("https://"), "url must be HTTPS"),
  symbol: z
    .string()
    .regex(/^[A-Z0-9.-]{1,12}$/, "symbol must use a canonical ticker format")
    .nullable()
    .optional(),
  company: z.string().trim().min(1).max(200).nullable().optional(),
  universe: z.enum(["S&P 500", "Nasdaq-100", "Both"]).nullable().optional(),
});

export type XPost = z.infer<typeof xPostSchema>;

export const xPostsCollectedSchema = z.strictObject({
  posts: z.array(xPostSchema).min(1).max(100),
});

export const xPostsCollectedEventSchema = z.strictObject({
  type: z.literal(X_POSTS_EVENT_TYPE),
  event_id: z.string().min(8).max(80),
  timestamp: isoTimestampSchema,
  payload: xPostsCollectedSchema,
});

export type StoreXPostsResult =
  | { kind: "applied"; applied: number; skipped: number }
  | { kind: "skipped"; reason: string }
  | { kind: "rejected"; reason: string };

/**
 * Persist collected X posts into the append-only read model.
 *
 * Idempotent by event_id (ingest_events claim) and by post id (INSERT OR
 * IGNORE on the primary key). Duplicate posts inside one event or across
 * events are counted as skipped, never duplicated.
 */
export async function storeXPosts(
  db: D1Database,
  eventId: string,
  receivedAt: string,
  posts: XPost[],
): Promise<StoreXPostsResult> {
  const claim = await db
    .prepare(
      "INSERT OR IGNORE INTO ingest_events (event_id, event_type, received_at, status) VALUES (?, ?, ?, 'applied')",
    )
    .bind(eventId, X_POSTS_EVENT_TYPE, receivedAt)
    .run();

  if (claim.meta.changes === 0) {
    return { kind: "skipped", reason: "duplicate event" };
  }

  const stmts = posts.map((post) =>
    db
      .prepare(
        "INSERT OR IGNORE INTO x_posts (id, author, text, created_at, url, symbol, company, universe, collected_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        post.id,
        post.author,
        post.text,
        post.created_at,
        post.url,
        post.symbol ?? null,
        post.company ?? null,
        post.universe ?? null,
        receivedAt,
      ),
  );

  try {
    const results = await db.batch(stmts);
    const applied = results.filter((result) => result.meta.changes === 1).length;
    const skipped = posts.length - applied;
    return { kind: "applied", applied, skipped };
  } catch (err) {
    // Roll back the claim so a transient failure can be retried.
    await db.prepare("DELETE FROM ingest_events WHERE event_id = ?").bind(eventId).run();
    return { kind: "rejected", reason: String(err).slice(0, 400) };
  }
}

export interface XPostRow {
  id: string;
  author: string;
  text: string;
  created_at: string;
  url: string;
  symbol: string | null;
  company: string | null;
  universe: string | null;
  collected_at: string;
}

export async function readXPosts(
  db: D1Database,
  options: { author?: string; symbol?: string; limit: number },
): Promise<XPostRow[]> {
  const conditions: string[] = [];
  const args: (string | number)[] = [];
  if (options.author) {
    conditions.push("author = ?");
    args.push(options.author);
  }
  if (options.symbol) {
    conditions.push("symbol = ?");
    args.push(options.symbol);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const safeLimit = Math.min(Math.max(options.limit, 1), 200);
  const rows = await db
    .prepare(
      `SELECT id, author, text, created_at, url, symbol, company, universe, collected_at
       FROM x_posts ${where}
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
    )
    .bind(...args, safeLimit)
    .all<XPostRow>();
  return rows.results ?? [];
}
