import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../index";
// @ts-expect-error -- Vite resolves test-only ?raw imports; Worker typecheck intentionally has no Vite client types.
import storageSource from "./storage.ts?raw";

const storageMock = vi.hoisted(() => ({
  readStockDetailStorageSnapshot: vi.fn(),
  persistSplitScaleMismatch: vi.fn(),
}));

vi.mock("./storage", () => ({
  ...storageMock,
  STOCK_DETAIL_VISIBLE_WEEKS: 260,
}));

import { readStockDetailApi } from "./read-model";

const env = { DB: {} as D1Database } as Env;
const NOW = new Date("2026-08-21T15:00:00.000Z");

describe("Stock Detail persisted company metadata", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storageMock.readStockDetailStorageSnapshot.mockResolvedValue({
      company: {
        symbol: "MSFT",
        company: "Microsoft Corporation",
        logo_url: "https://example.com/msft.png",
        exchange: " NASDAQ ",
        industry: " Software - Infrastructure ",
      },
      quote: null,
      metric: null,
      supports: undefined,
      intrinsicValue: undefined,
      fundamentals: null,
      weeklyRows: [],
      splitEvents: [],
    });
  });

  it("selects exchange and industry from the active earnings universe row", () => {
    expect(storageSource).toContain("u.logo_url, u.exchange, u.industry");
    expect(storageSource).toContain("FROM earnings_universe AS u");
  });

  it("maps persisted exchange and industry into the public company response", async () => {
    const detail = await readStockDetailApi(env, "MSFT", NOW);

    expect(detail.company).toEqual({
      name: "Microsoft Corporation",
      exchange: "NASDAQ",
      sector: "Software - Infrastructure",
      logoUrl: "https://example.com/msft.png",
    });
  });
});
