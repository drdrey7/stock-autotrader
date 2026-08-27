import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../index";

vi.mock("./storage", () => ({ readLatestQuotes: vi.fn() }));
vi.mock("./health", () => ({
  collectorStateFromWsHealth: vi.fn(() => "Unavailable"),
  readQuotesHealth: vi.fn(async () => null),
  readWsIngestorHealth: vi.fn(async () => null),
}));
vi.mock("../sma/storage", () => ({
  readEffectiveSplitEventsAsOf: vi.fn(),
  readLatestSplitEffectiveDate: vi.fn(),
  readLatestSplitEffectiveDateAsOf: vi.fn(),
  readTechnicalMetrics: vi.fn(),
}));
vi.mock("../supports/storage", () => ({ readManualSupportLevels: vi.fn() }));
vi.mock("../intrinsic-values/storage", () => ({ readManualIntrinsicValues: vi.fn() }));

import { readScreenerApi } from "./api";
import { readLatestQuotes } from "./storage";
import {
  readEffectiveSplitEventsAsOf,
  readLatestSplitEffectiveDate,
  readLatestSplitEffectiveDateAsOf,
  readTechnicalMetrics,
} from "../sma/storage";
import { readManualSupportLevels } from "../supports/storage";
import { readManualIntrinsicValues } from "../intrinsic-values/storage";

const NOW = new Date("2026-08-13T14:00:00.000Z"); // Thursday 10:00 ET

function quote(updatedAt: string) {
  return {
    symbol: "AAPL",
    price: 102,
    change_abs: 999,
    change_pct: 999,
    day_high: null,
    day_low: null,
    day_open: null,
    previous_close: 100,
    provider: "finnhub-websocket",
    provider_timestamp: updatedAt,
    updated_at: updatedAt,
    quote_session_date: "2026-08-13",
    previous_close_session_date: "2026-08-12",
    daily_change_valid: 1,
  };
}

function env(): Env {
  const db = {
    prepare: () => ({
      all: async () => ({ results: [] }),
    }),
  };
  return { DB: db as unknown as D1Database } as Env;
}

beforeEach(() => {
  vi.mocked(readLatestSplitEffectiveDate).mockResolvedValue(new Map());
  vi.mocked(readLatestSplitEffectiveDateAsOf).mockResolvedValue(new Map());
  vi.mocked(readEffectiveSplitEventsAsOf).mockResolvedValue(new Map());
  vi.mocked(readTechnicalMetrics).mockResolvedValue(new Map());
  vi.mocked(readManualSupportLevels).mockResolvedValue(new Map());
  vi.mocked(readManualIntrinsicValues).mockResolvedValue(new Map());
});

describe("readScreenerApi daily-change freshness", () => {
  it("suppresses 1D when a current-session quote is Stale", async () => {
    vi.mocked(readLatestQuotes).mockResolvedValue([quote("2026-08-13T13:30:00.000Z")]);

    const response = await readScreenerApi(env(), NOW);
    const apple = response.rows.find((row) => row.symbol === "AAPL")!;

    expect(apple.state).toBe("Stale");
    expect(apple.price).toBe(102);
    expect(apple.changeAbs).toBeNull();
    expect(apple.changePct).toBeNull();
  });

  it("still serves derived 1D for a Live quote with valid provenance", async () => {
    vi.mocked(readLatestQuotes).mockResolvedValue([quote("2026-08-13T13:50:00.000Z")]);

    const response = await readScreenerApi(env(), NOW);
    const apple = response.rows.find((row) => row.symbol === "AAPL")!;

    expect(apple.state).toBe("Live");
    expect(apple.changeAbs).toBe(2);
    expect(apple.changePct).toBeCloseTo(2);
  });
});
