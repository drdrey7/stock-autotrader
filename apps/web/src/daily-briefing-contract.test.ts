import {
  dailyBriefingSchema,
  publishedDailyBriefingSchema,
  type DailyBriefing,
} from "@stock-autotrader/contracts";
import { describe, expect, it } from "vitest";
import { exampleDailyBriefing } from "./daily-briefing-example";

function cloneBriefing(): DailyBriefing {
  return JSON.parse(JSON.stringify(exampleDailyBriefing)) as DailyBriefing;
}

describe("DailyBriefing v1 contract", () => {
  it("accepts the shared example briefing", () => {
    const parsed = dailyBriefingSchema.parse(exampleDailyBriefing);

    expect(parsed.example).toBe(true);
    expect(parsed.timezone).toBe("America/New_York");
    expect(parsed.market.map((item) => item.symbol)).toEqual([
      "SP:SPX",
      "NASDAQ:NDX",
      "CBOE:VIX",
    ]);
  });

  it("rejects unsupported informational verdicts", () => {
    const briefing = cloneBriefing();
    const firstIdea = briefing.ideas[0];
    if (!firstIdea) throw new Error("Example briefing must contain an idea");
    firstIdea.verdict = "Buy now" as DailyBriefing["ideas"][number]["verdict"];

    expect(dailyBriefingSchema.safeParse(briefing).success).toBe(false);
  });

  it("rejects a non-canonical timezone", () => {
    const briefing = cloneBriefing();
    briefing.timezone = "Europe/Zurich" as DailyBriefing["timezone"];

    expect(dailyBriefingSchema.safeParse(briefing).success).toBe(false);
  });

  it("rejects invalid calendar dates", () => {
    const briefing = cloneBriefing();
    briefing.editionDate = "2026-02-30" as DailyBriefing["editionDate"];

    expect(dailyBriefingSchema.safeParse(briefing).success).toBe(false);
  });

  it("rejects more than three Potential Entry ideas", () => {
    const briefing = cloneBriefing();
    const firstIdea = briefing.ideas[0];
    if (!firstIdea) throw new Error("Example briefing must contain an idea");
    briefing.ideas = [
      firstIdea,
      { ...firstIdea, symbol: "AAPL", verdict: "Potential Entry" },
      { ...firstIdea, symbol: "AMZN", verdict: "Potential Entry" },
      { ...firstIdea, symbol: "META", verdict: "Potential Entry" },
    ];

    expect(dailyBriefingSchema.safeParse(briefing).success).toBe(false);
  });

  it("requires the canonical benchmark symbol mapping", () => {
    const briefing = cloneBriefing();
    const firstMarketItem = briefing.market[0];
    if (!firstMarketItem) throw new Error("Example briefing must contain market context");
    firstMarketItem.symbol = "NASDAQ:NDX";

    expect(dailyBriefingSchema.safeParse(briefing).success).toBe(false);
  });

  it("rejects duplicate benchmark symbols", () => {
    const briefing = cloneBriefing();
    const secondMarketItem = briefing.market[1];
    if (!secondMarketItem) throw new Error("Example briefing must contain market context");
    secondMarketItem.symbol = "SP:SPX";

    expect(dailyBriefingSchema.safeParse(briefing).success).toBe(false);
  });

  it("rejects unknown wire fields instead of silently stripping them", () => {
    const briefing = cloneBriefing();
    const firstIdea = briefing.ideas[0];
    if (!firstIdea) throw new Error("Example briefing must contain an idea");
    Object.assign(firstIdea, { unexpectedField: "do-not-ignore" });

    expect(dailyBriefingSchema.safeParse(briefing).success).toBe(false);
  });

  it("keeps missing collection freshness explicit as null", () => {
    const briefing = cloneBriefing();
    const firstIdea = briefing.ideas[0];
    if (!firstIdea) throw new Error("Example briefing must contain an idea");
    firstIdea.source.collectedTimestamp = null;

    expect(dailyBriefingSchema.safeParse(briefing).success).toBe(true);

    Reflect.deleteProperty(firstIdea.source, "collectedTimestamp");
    expect(dailyBriefingSchema.safeParse(briefing).success).toBe(false);
  });

  it("requires HTTPS source references", () => {
    const briefing = cloneBriefing();
    const firstIdea = briefing.ideas[0];
    if (!firstIdea) throw new Error("Example briefing must contain an idea");
    firstIdea.source.reference = "example-post-001";

    expect(dailyBriefingSchema.safeParse(briefing).success).toBe(false);
  });

  it("requires membership and a numeric reward-risk ratio for Potential Entry", () => {
    const briefing = cloneBriefing();
    const firstIdea = briefing.ideas[0];
    if (!firstIdea) throw new Error("Example briefing must contain an idea");
    firstIdea.universe = "Outside universe" as DailyBriefing["ideas"][number]["universe"];
    firstIdea.levels.rewardRiskRatio = null;

    expect(dailyBriefingSchema.safeParse(briefing).success).toBe(false);
  });

  it("rejects inconsistent reward-risk text and ratio", () => {
    const briefing = cloneBriefing();
    const firstIdea = briefing.ideas[0];
    if (!firstIdea) throw new Error("Example briefing must contain an idea");
    firstIdea.levels.rewardRisk = "3.1R illustrative";
    firstIdea.levels.rewardRiskRatio = 2.3;

    expect(dailyBriefingSchema.safeParse(briefing).success).toBe(false);
  });

  it("allows an honest briefing with zero qualifying ideas", () => {
    const briefing = cloneBriefing();
    briefing.ideas = [];

    expect(dailyBriefingSchema.safeParse(briefing).success).toBe(true);
  });

  it("does not allow the Example Data fixture to be published", () => {
    expect(publishedDailyBriefingSchema.safeParse(exampleDailyBriefing).success).toBe(false);

    const realBriefing = cloneBriefing();
    realBriefing.example = false;
    expect(publishedDailyBriefingSchema.safeParse(realBriefing).success).toBe(true);
  });
});
