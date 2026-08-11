import type { DailyBriefing } from "@stock-autotrader/contracts";

export type { BriefingIdea, BriefingVerdict } from "@stock-autotrader/contracts";
export type DailyBriefingExample = DailyBriefing;

/**
 * Frontend-only example fixture for PR #6.
 * It is deliberately synthetic and never represents live market or X data.
 * It is typed against and covered by the shared validated DailyBriefing v1 contract.
 */
export const exampleDailyBriefing: DailyBriefingExample = {
  example: true,
  editionDate: "2026-08-11",
  editionType: "pre_market",
  timezone: "America/New_York",
  preparedAt: "2026-08-11T08:30:00-04:00",
  title: "Pre-market briefing",
  marketSummary:
    "Index structure is constructive, but leadership remains narrow. Volatility is contained and the quality gate favours patience around extended technology names.",
  market: [
    {
      name: "S&P 500",
      symbol: "SP:SPX",
      value: "6,410.23",
      change: "+0.34%",
      state: "Constructive",
      note: "Above the example 20-day trend with breadth still mixed.",
    },
    {
      name: "Nasdaq-100",
      symbol: "NASDAQ:NDX",
      value: "23,812.44",
      change: "+0.58%",
      state: "Leading",
      note: "Relative strength remains positive, concentrated in large-cap technology.",
    },
    {
      name: "VIX",
      symbol: "CBOE:VIX",
      value: "15.72",
      change: "-2.40%",
      state: "Contained",
      note: "Example volatility regime is calm, not a guarantee of low intraday risk.",
    },
  ],
  ideas: [
    {
      symbol: "NVDA",
      company: "NVIDIA Corporation",
      universe: "Both",
      verdict: "Potential Entry",
      price: "$182.64",
      change: "+1.80%",
      thesis:
        "Relative strength and volume expansion support the setup, provided price confirms above the stated trigger instead of opening extended.",
      source: {
        handle: "@nolimitgains",
        reference: "https://example.invalid/nolimitgains/post-001",
        originalTimestamp: "2026-08-11T07:42:00-04:00",
        collectedTimestamp: "2026-08-11T08:02:00-04:00",
        summary:
          "Illustrative source summary: watching continuation only if the prior breakout level holds.",
      },
      technical: [
        "Example price above 20D, 50D and 200D averages.",
        "Relative volume 1.7x versus the illustrative 20-day average.",
        "Confirmation requires a hold above $183.20 after the opening range.",
      ],
      financial: [
        "Large-cap Nasdaq-100 and S&P 500 constituent.",
        "Illustrative growth profile remains strong; valuation sensitivity is elevated.",
      ],
      news: [
        "No material adverse headline included in this example snapshot.",
        "Earnings proximity must be rechecked against live data before use.",
      ],
      risks: [
        "Gap risk after an extended pre-market move.",
        "Concentrated semiconductor leadership can reverse quickly.",
      ],
      levels: {
        trigger: "$183.20 hold",
        invalidation: "$176.80 close",
        objective: "$198.00 example zone",
        rewardRisk: "2.3R illustrative",
        rewardRiskRatio: 2.3,
      },
    },
    {
      symbol: "MSFT",
      company: "Microsoft Corporation",
      universe: "Both",
      verdict: "Watch",
      price: "$512.40",
      change: "+0.42%",
      thesis:
        "Trend quality is positive, but the example setup lacks enough distance from a near-term event window to qualify as a potential entry.",
      source: {
        handle: "@nolimitgains",
        reference: "https://example.invalid/nolimitgains/post-002",
        originalTimestamp: "2026-08-11T07:18:00-04:00",
        collectedTimestamp: "2026-08-11T08:03:00-04:00",
        summary:
          "Illustrative source summary: constructive structure, waiting for cleaner timing.",
      },
      technical: [
        "Example trend stack remains positive.",
        "Volume confirmation is incomplete.",
        "No qualifying trigger until price clears the example range with breadth support.",
      ],
      financial: [
        "Large-cap S&P 500 and Nasdaq-100 constituent.",
        "Illustrative balance-sheet quality is high; expectations are already demanding.",
      ],
      news: [
        "Example event window is too close for a clean qualification.",
      ],
      risks: [
        "Event-driven gap risk.",
        "Crowded mega-cap positioning.",
      ],
      levels: {
        trigger: "Not qualified",
        invalidation: "$498.00 example support",
        objective: "Insufficient confirmation",
        rewardRisk: "Not calculated",
        rewardRiskRatio: null,
      },
    },
    {
      symbol: "TSLA",
      company: "Tesla, Inc.",
      universe: "Both",
      verdict: "Avoid",
      price: "$338.45",
      change: "-1.25%",
      thesis:
        "The illustrative idea fails the V1 quality gate because relative strength, volume and event clarity do not support a current setup.",
      source: {
        handle: "@nolimitgains",
        reference: "https://example.invalid/nolimitgains/post-003",
        originalTimestamp: "2026-08-11T06:55:00-04:00",
        collectedTimestamp: "2026-08-11T08:04:00-04:00",
        summary:
          "Illustrative source summary: volatility noted, but no actionable structure confirmed.",
      },
      technical: [
        "Example relative strength is below the qualification threshold.",
        "No confirmed breakout or volume expansion.",
      ],
      financial: [
        "S&P 500 and Nasdaq-100 constituent with high expectation sensitivity.",
        "Illustrative valuation context does not offset weak technical confirmation.",
      ],
      news: [
        "Headline sensitivity is elevated in the example scenario.",
      ],
      risks: [
        "Fast reversals and wide opening ranges.",
        "Ambiguous catalyst timing.",
      ],
      levels: {
        trigger: "No active trigger",
        invalidation: "Not applicable",
        objective: "Not applicable",
        rewardRisk: "Not calculated",
        rewardRiskRatio: null,
      },
    },
  ],
  schedule: [
    {
      label: "Pre-market",
      time: "08:30 ET",
      detail: "One hour before the regular New York open.",
    },
    {
      label: "Post-close",
      time: "16:30 ET",
      detail: "Thirty minutes after the regular New York close.",
    },
  ],
};
