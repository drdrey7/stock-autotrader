import { describe, expect, it } from "vitest";
import type { EarningsEngineEvent } from "@stock-autotrader/contracts";
import {
  readEarningsMonitoringEvents,
  rotateEarningsMonitoringEvents,
  SEC_FILING_ROTATION_CURSOR_KEY,
  type Database,
} from "./storage";

const event = (symbol: string): EarningsEngineEvent => ({
  id: `${symbol}-2026-Q2`,
  symbol,
} as EarningsEngineEvent);

const key = (value: EarningsEngineEvent): string => `${value.symbol}\u0000${value.id}`;

class MemoryStatement {
  private args: unknown[] = [];

  constructor(
    private readonly sql: string,
    private readonly rows: Array<Record<string, unknown>>,
    private readonly meta: Map<string, string>,
    private readonly failMetaWrites: boolean,
  ) {}

  bind(...args: unknown[]): this {
    this.args = args;
    return this;
  }

  async all<T>(): Promise<{ results: T[] }> {
    if (this.sql.includes("FROM earnings_events AS e")) return { results: this.rows as T[] };
    throw new Error(`Unhandled all SQL: ${this.sql}`);
  }

  async first<T>(): Promise<T | null> {
    if (this.sql.includes("SELECT value FROM app_meta WHERE key = ?")) {
      const value = this.meta.get(String(this.args[0]));
      return (value === undefined ? null : { value }) as T | null;
    }
    throw new Error(`Unhandled first SQL: ${this.sql}`);
  }

  async run(): Promise<{ success: true; meta: { changes: number } }> {
    if (this.sql.startsWith("INSERT INTO app_meta")) {
      if (this.failMetaWrites) throw new Error("transient D1 app_meta write failure");
      this.meta.set(String(this.args[0]), String(this.args[1]));
      return { success: true, meta: { changes: 1 } };
    }
    throw new Error(`Unhandled run SQL: ${this.sql}`);
  }
}

class MemoryDb {
  readonly meta = new Map<string, string>();

  constructor(
    private readonly rows: Array<Record<string, unknown>>,
    private readonly failMetaWrites = false,
  ) {}

  prepare(sql: string): MemoryStatement {
    return new MemoryStatement(sql, this.rows, this.meta, this.failMetaWrites);
  }
}

describe("SEC filing monitoring rotation", () => {
  const events = ["AAPL", "AMD", "AMZN", "AVGO", "CRM", "GOOG", "META", "MSFT", "NFLX", "NOW", "NVDA", "ORCL", "PLTR", "SHOP", "TSLA", "UBER", "V", "WMT", "XOM", "ZM"].map(event);

  it("keeps the deterministic base order when no cursor exists", () => {
    expect(rotateEarningsMonitoringEvents(events, null).map((item) => item.symbol)).toEqual(events.map((item) => item.symbol));
  });

  it("starts after the previous cursor and wraps without dropping or duplicating events", () => {
    const rotated = rotateEarningsMonitoringEvents(events, key(events[15]!));
    expect(rotated.slice(0, 4).map((item) => item.symbol)).toEqual(["V", "WMT", "XOM", "ZM"]);
    expect(rotated).toHaveLength(events.length);
    expect(new Set(rotated.map((item) => item.id)).size).toBe(events.length);
    expect(rotated.at(-1)?.symbol).toBe("UBER");
  });

  it("continues lexically when the exact cursor event disappeared", () => {
    const removed = events.filter((item) => item.symbol !== "MSFT");
    const cursor = "MSFT\u0000MSFT-2026-Q2";
    const rotated = rotateEarningsMonitoringEvents(removed, cursor);
    expect(rotated[0]?.symbol).toBe("NFLX");
  });

  it("wraps back to the beginning after the final candidate", () => {
    const rotated = rotateEarningsMonitoringEvents(events, key(events.at(-1)!));
    expect(rotated[0]?.symbol).toBe("AAPL");
  });

  it("persists the cursor so successive monitor reads advance the priority window", async () => {
    const db = new MemoryDb(events.map((item) => ({ id: item.id, symbol: item.symbol }))) as unknown as Database;

    const first = await readEarningsMonitoringEvents(db, "2026-08-17");
    const second = await readEarningsMonitoringEvents(db, "2026-08-17");
    const third = await readEarningsMonitoringEvents(db, "2026-08-17");

    expect(first[0]?.symbol).toBe("AAPL");
    expect(second[0]?.symbol).toBe("AMD");
    expect(third[0]?.symbol).toBe("AMZN");
    expect((db as unknown as MemoryDb).meta.get(SEC_FILING_ROTATION_CURSOR_KEY)).toBe(key(events[2]!));
  });

  it("keeps the monitor usable when best-effort cursor persistence fails", async () => {
    const db = new MemoryDb(
      events.map((item) => ({ id: item.id, symbol: item.symbol })),
      true,
    ) as unknown as Database;

    await expect(readEarningsMonitoringEvents(db, "2026-08-17"))
      .resolves.toEqual(expect.arrayContaining([expect.objectContaining({ symbol: "AAPL" })]));
    expect((db as unknown as MemoryDb).meta.has(SEC_FILING_ROTATION_CURSOR_KEY)).toBe(false);
  });
});
