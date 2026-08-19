import { describe, expect, it } from "vitest";
import type { Env } from "../index";
import { readScreenerApi } from "./api";
import { QUOTES_HEALTH_META_KEY, WS_INGESTOR_HEALTH_META_KEY } from "./health";
import { CORE_UNIVERSE } from "@stock-autotrader/contracts";

interface LatestRow {
  symbol: string;
  price: number;
  change_abs: number;
  change_pct: number;
  day_high: number | null;
  day_low: number | null;
  day_open: number | null;
  previous_close: number | null;
  provider: string;
  provider_timestamp: string;
  updated_at: string;
}

const quoteRow = (symbol: string, price: number, updatedAt: string): LatestRow => ({
  symbol,
  price,
  change_abs: 2,
  change_pct: 1.2,
  day_high: price + 2,
  day_low: price - 2,
  day_open: price - 0.5,
  previous_close: price - 2,
  provider: "finnhub-quote",
  provider_timestamp: updatedAt,
  updated_at: updatedAt,
});

function createApiDb(options: {
  quotes?: LatestRow[];
  companies?: Array<{ symbol: string; company: string }>;
  health?: unknown;
  wsHealth?: unknown;
  metrics?: Array<Record<string, unknown>>;
}) {
  const meta = new Map<string, string>();
  if (options.health !== undefined) meta.set(QUOTES_HEALTH_META_KEY, JSON.stringify(options.health));
  if (options.wsHealth !== undefined) meta.set(WS_INGESTOR_HEALTH_META_KEY, JSON.stringify(options.wsHealth));
  return {
    prepare(sql: string) {
      let args: unknown[] = [];
      const statement = {
        bind(...values: unknown[]) {
          args = values;
          return statement;
        },
        async first<T>(): Promise<T | null> {
          if (sql.includes("SELECT value FROM app_meta")) {
            const key = String(args[0] ?? "");
            return { value: meta.get(key) ?? null } as T;
          }
          return null;
        },
        async all<T>(): Promise<{ results: T[] }> {
          if (sql.includes("FROM latest_quotes")) return { results: (options.quotes ?? []) as T[] };
          if (sql.includes("FROM earnings_universe")) return { results: (options.companies ?? []) as T[] };
          if (sql.includes("FROM technical_metrics")) return { results: (options.metrics ?? []) as T[] };
          return { results: [] as T[] };
        },
        async run(): Promise<{ meta: { changes: number } }> {
          if (sql.includes("INSERT INTO app_meta")) {
            const [key, value] = args as [string, string];
            meta.set(key, value);
          }
          return { meta: { changes: 0 } };
        },
      };
      return statement;
    },
  };
}

const envFrom = (db: ReturnType<typeof createApiDb>): Env => ({ DB: db as unknown as Env["DB"] } as unknown as Env);

const health = (lastSuccessAt: string) => ({
  provider: "finnhub-quote",
  status: "ok",
  lastAttemptAt: lastSuccessAt,
  lastSuccessAt,
  lastError: null,
  rowsWritten: 1,
  lastShard: 0,
  rateLimited: false,
});

const REGULAR = new Date("2026-08-13T14:00:00Z"); // Thursday 10:00 ET
const MONDAY_0935 = new Date("2026-08-17T13:35:00Z"); // Monday 09:35 ET (grace)
const SATURDAY = new Date("2026-08-15T14:00:00Z"); // weekend
const NOW_ISO = "2026-08-13T14:00:00.000Z";

/** ISO timestamp N seconds before NOW_ISO (TTL tests). */
const isoAgo = (seconds: number): string => new Date(Date.parse(NOW_ISO) - seconds * 1000).toISOString();

/** A fresh, healthy WebSocket ingestor health record (overridable). */
function wsHealthRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    provider: "finnhub-websocket",
    connection_status: "connected",
    last_ws_heartbeat_at: NOW_ISO,
    updated_at: NOW_ISO,
    last_flush_at: NOW_ISO,
    last_successful_flush_at: NOW_ISO,
    last_error: null,
    last_flush_rows: 50,
    ...overrides,
  };
}
const FRIDAY_CLOSE = "2026-08-14T20:45:00.000Z";

