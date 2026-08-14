import { describe, expect, it } from "vitest";
import { CORE_UNIVERSE, CORE_UNIVERSE_VERSION } from "@stock-autotrader/contracts";
import { reconcileAndVerifyCoreUniverse } from "../bootstrap";
import { reconcileCoreUniverse, readTrackedUniverse } from "./storage";

type Row = Record<string, unknown>;

class SyncStatement {
  private args: unknown[] = [];

  constructor(private readonly db: SyncDb, private readonly sql: string) {}

  bind(...args: unknown[]): this {
    this.args = args;
    return this;
  }

  async run(): Promise<{ meta: { changes: number } }> {
    if (this.sql.includes("SET active = 0")) {
      const [version, removedAt, updatedAt, ...desiredSymbols] = this.args;
      const desired = new Set(desiredSymbols.map(String));
      for (const row of this.db.rows.values()) {
        if (row.source === "core" && (row.active === 1 || row.removed_at == null) && !desired.has(String(row.symbol))) {
          row.active = 0;
          row.universe_version = version;
          row.removed_at = row.removed_at ?? removedAt;
          row.updated_at = updatedAt;
        }
      }
      return { meta: { changes: 1 } };
    }
    if (this.sql.includes("INSERT INTO earnings_universe")) {
      const [symbol, company, version, addedAt, updatedAt] = this.args;
      const old = this.db.rows.get(String(symbol));
      this.db.rows.set(String(symbol), {
        ...old,
        symbol,
        company: old?.company ?? company,
        active: 1,
        source: "core",
        universe_version: version,
        added_at: old?.added_at ?? addedAt,
        removed_at: null,
        updated_at: updatedAt,
      });
      return { meta: { changes: 1 } };
    }
    throw new Error(`Unhandled sync SQL: ${this.sql}`);
  }

  async all<T>(): Promise<{ results: T[] }> {
    if (!this.sql.includes("FROM earnings_universe")) throw new Error(`Unhandled sync SQL: ${this.sql}`);
    return { results: [...this.db.rows.values()] as T[] };
  }
}

class SyncDb {
  readonly rows = new Map<string, Row>();
  readonly historicalEarnings = [{ id: "legacy-abnb-event", symbol: "ABNB" }];

  prepare(sql: string): D1PreparedStatement {
    return new SyncStatement(this, sql) as unknown as D1PreparedStatement;
  }

  async batch(statements: SyncStatement[]): Promise<{ meta: { changes: number } }[]> {
    const results: { meta: { changes: number } }[] = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }
}

describe("Core Universe D1 reconciliation", () => {
  it("repairs migration-inactive production rows immediately without a provider", async () => {
    const db = new SyncDb();
    for (const symbol of [...CORE_UNIVERSE, "ABNB"]) {
      db.rows.set(symbol, {
        symbol,
        company: symbol,
        active: 0,
        source: "core",
        universe_version: 0,
        added_at: "2026-08-14T14:08:55.384Z",
        removed_at: null,
        updated_at: "2026-08-14T14:08:55.384Z",
      });
    }

    const health = await reconcileAndVerifyCoreUniverse(
      { DB: db } as never,
      "2026-08-14T21:40:00.000Z",
    );

    expect(health).toMatchObject({ activeCount: 50, expectedCount: 50, universeVersion: 1, initialized: true });
    expect((await readTrackedUniverse(db as never)).find((row) => row.symbol === "ABNB")).toMatchObject({
      active: false,
      universeVersion: 1,
    });
    expect(db.historicalEarnings).toEqual([{ id: "legacy-abnb-event", symbol: "ABNB" }]);
  });

  it("activates all Core v1 members and deactivates the old index-only member without deleting history", async () => {
    const db = new SyncDb();
    db.rows.set("ABNB", {
      symbol: "ABNB",
      company: "Airbnb",
      active: 1,
      source: "core",
      universe_version: 0,
      added_at: "2026-08-01T00:00:00.000Z",
      removed_at: null,
      updated_at: "2026-08-01T00:00:00.000Z",
    });
    await reconcileCoreUniverse(db as never, CORE_UNIVERSE, CORE_UNIVERSE_VERSION, "2026-08-14T06:00:00.000Z");

    const rows = await readTrackedUniverse(db as never);
    const active = rows.filter((row) => row.active);
    const removed = rows.find((row) => row.symbol === "ABNB")!;
    expect(active).toHaveLength(50);
    expect(active.every((row) => row.source === "core" && row.universeVersion === 1)).toBe(true);
    expect(removed).toMatchObject({ active: false, source: "core", universeVersion: 1, removedAt: "2026-08-14T06:00:00.000Z" });
    expect(db.historicalEarnings).toEqual([{ id: "legacy-abnb-event", symbol: "ABNB" }]);
  });

  it("is idempotent and preserves added_at for existing and re-added members", async () => {
    const db = new SyncDb();
    await reconcileCoreUniverse(db as never, ["AAPL", "MSFT"], 1, "2026-08-14T06:00:00.000Z");
    const first = await readTrackedUniverse(db as never);
    await reconcileCoreUniverse(db as never, ["AAPL", "MSFT"], 1, "2026-08-14T06:00:00.000Z");
    expect(await readTrackedUniverse(db as never)).toEqual(first);

    await reconcileCoreUniverse(db as never, ["AAPL"], 1, "2026-08-15T06:00:00.000Z");
    const removed = (await readTrackedUniverse(db as never)).find((row) => row.symbol === "MSFT")!;
    expect(removed).toMatchObject({ active: false, addedAt: "2026-08-14T06:00:00.000Z", removedAt: "2026-08-15T06:00:00.000Z" });

    await reconcileCoreUniverse(db as never, ["AAPL", "MSFT"], 1, "2026-08-16T06:00:00.000Z");
    const readded = (await readTrackedUniverse(db as never)).find((row) => row.symbol === "MSFT")!;
    expect(readded).toMatchObject({ active: true, addedAt: "2026-08-14T06:00:00.000Z", removedAt: null, updatedAt: "2026-08-16T06:00:00.000Z" });
  });

  it("supports a newly configured valid symbol without changing the sync code", async () => {
    const db = new SyncDb();
    await reconcileCoreUniverse(db as never, ["AAPL", "TEST"], 2, "2026-08-14T06:00:00.000Z");
    expect((await readTrackedUniverse(db as never)).find((row) => row.symbol === "TEST")).toMatchObject({
      active: true,
      source: "core",
      universeVersion: 2,
    });
  });

  it("rejects duplicates and malformed symbols instead of normalizing them", async () => {
    const db = new SyncDb();
    await expect(reconcileCoreUniverse(db as never, ["AAPL", "AAPL"], 1, "2026-08-14T06:00:00.000Z")).rejects.toThrow(/Duplicate/);
    await expect(reconcileCoreUniverse(db as never, ["aapl"], 1, "2026-08-14T06:00:00.000Z")).rejects.toThrow(/Invalid/);
  });
});
