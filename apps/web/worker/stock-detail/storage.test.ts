import { describe, expect, it } from "vitest";
// @ts-expect-error -- Vite resolves test-only ?raw imports; Worker typecheck intentionally has no Vite client types.
import storageSource from "./storage.ts?raw";
import {
  readStockDetailCompany,
  readStockDetailQuote,
  readStockDetailSplitEvents,
  readStockDetailStorageSnapshot,
  readStockDetailSupports,
  readStockDetailWeeklyHistory,
  clearQuoteHistoryScaleMismatch,
  persistSplitScaleMismatch,
  SPLIT_RECOVERY_META_PREFIX,
  SPLIT_SERVING_STATE_META_PREFIX,
  STOCK_DETAIL_HISTORY_LIMIT,
} from "./storage";

interface DbCalls {
  sql: string[];
  binds: unknown[][];
}

function createDb(options: { first?: unknown; rows?: unknown[]; throwOnPrepare?: boolean } = {}) {
  const calls: DbCalls = { sql: [], binds: [] };
  const statement = {
    bind(...values: unknown[]) {
      calls.binds.push(values);
      return statement;
    },
    async first<T>() {
      return (options.first ?? null) as T | null;
    },
    async all<T>() {
      return { results: (options.rows ?? []) as T[] };
    },
  };
  const db = {
    prepare(sql: string) {
      if (options.throwOnPrepare) throw new Error("D1 unavailable");
      calls.sql.push(sql);
      return statement;
    },
  } as unknown as D1Database;
  return { db, calls };
}

function createBatchDb(
  resultRows: unknown[][],
  firstResult: unknown | unknown[] = null,
  changes: number[] = [],
) {
  const calls: DbCalls = { sql: [], binds: [] };
  let firstCall = 0;
  const statement = {
    bind(...values: unknown[]) {
      calls.binds.push(values);
      return statement;
    },
    async first<T>() {
      const result = Array.isArray(firstResult) ? firstResult[firstCall++] : firstResult;
      return result as T | null;
    },
  };
  const db = {
    prepare(sql: string) {
      calls.sql.push(sql);
      return statement;
    },
    async batch(statements: unknown[]) {
      if (statements.length !== resultRows.length) {
        throw new Error(`batch fixture has ${resultRows.length} results for ${statements.length} statements`);
      }
      return resultRows.map((results, index) => ({
        results,
        meta: { changes: changes[index] ?? 0 },
      }));
    },
  } as unknown as D1Database;
  return { db, calls };
}

