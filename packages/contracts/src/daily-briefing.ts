import { z } from "zod";
import { isBriefingSymbolInUniverse } from "./briefing-universe";

export const briefingVerdictValues = [
  "Potential Entry",
  "Watch",
  "Avoid",
  "Insufficient Data",
] as const;

export const briefingEditionTypes = ["pre_market", "post_close"] as const;
export type BriefingEditionType = (typeof briefingEditionTypes)[number];
export const briefingTimezone = "America/New_York" as const;
export const briefingUniverseValues = ["S&P 500", "Nasdaq-100", "Both"] as const;

export const briefingBenchmarkDefinitions = [
  { name: "S&P 500", symbol: "SP:SPX" },
  { name: "Nasdaq-100", symbol: "NASDAQ:NDX" },
  { name: "VIX", symbol: "CBOE:VIX" },
] as const;

const nonEmptyString = z.string().trim().min(1);

const isoTimestamp = z.string().datetime({ offset: true });

const tickerSymbol = z.string().regex(/^[A-Z0-9.-]{1,12}$/, "symbol must use a canonical ticker format");

export const briefingCalendarDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, "date must be a valid calendar date");

export const briefingEditionTypeSchema = z.enum(briefingEditionTypes);

const httpsUrl = z.string().url().refine((value) => {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}, "reference must be an HTTPS URL");

export const marketContextItemSchema = z.strictObject({
  name: z.enum(["S&P 500", "Nasdaq-100", "VIX"]),
  symbol: z.enum(["SP:SPX", "NASDAQ:NDX", "CBOE:VIX"]),
  value: nonEmptyString,
  change: nonEmptyString,
  state: nonEmptyString,
  note: nonEmptyString,
});

export type MarketContextItem = z.infer<typeof marketContextItemSchema>;

export const briefingSourceSchema = z.strictObject({
  handle: nonEmptyString,
  reference: httpsUrl,
  originalTimestamp: isoTimestamp.nullable(),
  collectedTimestamp: isoTimestamp.nullable(),
  summary: nonEmptyString,
});

export const briefingIdeaSchema = z.strictObject({
  symbol: tickerSymbol,
  company: nonEmptyString,
  universe: z.enum(briefingUniverseValues),
  verdict: z.enum(briefingVerdictValues),
  price: nonEmptyString,
  change: nonEmptyString,
  thesis: nonEmptyString,
  source: briefingSourceSchema,
  technical: z.array(nonEmptyString).min(1),
  financial: z.array(nonEmptyString).min(1),
  news: z.array(nonEmptyString).min(1),
  risks: z.array(nonEmptyString).min(1),
  levels: z.strictObject({
    trigger: nonEmptyString,
    invalidation: nonEmptyString,
    objective: nonEmptyString,
    rewardRisk: nonEmptyString,
    rewardRiskRatio: z.number().positive().refine(Number.isFinite).nullable(),
  }),
});

export type BriefingVerdict = z.infer<typeof briefingIdeaSchema>["verdict"];
export type BriefingIdea = z.infer<typeof briefingIdeaSchema>;

export const dailyBriefingSchema = z
  .strictObject({
    example: z.boolean(),
    editionDate: briefingCalendarDateSchema,
    editionType: briefingEditionTypeSchema,
    timezone: z.literal(briefingTimezone),
    preparedAt: isoTimestamp,
    title: nonEmptyString,
    marketSummary: nonEmptyString,
    market: z.array(marketContextItemSchema).length(briefingBenchmarkDefinitions.length),
    ideas: z.array(briefingIdeaSchema).max(3),
    schedule: z.array(
      z.strictObject({
        label: nonEmptyString,
        time: nonEmptyString,
        detail: nonEmptyString,
      }),
    ),
  })
  .superRefine((briefing, ctx) => {
    const expectedByName = new Map(
      briefingBenchmarkDefinitions.map((benchmark) => [benchmark.name, benchmark.symbol]),
    );
    const seenSymbols = new Set<string>();

    briefing.market.forEach((item, index) => {
      if (expectedByName.get(item.name) !== item.symbol) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["market", index, "symbol"],
          message: `${item.name} must use its canonical benchmark symbol`,
        });
      }
      seenSymbols.add(item.symbol);
    });

    if (seenSymbols.size !== briefingBenchmarkDefinitions.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["market"],
        message: "briefing must contain each canonical benchmark exactly once",
      });
    }

    const potentialEntries = briefing.ideas.filter(
      (idea) => idea.verdict === "Potential Entry",
    );
    const potentialEntryCount = potentialEntries.length;
    if (potentialEntryCount > 3) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ideas"],
        message: "briefing may contain at most three Potential Entry ideas",
      });
    }

    potentialEntries.forEach((idea, index) => {
      const originalIndex = briefing.ideas.indexOf(idea);
      const issuePath = ["ideas", originalIndex >= 0 ? originalIndex : index, "levels", "rewardRiskRatio"];
      const rewardRiskMatch = /^(\d+(?:\.\d+)?)R\b/i.exec(idea.levels.rewardRisk.trim());
      if (
        idea.levels.rewardRiskRatio === null
        || !rewardRiskMatch
        || Math.abs(Number(rewardRiskMatch[1]) - idea.levels.rewardRiskRatio) > 0.01
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: issuePath,
          message: "Potential Entry reward-risk text and ratio must agree",
        });
      }
    });

    briefing.ideas.forEach((idea, index) => {
      if (!isBriefingSymbolInUniverse(idea.symbol, idea.universe)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["ideas", index, "symbol"],
          message: `${idea.symbol} is not a member of the declared ${idea.universe} universe`,
        });
      }
      if (idea.verdict !== "Potential Entry" && idea.levels.rewardRiskRatio !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["ideas", index, "levels", "rewardRiskRatio"],
          message: "Only Potential Entry ideas may include a reward-risk ratio",
        });
      }
      if (idea.levels.rewardRiskRatio === null && /\d+(?:\.\d+)?R\b/i.test(idea.levels.rewardRisk)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["ideas", index, "levels", "rewardRisk"],
          message: "Reward-risk text cannot contain a ratio without a numeric value",
        });
      }
    });
  });

export type DailyBriefing = z.infer<typeof dailyBriefingSchema>;

export const publishedDailyBriefingSchema = dailyBriefingSchema.superRefine((briefing, ctx) => {
  if (briefing.example) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["example"],
      message: "Example Data cannot be published as a live briefing",
    });
  }
});