describe("readScreenerApi", () => {
  it("returns the full 50-stock Core Universe with honest Unavailable rows when empty", async () => {
    const response = await readScreenerApi(envFrom(createApiDb({})), REGULAR);
    expect(response.universe.total).toBe(50);
    expect(response.rows).toHaveLength(50);
    expect(response.marketState).toBe("regular");
    expect(response.quotes.state).toBe("Unavailable");
    expect(response.quotes.provider).toBe("unavailable");
    expect(response.quotes.counts).toEqual({ total: 50, live: 0, cached: 0, stale: 0, unavailable: 50 });
    for (const row of response.rows) {
      expect(row.state).toBe("Unavailable");
      expect(row.price).toBeNull();
      expect(row.company).toBeNull();
    }
  });

  it("merges latest quotes with Core Universe and company names", async () => {
    const db = createApiDb({
      quotes: [quoteRow("AAPL", 232.5, NOW_ISO)],
      companies: [{ symbol: "AAPL", company: "Apple Inc." }],
      health: health(NOW_ISO),
    });
    const response = await readScreenerApi(envFrom(db), REGULAR);
    const apple = response.rows.find((row) => row.symbol === "AAPL")!;
    expect(apple.company).toBe("Apple Inc.");
    expect(apple.price).toBe(232.5);
    expect(apple.changePct).toBe(1.2);
    expect(apple.state).toBe("Live");
    expect(apple.asOf).toBe(NOW_ISO);
    expect(apple.updatedAt).toBe(NOW_ISO);
    expect(response.asOf).toBe(NOW_ISO);
    // Collector is not "Live" while coverage is incomplete (1 collected, 49
    // never-seen), matching the global-state honesty rule.
    expect(response.quotes.state).toBe("Stale");
    expect(response.quotes.provider).toBe("finnhub-quote");
    expect(response.quotes.counts).toEqual({ total: 50, live: 1, cached: 0, stale: 0, unavailable: 49 });
    // The other 49 rows stay present and honest.
    expect(response.rows.filter((row) => row.symbol !== "AAPL")).toHaveLength(49);
  });

  it("is NOT Live when exactly one of fifty is stale (49 fresh + 1 stale)", async () => {
    const staleAt = "2026-08-13T13:00:00.000Z"; // 1h old, in session
    const quotes = CORE_UNIVERSE.map((symbol, index) =>
      quoteRow(symbol, 100 + index, index === 0 ? staleAt : NOW_ISO));
    const db = createApiDb({ quotes, health: health(NOW_ISO) });
    const response = await readScreenerApi(envFrom(db), REGULAR);
    expect(response.quotes.state).toBe("Stale");
    expect(response.quotes.counts.live).toBe(49);
    expect(response.quotes.counts.stale).toBe(1);
    expect(response.quotes.counts.unavailable).toBe(0);
  });

  it("is NOT Live when ten of fifty are stale (40 fresh + 10 stale)", async () => {
    const staleAt = "2026-08-13T13:00:00.000Z";
    const quotes = CORE_UNIVERSE.map((symbol, index) =>
      quoteRow(symbol, 100 + index, index < 10 ? staleAt : NOW_ISO));
    const db = createApiDb({ quotes, health: health(NOW_ISO) });
    const response = await readScreenerApi(envFrom(db), REGULAR);
    expect(response.quotes.state).toBe("Stale");
    expect(response.quotes.counts.live).toBe(40);
    expect(response.quotes.counts.stale).toBe(10);
  });

  it("recovery: a refreshed shard returns the collector to Live", async () => {
    // First run: one stale symbol → Stale. Then the shard refreshes.
    const staleAt = "2026-08-13T13:00:00.000Z";
    const before = createApiDb({
      quotes: CORE_UNIVERSE.map((symbol, index) => quoteRow(symbol, 100 + index, index === 0 ? staleAt : NOW_ISO)),
      health: health(NOW_ISO),
    });
    expect((await readScreenerApi(envFrom(before), REGULAR)).quotes.state).toBe("Stale");

    const after = createApiDb({
      quotes: CORE_UNIVERSE.map((symbol, index) => quoteRow(symbol, 100 + index, NOW_ISO)),
      health: health(NOW_ISO),
    });
    const recovered = await readScreenerApi(envFrom(after), REGULAR);
    expect(recovered.quotes.state).toBe("Live");
    expect(recovered.quotes.counts.live).toBe(50);
  });

  it("keeps a previous-session quote serviceable (Cached) during the market-open grace", async () => {
    // Monday 09:35 ET with Friday-close quotes — no false stale, no outage.
    const quotes = CORE_UNIVERSE.map((symbol, index) => quoteRow(symbol, 100 + index, FRIDAY_CLOSE));
    const db = createApiDb({ quotes, health: health(FRIDAY_CLOSE) });
    const response = await readScreenerApi(envFrom(db), MONDAY_0935);
    expect(response.marketState).toBe("regular");
    expect(response.quotes.state).toBe("Cached"); // open, all cached (sweep not landed): not Live, not degraded
    expect(response.quotes.counts.cached).toBe(50);
    expect(response.quotes.counts.stale).toBe(0);
    expect(response.rows.every((row) => row.price !== null)).toBe(true);
  });

  it("reports the WebSocket ingestor as the global provider when its health record exists", async () => {
    // After the REST cron was removed, `quotesHealth` freezes on the last REST
    // run. The WebSocket ingestor's record is the live automatic collector.
    const db = createApiDb({
      quotes: CORE_UNIVERSE.map((symbol, index) => quoteRow(symbol, 100 + index, NOW_ISO)),
      health: health("2026-08-13T12:00:00.000Z"), // frozen REST record (older)
      wsHealth: {
        provider: "finnhub-websocket",
        connection_status: "connected",
        last_ws_heartbeat_at: NOW_ISO,
        updated_at: NOW_ISO,
        last_flush_at: NOW_ISO,
        last_successful_flush_at: NOW_ISO,
        last_error: null,
        last_flush_rows: 50,
      },
    });
    const response = await readScreenerApi(envFrom(db), REGULAR);
    expect(response.quotes.provider).toBe("finnhub-websocket");
    expect(response.quotes.lastSuccessAt).toBe(NOW_ISO);
    expect(response.quotes.state).toBe("Live");
    expect(response.asOf).toBe(NOW_ISO);
  });

  it("P2#1: inside the regular session a quiet symbol never demotes the collector", async () => {
    // WebSocket collector healthy (fresh heartbeat) + 49 symbols refreshed in
    // the session + ONE symbol with no trades for 21 minutes. The collector
    // must stay Live — a quiet stock is NOT a collector outage.
    const staleAt = isoAgo(21 * 60);
    const db = createApiDb({
      quotes: CORE_UNIVERSE.map((symbol, index) =>
        quoteRow(symbol, 100 + index, index === 0 ? staleAt : NOW_ISO)),
      wsHealth: wsHealthRow({ last_flush_rows: 49 }),
    });
    const response = await readScreenerApi(envFrom(db), REGULAR);
    expect(response.quotes.state).toBe("Live");
    expect(response.quotes.counts.stale).toBe(1);
    // The quiet symbol keeps its REAL last-trade timestamp (no fake freshness).
    const quiet = response.rows.find((row) => row.asOf === staleAt)!;
    expect(quiet.state).toBe("Stale");
    expect(quiet.asOf).toBe(staleAt);
    expect(quiet.price).not.toBeNull();
  });

  it("P2#1: after the session closes, a healthy collector reads Cached (not Live)", async () => {
    const postClose = new Date("2026-08-13T20:30:00Z"); // 16:30 ET, post_close window
    const db = createApiDb({
      quotes: CORE_UNIVERSE.map((symbol, index) => quoteRow(symbol, 100 + index, NOW_ISO)),
      wsHealth: wsHealthRow({
        last_ws_heartbeat_at: "2026-08-13T20:28:00.000Z",
        updated_at: "2026-08-13T20:28:00.000Z",
      }),
    });
    const response = await readScreenerApi(envFrom(db), postClose);
    expect(response.marketState).toBe("post_close");
    expect(response.quotes.state).toBe("Cached");
  });

  it("P2#1: 16:30 post_close — final-close rows are Cached, NOT Stale (global + per-row)", async () => {
    // Market closes 16:00 ET (20:00Z); WS ingestor stops writing after the
    // 5-min grace (~16:05 / 20:05Z). Query at 16:30 ET (20:30Z). Both the
    // global badge and every row must read Cached — no 50-row red wall.
    const lastWrite = "2026-08-17T20:05:00.000Z"; // 16:05 ET final flush
    const db = createApiDb({
      quotes: CORE_UNIVERSE.map((symbol, index) => quoteRow(symbol, 100 + index, lastWrite)),
      wsHealth: wsHealthRow({
        last_ws_heartbeat_at: "2026-08-17T20:28:00.000Z",
        updated_at: "2026-08-17T20:28:00.000Z",
      }),
    });
    const response = await readScreenerApi(envFrom(db), new Date("2026-08-17T20:30:00.000Z"));
    expect(response.marketState).toBe("post_close");
    expect(response.quotes.state).toBe("Cached");
    expect(response.quotes.counts).toEqual({ total: 50, live: 0, cached: 50, stale: 0, unavailable: 0 });
    expect(response.rows.every((row) => row.state === "Cached")).toBe(true);
  });

  it("P2#1: same Cached semantics on an early-close day (Black Friday)", async () => {
    // 2026-11-27 Black Friday: close 13:00 ET; last write 13:05 ET; query 13:30 ET.
    const bfLastWrite = "2026-11-27T18:05:00.000Z";
    const db = createApiDb({
      quotes: CORE_UNIVERSE.map((symbol, index) => quoteRow(symbol, 100 + index, bfLastWrite)),
      wsHealth: wsHealthRow({
        last_ws_heartbeat_at: "2026-11-27T18:28:00.000Z",
        updated_at: "2026-11-27T18:28:00.000Z",
      }),
    });
    const response = await readScreenerApi(envFrom(db), new Date("2026-11-27T18:30:00.000Z"));
    expect(response.marketState).toBe("post_close");
    expect(response.quotes.state).toBe("Cached");
    expect(response.rows.every((row) => row.state === "Cached")).toBe(true);
  });

  it("P2#2: Healthy WS with ZERO live rows during the regular session -> Cached (not Live)", async () => {
    // Pathological case: socket connected + fresh heartbeat but no per-row data
    // at all (subscriptions silently failed — Finnhub has no per-symbol ack).
    const db = createApiDb({
      quotes: CORE_UNIVERSE.map((symbol, index) => quoteRow(symbol, 100 + index, isoAgo(21 * 60))),
      wsHealth: wsHealthRow(),
    });
    const response = await readScreenerApi(envFrom(db), REGULAR);
    expect(response.quotes.state).toBe("Cached");
  });

  it("P2#2: Healthy WS with 1 live + 49 stale -> still Live (only zero-live degrades)", async () => {
    const db = createApiDb({
      quotes: CORE_UNIVERSE.map((symbol, index) =>
        quoteRow(symbol, 100 + index, index === 0 ? NOW_ISO : isoAgo(21 * 60))),
      wsHealth: wsHealthRow(),
    });
    const response = await readScreenerApi(envFrom(db), REGULAR);
    expect(response.quotes.counts.live).toBe(1);
    expect(response.quotes.state).toBe("Live");
  });

  it("P2#2: Healthy WS with 49 live + 1 stale -> Live (quiet symbols never degrade)", async () => {
    const db = createApiDb({
      quotes: CORE_UNIVERSE.map((symbol, index) =>
        quoteRow(symbol, 100 + index, index === 0 ? isoAgo(21 * 60) : NOW_ISO)),
      wsHealth: wsHealthRow(),
    });
    const response = await readScreenerApi(envFrom(db), REGULAR);
    expect(response.quotes.state).toBe("Live");
  });

  it("P2#2B: fresh heartbeat + connected -> collector Healthy (Live)", async () => {
    const db = createApiDb({
      quotes: CORE_UNIVERSE.map((symbol, index) => quoteRow(symbol, 100 + index, NOW_ISO)),
      wsHealth: wsHealthRow(),
    });
    const response = await readScreenerApi(envFrom(db), REGULAR);
    expect(response.quotes.state).toBe("Live");
  });

  it("P2#2B: heartbeat 3 min old -> Degraded -> Cached", async () => {
    const db = createApiDb({
      quotes: CORE_UNIVERSE.map((symbol, index) => quoteRow(symbol, 100 + index, NOW_ISO)),
      wsHealth: wsHealthRow({ last_ws_heartbeat_at: isoAgo(3 * 60), updated_at: isoAgo(3 * 60) }),
    });
    const response = await readScreenerApi(envFrom(db), REGULAR);
    expect(response.quotes.state).toBe("Cached");
  });

  it("P2#2B: heartbeat >5 min old -> Disconnected -> Stale", async () => {
    // The ingestor died without writing "disconnected": the Worker must still
    // detect the stale heartbeat and never report a dead collector as healthy.
    const db = createApiDb({
      quotes: CORE_UNIVERSE.map((symbol, index) => quoteRow(symbol, 100 + index, NOW_ISO)),
      wsHealth: wsHealthRow({ last_ws_heartbeat_at: isoAgo(6 * 60), updated_at: isoAgo(6 * 60) }),
    });
    const response = await readScreenerApi(envFrom(db), REGULAR);
    expect(response.quotes.state).toBe("Stale");
  });

  it("P2#2B: reconnecting with a fresh heartbeat -> Degraded -> Cached", async () => {
    const db = createApiDb({
      quotes: CORE_UNIVERSE.map((symbol, index) => quoteRow(symbol, 100 + index, NOW_ISO)),
      wsHealth: wsHealthRow({ connection_status: "reconnecting" }),
    });
    const response = await readScreenerApi(envFrom(db), REGULAR);
    expect(response.quotes.state).toBe("Cached");
  });

  it("falls back to the REST quotes health only when no WebSocket health exists yet", async () => {
    const db = createApiDb({ quotes: [quoteRow("AAPL", 232.5, NOW_ISO)], health: health(NOW_ISO) });
    const response = await readScreenerApi(envFrom(db), REGULAR);
    expect(response.quotes.provider).toBe("finnhub-quote");
  });

  it("reflects market-closed freshness (Cached, not Stale) over the weekend", async () => {
    const db = createApiDb({
      quotes: [quoteRow("AAPL", 230, FRIDAY_CLOSE)],
      health: health(FRIDAY_CLOSE),
    });
    const response = await readScreenerApi(envFrom(db), SATURDAY);
    expect(response.marketState).toBe("closed");
    const apple = response.rows.find((row) => row.symbol === "AAPL")!;
    expect(apple.state).toBe("Cached");
    expect(response.quotes.state).toBe("Cached");
  });

  it("serves the last known quote as Stale after a long in-session gap", async () => {
    const staleAt = "2026-08-13T13:00:00.000Z"; // 1 hour before now (in session)
    const db = createApiDb({
      quotes: [quoteRow("AAPL", 230, staleAt)],
      health: { provider: "finnhub-quote", status: "degraded", lastAttemptAt: staleAt, lastSuccessAt: staleAt, lastError: "AAPL: HTTP 500", rowsWritten: 0, lastShard: 0, rateLimited: false },
    });
    const response = await readScreenerApi(envFrom(db), REGULAR);
    const apple = response.rows.find((row) => row.symbol === "AAPL")!;
    expect(apple.state).toBe("Stale");
    expect(apple.price).toBe(230); // last known remains serviceable
    expect(response.quotes.state).toBe("Stale");
  });
});

