import { describe, expect, it } from "vitest";
import { readManualIntrinsicValues } from "./storage";

describe("readManualIntrinsicValues", () => {
  const rows = [
    { symbol: "AAPL", method: "manual", low_value: null, base_value: 251.12, high_value: null, as_of_date: "2026-08-03" },
    { symbol: "META", method: "manual", low_value: null, base_value: 906.66, high_value: null, as_of_date: "2026-08-03" },
    { symbol: "MSFT", method: "manual", low_value: null, base_value: 570.31, high_value: null, as_of_date: "2026-08-03" },
  ];

  function makeDb(result: { results: unknown[] } | Error) {
    return {
      prepare() {
        return {
          bind() { return this; },
          async all() {
            if (result instanceof Error) throw result;
            return result;
          },
        };
      },
    } as unknown as D1Database;
  }

  it("reads and groups IV rows by symbol", async () => {
    const map = await readManualIntrinsicValues(makeDb({ results: rows }));
    expect(map.size).toBe(3);
    expect(map.get("AAPL")?.values.base_value).toBe(251.12);
    expect(map.get("META")?.values.base_value).toBe(906.66);
    expect(map.get("MSFT")?.values.base_value).toBe(570.31);
    expect(map.get("AAPL")?.values.low_value).toBeNull();
    expect(map.get("AAPL")?.values.high_value).toBeNull();
    expect(map.get("AAPL")?.values.as_of_date).toBe("2026-08-03");
    expect(map.get("AAPL")?.values.method).toBe("manual");
  });

  it("skips invalid rows defensively", async () => {
    const mixed = [
      ...rows,
      { symbol: "BAD", method: "manual", low_value: -5, base_value: 100, high_value: null, as_of_date: "2026-08-03" },
      { symbol: "AAA", method: "manual", low_value: 200, base_value: 100, high_value: null, as_of_date: "2026-08-03" }, // low > base
    ];
    const map = await readManualIntrinsicValues(makeDb({ results: mixed }));
    expect(map.size).toBe(3);
    expect(map.has("BAD")).toBe(false);
    expect(map.has("AAA")).toBe(false);
  });

  it("returns empty map on DB failure (never fatal)", async () => {
    const map = await readManualIntrinsicValues(makeDb(new Error("D1 error")));
    expect(map.size).toBe(0);
  });

  it("returns empty map for empty result set", async () => {
    const map = await readManualIntrinsicValues(makeDb({ results: [] }));
    expect(map.size).toBe(0);
  });
});
