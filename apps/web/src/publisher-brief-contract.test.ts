import { publishedDailyBriefingSchema } from "@stock-autotrader/contracts";
import { describe, expect, it } from "vitest";
import preMarketFixture from "../../publisher/fixtures/brief.pre_market.v1.json";

/**
 * Publisher compatibility fixture (PR #8).
 *
 * The Python publisher pipeline produces deterministic briefs from recorded
 * inputs (X posts + quotes fixtures). This test proves the pipeline output
 * satisfies the exact Zod contract enforced at the ingest boundary — the
 * same validation the live API would apply to a published payload.
 */
describe("Publisher brief fixtures satisfy the published contract", () => {
  it("accepts the pre_market v1 fixture as a live (non-example) briefing", () => {
    const parsed = publishedDailyBriefingSchema.parse(preMarketFixture);

    expect(parsed.example).toBe(false);
    expect(parsed.editionType).toBe("pre_market");
    expect(parsed.timezone).toBe("America/New_York");
    expect(parsed.market.map((item) => item.symbol)).toEqual([
      "SP:SPX",
      "NASDAQ:NDX",
      "CBOE:VIX",
    ]);
    // both publisher ideas are real universe members and carry valid R:R
    expect(parsed.ideas.map((idea) => idea.symbol)).toEqual(["NVDA", "AAPL"]);
    for (const idea of parsed.ideas) {
      expect(idea.verdict).toBe("Potential Entry");
      expect(idea.source.handle).toBe("@nolimitgains");
      expect(idea.levels.rewardRiskRatio).toBeGreaterThan(0);
    }
  });
});
