import { describe, expect, it } from "vitest";
import { readManualSupportLevels } from "../supports/storage";

function createDb(rows: unknown[], throwOnPrepare = false) {
  const statement = {
    bind: () => statement,
    async all() {
      return { results: rows };
    },
  };
  return {
    prepare() {
      if (throwOnPrepare) throw new Error("table missing");
      return statement;
    },
  } as unknown as D1Database;
}

describe("readManualSupportLevels", () => {
  it("groups and orders support levels by symbol (S1 -> S4)", async () => {
    const rows = [
      { symbol: "META", method: "manual", level: 1, price: 635, as_of_date: "2026-08-03" },
      { symbol: "META", method: "manual", level: 2, price: 580, as_of_date: "2026-08-03" },
      { symbol: "META", method: "manual", level: 3, price: 532, as_of_date: "2026-08-03" },
      { symbol: "META", method: "manual", level: 4, price: 481, as_of_date: "2026-08-03" },
    ];
    const grouped = await readManualSupportLevels(createDb(rows));
    const meta = grouped.get("META");
    expect(meta).toBeDefined();
    expect(meta!.levels.map((l) => l.level)).toEqual([1, 2, 3, 4]);
    expect(meta!.levels.map((l) => l.price)).toEqual([635, 580, 532, 481]);
  });

  it("returns only levels 1-4", async () => {
    const rows = [
      { symbol: "AAPL", method: "manual", level: 1, price: 246, as_of_date: "2026-08-03" },
      { symbol: "AAPL", method: "manual", level: 2, price: 228, as_of_date: "2026-08-03" },
    ];
    const grouped = await readManualSupportLevels(createDb(rows));
    const levels = grouped.get("AAPL")!.levels;
    expect(levels.every((l) => l.level >= 1 && l.level <= 4)).toBe(true);
  });

  it("skips invalid rows (negative price, bad level, malformed as_of_date)", async () => {
    const rows = [
      { symbol: "AAPL", method: "manual", level: 1, price: 246, as_of_date: "2026-08-03" },
      { symbol: "AAPL", method: "manual", level: 5, price: 100, as_of_date: "2026-08-03" }, // invalid level
      { symbol: "AAPL", method: "manual", level: 2, price: -10, as_of_date: "2026-08-03" }, // invalid price
      { symbol: "AAPL", method: "manual", level: 3, price: 212, as_of_date: "not-a-date" }, // malformed date
      { symbol: "AAPL", method: "manual", level: 4, price: 196, as_of_date: "2026-08-03" },
    ];
    const grouped = await readManualSupportLevels(createDb(rows));
    const levels = grouped.get("AAPL")!.levels;
    expect(levels.map((l) => l.level)).toEqual([1, 4]);
  });

  it("returns empty for a symbol with no supports", async () => {
    const rows = [
      { symbol: "META", method: "manual", level: 1, price: 635, as_of_date: "2026-08-03" },
    ];
    const grouped = await readManualSupportLevels(createDb(rows));
    expect(grouped.get("AAPL")).toBeUndefined();
    expect(grouped.size).toBe(1);
  });

  it("returns empty map when table is unavailable (no fatal throw)", async () => {
    const grouped = await readManualSupportLevels(createDb([], true));
    expect(grouped.size).toBe(0);
  });

  it("skips rows with malformed symbol or method", async () => {
    const rows = [
      { symbol: "", method: "manual", level: 1, price: 100, as_of_date: "2026-08-03" },
      { symbol: "AAPL", method: "", level: 1, price: 100, as_of_date: "2026-08-03" },
      { symbol: "AAPL", method: "manual", level: 1, price: 100, as_of_date: "2026-08-03" },
    ];
    const grouped = await readManualSupportLevels(createDb(rows));
    expect(grouped.size).toBe(1);
    expect(grouped.get("AAPL")).toBeDefined();
  });

  it("handles duplicate levels (DB returns two rows with same level)", async () => {
    const rows = [
      { symbol: "META", method: "manual", level: 1, price: 635, as_of_date: "2026-08-03" },
      { symbol: "META", method: "manual", level: 1, price: 600, as_of_date: "2026-08-03" }, // duplicate
      { symbol: "META", method: "manual", level: 2, price: 580, as_of_date: "2026-08-03" },
    ];
    const grouped = await readManualSupportLevels(createDb(rows));
    const meta = grouped.get("META")!;
    // Both rows are valid and pass through; the contract max(4) handles overflow
    expect(meta.levels).toHaveLength(3);
  });

  it("rejects as_of_date that does not match YYYY-MM-DD", async () => {
    const rows = [
      { symbol: "AAPL", method: "manual", level: 1, price: 246, as_of_date: "2026/08/03" },
      { symbol: "AAPL", method: "manual", level: 2, price: 228, as_of_date: "03-08-2026" },
      { symbol: "AAPL", method: "manual", level: 3, price: 212, as_of_date: "today" },
    ];
    const grouped = await readManualSupportLevels(createDb(rows));
    expect(grouped.size).toBe(0);
  });
});
