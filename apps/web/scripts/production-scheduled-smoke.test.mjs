import { describe, expect, it } from "vitest";
import { marketSmokeScheduledTime, scheduledSmokePlan } from "./production-scheduled-smoke.mjs";

describe("scheduledSmokePlan", () => {
  it("skips unrelated frontend and runtime changes", () => {
    expect(scheduledSmokePlan({ paths: ["apps/web/src/App.tsx"] })).toEqual({
      validateDispatcher: false,
      runMarketContext: false,
    });
    expect(scheduledSmokePlan({ paths: ["apps/web/worker/ai-analysis/api.ts"] })).toEqual({
      validateDispatcher: false,
      runMarketContext: false,
    });
  });

  it("runs a live Market Context smoke for Market Context changes", () => {
    expect(scheduledSmokePlan({ paths: ["apps/web/worker/market-context.ts"] })).toEqual({
      validateDispatcher: false,
      runMarketContext: true,
    });
    expect(scheduledSmokePlan({ paths: ["apps/web/worker/market-context/provider.ts"] })).toEqual({
      validateDispatcher: false,
      runMarketContext: true,
    });
  });

  it("validates the dispatcher contract and live Market Context path when the dispatcher changes", () => {
    expect(scheduledSmokePlan({ paths: ["apps/web/worker/cron-dispatcher.ts"] })).toEqual({
      validateDispatcher: true,
      runMarketContext: true,
    });
  });
});

describe("marketSmokeScheduledTime", () => {
  it("anchors the latest summer session date to 10:00 New York time", () => {
    expect(marketSmokeScheduledTime({
      market: { latestSourceTimestamp: "2026-08-28T20:00:00.000Z" },
    })).toBe("2026-08-28T14:00:00.000Z");
  });

  it("is DST-safe for a winter session", () => {
    expect(marketSmokeScheduledTime({
      market: { latestSourceTimestamp: "2026-01-12T21:00:00.000Z" },
    })).toBe("2026-01-12T15:00:00.000Z");
  });

  it("fails closed for missing or invalid source timestamps", () => {
    expect(marketSmokeScheduledTime({ market: { latestSourceTimestamp: null } })).toBeNull();
    expect(marketSmokeScheduledTime({ market: { latestSourceTimestamp: "not-a-date" } })).toBeNull();
  });
});
