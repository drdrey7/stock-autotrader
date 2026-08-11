import { z } from "zod";

export const briefingVerdictValues = [
  "Potential Entry",
  "Watch",
  "Avoid",
  "Insufficient Data",
] as const;

export const briefingEditionTypes = ["pre_market", "post_close"] as const;
export const briefingTimezone = "America/New_York" as const;

export const briefingBenchmarkDefinitions = [
  { name: "S&P 500", symbol: "SP:SPX" },
  { name: "Nasdaq-100", symbol: "NASDAQ:NDX" },
  { name: "VIX", symbol: "CBOE:VIX" },
] as const;

const nonEmptyString = z.string().trim().min(1);

const isoTimestamp = z.string().datetime({ offset: true });

const calendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, "date must be a valid calendar date");

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
  reference: nonEmptyString,
  originalTimestamp: isoTimestamp.nullable(),
  collectedTimestamp: isoTimestamp.nullable(),
  summary: nonEmptyString,
});

export const briefingIdeaSchema = z.strictObject({
  symbol: nonEmptyString,
  company: nonEmptyString,
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
  }),
});

export type BriefingVerdict = z.infer<typeof briefingIdeaSchema>["verdict"];
export type BriefingIdea = z.infer<typeof briefingIdeaSchema>;

export const dailyBriefingSchema = z
  .strictObject({
    example: z.boolean(),
    editionDate: calendarDate,
    editionType: z.enum(briefingEditionTypes),
    timezone: z.literal(briefingTimezone),
    preparedAt: isoTimestamp,
    title: nonEmptyString,
    marketSummary: nonEmptyString,
    market: z.array(marketContextItemSchema).length(briefingBenchmarkDefinitions.length),
    ideas: z.array(briefingIdeaSchema).min(1),
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

    const potentialEntryCount = briefing.ideas.filter(
      (idea) => idea.verdict === "Potential Entry",
    ).length;
    if (potentialEntryCount > 3) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ideas"],
        message: "briefing may contain at most three Potential Entry ideas",
      });
    }
  });

export type DailyBriefing = z.infer<typeof dailyBriefingSchema>;