describe("readScreenerApi — SMA200W fields (PR2)", () => {
  /** Metrics row for AAPL anchored 2026-08-14 (ISO W33), 19900 sum. */
  const metricsRow = (overrides: Record<string, unknown> = {}) => ({
    symbol: "AAPL",
    anchor_week: "2026-08-14",
    completed_weeks_available: 1200,
    sum_199: 19900,
    anchor_close: 100,
    closed_sma_200w: 100,
    historical_data_as_of: "2026-08-19T06:00:00.000Z",
    calculated_at: "2026-08-19T06:00:00.000Z",
    status: "ok",
    source: "alpha-vantage",
    ...overrides,
  });

  it("exposes SMA fields on every row, honest nulls when no data", async () => {
    const response = await readScreenerApi(envFrom(createApiDb({})), REGULAR);
    expect(response.rows).toHaveLength(50);
    for (const row of response.rows) {
      expect(row).toHaveProperty("sma200w", null);
      expect(row).toHaveProperty("distanceToSma200wPct", null);
      expect(row.sma200wState).toBe("Unavailable");
      expect(row.sma200wHistoryWeeks).toBeNull();
      expect(row.sma200wAsOf).toBeNull();
    }
  });

  it("computes the live SMA from metrics + latest quote (quote week after anchor)", async () => {
    const db = createApiDb({
      quotes: [quoteRow("AAPL", 110, "2026-08-19T15:00:00.000Z")], // W34
      metrics: [metricsRow()],
      wsHealth: wsHealthRow(),
    });
    const response = await readScreenerApi(envFrom(db), REGULAR);
    const apple = response.rows.find((row) => row.symbol === "AAPL")!;
    expect(apple.sma200w).toBeCloseTo((19900 + 110) / 200, 10); // 100.05
    expect(apple.distanceToSma200wPct).toBeCloseTo((110 / 100.05 - 1) * 100, 10);
    expect(apple.sma200wState).toBe("Above");
    expect(apple.sma200wHistoryWeeks).toBe(1200);
    expect(apple.sma200wAsOf).toBe("2026-08-19T06:00:00.000Z");
    // Other symbols keep honest nulls.
    const other = response.rows.find((row) => row.symbol === "MSFT")!;
    expect(other.sma200w).toBeNull();
    expect(other.sma200wState).toBe("Unavailable");
  });

  it("subtracts the anchor close when the quote's own week is stored (no double count)", async () => {
    const db = createApiDb({
      quotes: [quoteRow("AAPL", 100, "2026-08-14T19:30:00.000Z")], // W33 == anchor week, close == anchor_close
      metrics: [metricsRow()],
      wsHealth: wsHealthRow(),
    });
    const response = await readScreenerApi(envFrom(db), REGULAR);
    const apple = response.rows.find((row) => row.symbol === "AAPL")!;
    expect(apple.sma200w).toBeCloseTo((19900 - 100 + 100) / 200, 10); // 99.5
  });

  it("reports NotEnoughHistory when history < 199 weeks, regardless of quote", async () => {
    const db = createApiDb({
      quotes: [quoteRow("NBIS", 50, "2026-08-19T15:00:00.000Z")],
      metrics: [metricsRow({ symbol: "NBIS", completed_weeks_available: 90, sum_199: null, anchor_close: null, status: "not_enough_history" })],
      wsHealth: wsHealthRow(),
    });
    const response = await readScreenerApi(envFrom(db), REGULAR);
    const nbis = response.rows.find((row) => row.symbol === "NBIS")!;
    expect(nbis.sma200w).toBeNull();
    expect(nbis.distanceToSma200wPct).toBeNull();
    expect(nbis.sma200wState).toBe("NotEnoughHistory");
    expect(nbis.sma200wHistoryWeeks).toBe(90);
  });

  it("never fabricates a live SMA without a current quote", async () => {
    const db = createApiDb({
      metrics: [metricsRow()],
      wsHealth: wsHealthRow(),
    });
    const response = await readScreenerApi(envFrom(db), REGULAR);
    const apple = response.rows.find((row) => row.symbol === "AAPL")!;
    expect(apple.sma200w).toBeNull();
    expect(apple.sma200wState).toBe("Unavailable");
    expect(apple.sma200wHistoryWeeks).toBe(1200);
  });

  it("drops schema-invalid metrics rows defensively (no crash, honest nulls)", async () => {
    const db = createApiDb({
      quotes: [quoteRow("AAPL", 110, "2026-08-19T15:00:00.000Z")],
      metrics: [metricsRow({ sum_199: "not-a-number" })],
      wsHealth: wsHealthRow(),
    });
    const response = await readScreenerApi(envFrom(db), REGULAR);
    const apple = response.rows.find((row) => row.symbol === "AAPL")!;
    expect(apple.sma200w).toBeNull();
    expect(apple.sma200wState).toBe("Unavailable");
  });
});