describe("Stock Detail symbol-specific storage", () => {
  it("uses the weekly_prices PK prefix, explicit DESC order and 459-row bound", async () => {
    const { db, calls } = createDb({ rows: [] });
    await readStockDetailWeeklyHistory(db, "MSFT");
    expect(STOCK_DETAIL_HISTORY_LIMIT).toBe(459);
    expect(calls.sql[0]).toContain("FROM weekly_prices");
    expect(calls.sql[0]).toContain("WHERE symbol = ?");
    expect(calls.sql[0]).toContain("ORDER BY week_end_date DESC");
    expect(calls.sql[0]).toContain("LIMIT ?");
    expect(calls.binds[0]).toEqual(["MSFT", 459]);
  });

  it("binds symbol for company reads rather than interpolating it into SQL", async () => {
    const { db, calls } = createDb({
      first: { symbol: "MSFT", company: "Microsoft Corporation", logo_url: "https://example.com/msft.png" },
    });
    const row = await readStockDetailCompany(db, "MSFT");
    expect(row?.company).toBe("Microsoft Corporation");
    expect(calls.sql[0]).toContain("u.symbol = ?");
    expect(calls.sql[0]).not.toContain("MSFT");
    expect(calls.binds[0]).toEqual(["MSFT"]);
  });

  it("fails closed when a configured symbol is not active in the runtime Core universe", async () => {
    const staleQuote = {
      symbol: "MSFT",
      price: 500,
      change_abs: 5,
      change_pct: 1,
      day_high: null,
      day_low: null,
      day_open: null,
      previous_close: 495,
      provider: "finnhub-websocket",
      provider_timestamp: "2026-08-21T15:00:00.000Z",
      updated_at: "2026-08-21T15:00:05.000Z",
    };
    const { db, calls } = createBatchDb([
      [],
      [staleQuote],
      [],
      [],
      [],
      [],
      [],
      [],
      [],
      [],
      [],
    ]);

    await expect(readStockDetailStorageSnapshot(db, "MSFT")).rejects.toThrow("stock_not_found");
    expect(calls.sql[0]).toContain("FROM earnings_universe AS u");
    expect(calls.sql[0]).toContain("u.active = 1");
    expect(calls.sql[0]).toContain("u.source = 'core'");
    expect(calls.binds[0]).toEqual(["MSFT"]);
  });

  it("treats a malformed/negative persisted quote as absent, never as $0 or mock data", async () => {
    const { db } = createDb({
      first: {
        symbol: "MSFT",
        price: -1,
        change_abs: 0,
        change_pct: 0,
        provider: "finnhub",
        provider_timestamp: "2026-08-21T15:00:00.000Z",
        updated_at: "2026-08-21T15:00:00.000Z",
      },
    });
    await expect(readStockDetailQuote(db, "MSFT")).resolves.toBeNull();
  });

  it("accepts a legacy quote row before session metadata migration", async () => {
    const { db } = createDb({
      first: {
        symbol: "MSFT",
        price: 500,
        change_abs: 5,
        change_pct: 1,
        provider: "finnhub",
        provider_timestamp: "2026-08-21T15:00:00.000Z",
        updated_at: "2026-08-21T15:00:00.000Z",
      },
    });
    await expect(readStockDetailQuote(db, "MSFT")).resolves.toMatchObject({ price: 500 });
  });

  it("uses the fundamentals-only company fallback only for preview validation", async () => {
    const { db, calls } = createDb({ first: { symbol: "AMZN", company: "AMZN", logo_url: null } });
    await expect(readStockDetailCompany(db, "AMZN", "preview")).resolves.toMatchObject({ symbol: "AMZN" });
    expect(calls.sql[0]).toContain("FROM stock_fundamentals_snapshot");
    expect(calls.sql[0]).not.toContain("earnings_universe");
  });

  it("returns partial support rows and discards malformed levels", async () => {
    const { db } = createDb({
      rows: [
        { symbol: "MSFT", method: "manual", level: 1, price: 450, as_of_date: "2026-08-03" },
        { symbol: "MSFT", method: "manual", level: 9, price: 100, as_of_date: "2026-08-03" },
      ],
    });
    const supports = await readStockDetailSupports(db, "MSFT");
    expect(supports?.levels.map((level) => level.level)).toEqual([1]);
  });

  it("reads effective dates and split factors with one symbol-bound PK scan", async () => {
    const { db, calls } = createDb({
      rows: [
        { effective_date: "2020-08-31", split_factor: 2 },
        { effective_date: "2026-06-15", split_factor: 4 },
        { effective_date: "malformed", split_factor: 3 },
        { effective_date: "2026-07-01", split_factor: 0 },
      ],
    });
    const splits = await readStockDetailSplitEvents(db, "MSFT");
    expect(splits).toEqual([
      { effective_date: "2020-08-31", split_factor: 2 },
      { effective_date: "2026-06-15", split_factor: 4 },
    ]);
    expect(calls.sql[0]).toContain("SELECT effective_date, split_factor");
    expect(calls.sql[0]).toContain("FROM split_events");
    expect(calls.sql[0]).toContain("WHERE symbol = ?");
    expect(calls.sql[0]).toContain("ORDER BY effective_date ASC");
    expect(calls.binds[0]).toEqual(["MSFT"]);
  });

  it("propagates D1 failures so the route can return 503 instead of pretending data is absent", async () => {
    const { db } = createDb({ throwOnPrepare: true });
    await expect(readStockDetailCompany(db, "MSFT")).rejects.toThrow("D1 unavailable");
  });

  it("only treats an empty split history as verified when reconciliation says so", async () => {
    const { db, calls } = createBatchDb([
      [{ symbol: "MSFT", company: "Microsoft Corporation", logo_url: null }],
      [], [], [], [], [], [],
      [{ value: JSON.stringify({ version: 1, symbol: "MSFT", status: "done" }) }],
      [],
      [],
      [],
    ]);
    const snapshot = await readStockDetailStorageSnapshot(db, "MSFT");
    expect(snapshot.splitHistoryVerified).toBe(true);
    expect(calls.binds).toContainEqual(["historyReconcileSplitStatus:MSFT"]);
  });

  it("uses the legacy completed checkpoint only until a per-symbol marker exists", async () => {
    const { db, calls } = createBatchDb([
      [{ symbol: "MSFT", company: "Microsoft Corporation", logo_url: null }],
      [], [], [], [], [], [],
      [],
      [],
      [],
      [],
    ], { value: JSON.stringify({ version: 1, splits: { MSFT: "done" } }) });
    const snapshot = await readStockDetailStorageSnapshot(db, "MSFT");
    expect(snapshot.splitHistoryVerified).toBe(true);
    expect(calls.binds).toContainEqual(["historyReconcileSplitState"]);
  });

  it("does not let a pending per-symbol marker fall back to legacy verification", async () => {
    const { db, calls } = createBatchDb([
      [{ symbol: "MSFT", company: "Microsoft Corporation", logo_url: null }],
      [], [], [], [], [], [],
      [{ value: JSON.stringify({ version: 1, symbol: "MSFT", status: "pending" }) }],
      [],
      [],
      [],
    ]);
    const snapshot = await readStockDetailStorageSnapshot(db, "MSFT");
    expect(snapshot.splitHistoryVerified).toBe(false);
    expect(calls.binds).not.toContainEqual(["historyReconcileSplitState"]);
  });

  it("recognizes a terminal bootstrap checkpoint while markers are rolling out", async () => {
    const { db, calls } = createBatchDb([
      [{ symbol: "MSFT", company: "Microsoft Corporation", logo_url: null }],
      [], [], [], [], [], [], [], [],
      [],
      [],
    ], [
      null,
      { value: JSON.stringify({ version: 1, symbols: { MSFT: { splits: "done", weekly: "done" } } }) },
    ]);
    const snapshot = await readStockDetailStorageSnapshot(db, "MSFT");
    expect(snapshot.splitHistoryVerified).toBe(true);
    expect(calls.binds).toContainEqual(["historyBootstrapState"]);
  });

  it("parses authoritative BLOCKED serving state from the tenth batch result", async () => {
    const { db } = createBatchDb([
      [{ symbol: "MSFT", company: "Microsoft Corporation", logo_url: null }],
      [], [], [], [], [], [], [], [],
      [{ value: JSON.stringify({
        version: 1,
        symbol: "MSFT",
        state: "BLOCKED",
        reason: "unexpected_scale_mismatch",
      }) }],
      [],
    ]);
    const snapshot = await readStockDetailStorageSnapshot(db, "MSFT");
    expect(snapshot.servingState).toEqual({
      state: "BLOCKED",
      reason: "unexpected_scale_mismatch",
    });
  });

  it("parses the durable recovery state from the eleventh batch result", async () => {
    const { db, calls } = createBatchDb([
      [{ symbol: "MSFT", company: "Microsoft Corporation", logo_url: null }],
      [], [], [], [], [], [], [], [], [],
      [{ value: JSON.stringify({
        version: 1,
        symbol: "MSFT",
        status: "retry",
      }) }],
    ]);
    const snapshot = await readStockDetailStorageSnapshot(db, "MSFT");
    expect(snapshot.recoveryState).toEqual({ status: "retry" });
    expect(calls.binds).toContainEqual(["historySplitRecovery:MSFT"]);
  });

  it("fails closed for a present malformed serving-state value", async () => {
    const { db } = createBatchDb([
      [{ symbol: "MSFT", company: "Microsoft Corporation", logo_url: null }],
      [], [], [], [], [], [], [], [],
      [{ value: "not-json" }],
      [],
    ]);
    const snapshot = await readStockDetailStorageSnapshot(db, "MSFT");
    expect(snapshot.servingState).toEqual({
      state: "BLOCKED",
      reason: "invalid_serving_state",
    });
  });

  it("fails closed for a legacy split marker without the current version", async () => {
    const { db } = createBatchDb([
      [{ symbol: "MSFT", company: "Microsoft Corporation", logo_url: null }],
      [], [], [], [], [], [],
      [{ value: JSON.stringify({ symbol: "MSFT", status: "done" }) }],
      [], [], [],
    ]);
    const snapshot = await readStockDetailStorageSnapshot(db, "MSFT");
    expect(snapshot.splitHistoryVerified).toBe(false);
    expect(snapshot.splitHistoryStatus).toBe("error");
  });

  it("persists BLOCKED and one idempotent recovery request in one D1 batch", async () => {
    const { db, calls } = createBatchDb([[], []]);
    await persistSplitScaleMismatch(db, "NVDA", "unexpected_scale_mismatch", "2026-08-21T15:00:00.000Z");
    expect(calls.binds).toContainEqual([
      `${SPLIT_SERVING_STATE_META_PREFIX}NVDA`,
      expect.stringContaining('"state":"BLOCKED"'),
    ]);
    expect(calls.binds).toContainEqual([
      `${SPLIT_RECOVERY_META_PREFIX}NVDA`,
      expect.stringContaining('"status":"pending"'),
    ]);
    expect(calls.sql.some((sql) => sql.includes("json_set") && sql.includes("$.attempts"))).toBe(true);
  });

  it("atomically clears only a completed quote-only block", async () => {
    const { db, calls } = createBatchDb([[], []], null, [1, 1]);

    await expect(clearQuoteHistoryScaleMismatch(
      db,
      "NVDA",
      "2026-08-21T15:00:00.000Z",
    )).resolves.toBe(true);

    expect(calls.sql[0]).toContain("DELETE FROM app_meta");
    expect(calls.sql[1]).toContain("UPDATE app_meta");
    expect(calls.sql[1]).toContain("quote_history_scale_mismatch");
    expect(calls.binds[1]).toEqual([
      expect.stringContaining('"state":"READY"'),
      `${SPLIT_SERVING_STATE_META_PREFIX}NVDA`,
      `${SPLIT_RECOVERY_META_PREFIX}NVDA`,
    ]);
  });

  it("contains no provider/network request path", () => {
    expect(storageSource).not.toMatch(/\bfetch\s*\(/);
    expect(storageSource).not.toContain("FINNHUB_API_KEY");
    expect(storageSource).not.toContain("ALPHA_VANTAGE");
  });
});
