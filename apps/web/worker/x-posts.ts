import { z } from "zod";
import { isBriefingSymbolInUniverse } from "@stock-autotrader/contracts";

export const X_POSTS_EVENT_TYPE = "X_POSTS_COLLECTED" as const;

/** Source allowlist — mirrors the publisher's accounts registry (v1). */
export const ALLOWED_X_AUTHORS = ["@nolimitgains"] as const;

const isoTimestampSchema = z.string().datetime({ offset: true });
const MAX_POST_CLOCK_SKEW_MS = 5 * 60 * 1000;
const X_POST_HOSTS = new Set(["x.com", "www.x.com"]);

function isExpectedXPostUrl(url: string, author: string, postId: string): boolean {
  if (url.trim() !== url) return false;
  if (url.includes("\\")) return false;
  if ([...url].some((char) => {
    const code = char.codePointAt(0) ?? 0;
    return code <= 0x1f || code === 0x7f;
  })) return false;
  try {
    const parsed = new URL(url);
    const rest = url.slice("https://".length);
    const pathStart = rest.search(/[/?#]/);
    const authority = pathStart >= 0 ? rest.slice(0, pathStart) : rest;
    if (authority.includes("@") || authority.endsWith(":")) return false;
    const rawHost = authority.split(":", 1)[0] ?? "";
    if (!X_POST_HOSTS.has(rawHost.toLowerCase())) return false;
    if (pathStart < 0) return false;
    const rawPath = rest.slice(pathStart).split(/[?#]/, 1)[0] ?? "";
    if (rawPath.includes("\\")) return false;
    for (const segment of rawPath.split("/")) {
      try {
        const decoded = decodeURIComponent(segment);
        if ([".", ".."].includes(decoded)) return false;
        if ([...decoded].some((char) => {
          const code = char.codePointAt(0) ?? 0;
          return code > 0x7e || code <= 0x1f || code === 0x7f || /\s/u.test(char);
        })) return false;
        if (decoded.includes("/") || decoded.includes("\\")) return false;
      } catch {
        return false;
      }
    }
    if (parsed.username || parsed.password || parsed.port) return false;
    const segments = parsed.pathname.split("/");
    return (
      segments.length === 4
      && segments[0] === ""
      && segments[1]?.toLowerCase() === author.slice(1).toLowerCase()
      && segments[2]?.toLowerCase() === "status"
      && segments[3] === postId
    );
  } catch {
    return false;
  }
}

export const xPostSchema = z.strictObject({
  id: z.string().min(4).max(120),
  author: z
    .string()
    .regex(/^@[A-Za-z0-9_]{1,30}$/, "author must be an @handle")
    .refine((handle) => (ALLOWED_X_AUTHORS as readonly string[]).includes(handle), {
      message: "author is not an allowed X source",
    }),
  text: z.string().trim().min(1).max(4_000),
  created_at: isoTimestampSchema,
  url: z
    .string()
    .refine((value) => {
      try {
        new URL(value);
        return true;
      } catch {
        return false;
      }
    }, "url must be a valid URL")
    .refine((value) => value.startsWith("https://"), "url must be HTTPS"),
  symbol: z
    .string()
    .regex(/^[A-Z0-9.-]{1,12}$/, "symbol must use a canonical ticker format")
    .nullable()
    .optional(),
  company: z.string().trim().min(1).max(200).nullable().optional(),
  universe: z.enum(["S&P 500", "Nasdaq-100", "Both"]).nullable().optional(),
  chart: z.array(z.number()).min(2).max(120).nullable().optional(),
  price: z.string().trim().min(1).max(32).nullable().optional(),
  change: z.string().trim().min(1).max(32).nullable().optional(),
}).superRefine((post, ctx) => {
  if (!isExpectedXPostUrl(post.url, post.author, post.id)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["url"], message: "url must match the declared X author" });
  }
  if (post.symbol && post.universe && !isBriefingSymbolInUniverse(post.symbol, post.universe)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["universe"],
      message: "universe must contain the declared symbol",
    });
  }
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
 * Idempotent by event_id (ingest_events claim) and by post id (ON CONFLICT
 * upsert on the primary key). Duplicate posts inside one event or across
 * events never duplicate rows; they refresh collected_at so the read model
 * keeps recording evidence of successful collections.
 */
export async function storeXPosts(
  db: D1Database,
  eventId: string,
  receivedAt: string,
  posts: XPost[],
): Promise<StoreXPostsResult> {
  const receivedAtMs = Date.parse(receivedAt);
  if (!Number.isFinite(receivedAtMs)) {
    return { kind: "rejected", reason: "event timestamp is invalid" };
  }
  if (receivedAtMs - Date.now() > MAX_POST_CLOCK_SKEW_MS) {
    return { kind: "rejected", reason: "event timestamp is in the future" };
  }
  for (const post of posts) {
    const createdAtMs = Date.parse(post.created_at);
    if (!Number.isFinite(createdAtMs) || createdAtMs - receivedAtMs > MAX_POST_CLOCK_SKEW_MS) {
      return { kind: "rejected", reason: "post created_at is in the future" };
    }
  }

  // The claim is acquired inside the same atomic batch as the conditional post
  // writes, avoiding a preliminary read/claim race between concurrent requests
  // that carry the same event_id. Each INSERT is conditional on the winner's
  // unique claim token, so a concurrent loser's INSERT OR IGNORE is harmless.
  const claimToken = crypto.randomUUID();
  const claimStatus = `applying:${claimToken}`;
  const claim = db
    .prepare(
      "INSERT OR IGNORE INTO ingest_events (event_id, event_type, received_at, status) VALUES (?, ?, ?, ?)",
    )
    .bind(eventId, X_POSTS_EVENT_TYPE, receivedAt, claimStatus);

  const stmts = posts.map((post) =>
    db
      .prepare(
        `INSERT INTO x_posts
        (id, author, text, created_at, url, symbol, company, universe, collected_at, chart_json, price, change)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM ingest_events WHERE event_id = ? AND status = ?
        )
        ON CONFLICT (id) DO UPDATE SET collected_at = excluded.collected_at`,
      )
      .bind(
        post.id,
        post.author,
        post.text,
        // Normalize to UTC so ORDER BY created_at DESC is chronological
        // even when incoming timestamps carry different explicit offsets.
        new Date(post.created_at).toISOString(),
        post.url,
        post.symbol ?? null,
        post.company ?? null,
        post.universe ?? null,
        receivedAt,
        post.chart ? JSON.stringify(post.chart) : null,
        post.price ?? null,
        post.change ?? null,
        eventId,
        claimStatus,
      ),
  );
  const finalize = db
    .prepare("UPDATE ingest_events SET status = 'applied' WHERE event_id = ? AND status = ?")
    .bind(eventId, claimStatus);
  // Collection metadata is written even when every post is a duplicate: a
  // successful run must keep the X source fresh regardless of inserted rows.
  const collectionMeta = db
    .prepare("INSERT INTO app_meta (key, value) VALUES ('xPostsUpdatedAt', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
    .bind(receivedAt);

  try {
    // Claim + conditional post writes + collection metadata + final status
    // update in ONE atomic D1 batch. A crash rolls back the entire
    // transaction; a concurrent loser has no matching claim token and
    // therefore writes zero posts.
    const results = await db.batch([claim, ...stmts, collectionMeta, finalize]);
    const claimChanges = results[0]?.meta.changes ?? 0;
    const finalizeChanges = results[results.length - 1]?.meta.changes ?? 0;
    if (claimChanges === 0 || finalizeChanges === 0) {
      return { kind: "skipped", reason: "duplicate event" };
    }
    const applied = results
      .slice(1, -2)
      .filter((result) => result.meta.changes === 1).length;
    const skipped = posts.length - applied;
    return { kind: "applied", applied, skipped };
  } catch (err) {
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
  chart: number[] | null;
  price: string | null;
  change: string | null;
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
      `SELECT id, author, text, created_at, url, symbol, company, universe, collected_at, chart_json, price, change
       FROM x_posts ${where}
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
    )
    .bind(...args, safeLimit)
    .all<XPostRow & { chart_json: string | null }>();
  return (rows.results ?? []).map((row) => {
    let chart: number[] | null = null;
    if (row.chart_json) {
      try {
        const parsed = JSON.parse(row.chart_json) as unknown;
        if (Array.isArray(parsed) && parsed.every((v) => typeof v === "number")) {
          chart = parsed;
        }
      } catch {
        chart = null;
      }
    }
    const { chart_json: _chartJson, ...rest } = row;
    void _chartJson;
    return { ...rest, chart };
  });
}
