import { z } from "zod";
import { isoTimestampSchema, marketDateSchema } from "./primitives";

export const aiAnalysisResultSchemaVersion = 1 as const;
export const aiAnalysisEngineName = "TradingAgents" as const;

export const aiAnalysisRecommendationValues = [
  "BUY",
  "OVERWEIGHT",
  "HOLD",
  "UNDERWEIGHT",
  "SELL",
] as const;
export type AiAnalysisRecommendation = (typeof aiAnalysisRecommendationValues)[number];

export const aiAnalysisRunStatusValues = ["queued", "running", "completed", "failed"] as const;
export type AiAnalysisRunStatus = (typeof aiAnalysisRunStatusValues)[number];

export const aiAnalysisWorkflowStages = [
  {
    key: "market",
    label: "Market & technical research",
    agents: ["Market Analyst"],
  },
  {
    key: "sentiment-news",
    label: "Sentiment & news review",
    agents: ["Sentiment Analyst", "News Analyst"],
  },
  {
    key: "fundamentals",
    label: "Fundamentals review",
    agents: ["Fundamentals Analyst"],
  },
  {
    key: "research-debate",
    label: "Bull & bear debate",
    agents: ["Bull Researcher", "Bear Researcher"],
  },
  {
    key: "research-decision",
    label: "Research decision & trade plan",
    agents: ["Research Manager", "Trader"],
  },
  {
    key: "risk",
    label: "Risk review",
    agents: ["Aggressive Analyst", "Neutral Analyst", "Conservative Analyst"],
  },
  {
    key: "portfolio",
    label: "Portfolio manager synthesis",
    agents: ["Portfolio Manager"],
  },
] as const;
export type AiAnalysisWorkflowStageKey = (typeof aiAnalysisWorkflowStages)[number]["key"];

const stockSymbolSchema = z.string().regex(/^[A-Z][A-Z0-9-]{0,11}$/);
const companyNameSchema = z.string().trim().min(1).max(256);
const reportMarkdownSchema = z.string().trim().min(1).max(120_000).nullable();

/**
 * Application-owned result contract. It deliberately contains only stable,
 * normalized TradingAgents outputs and never exposes arbitrary LangGraph
 * state, messages, tool calls, provider payloads, or prompts.
 */
export const aiAnalysisResultV1Schema = z.strictObject({
  schemaVersion: z.literal(aiAnalysisResultSchemaVersion),
  symbol: stockSymbolSchema,
  analysisDate: marketDateSchema,
  generatedAt: isoTimestampSchema,
  engine: z.strictObject({
    name: z.literal(aiAnalysisEngineName),
    version: z.string().trim().min(1).max(64),
    commit: z.string().regex(/^[a-f0-9]{40}$/),
    provider: z.string().trim().min(1).max(64),
    quickModel: z.string().trim().min(1).max(128),
    deepModel: z.string().trim().min(1).max(128),
  }),
  recommendation: z.enum(aiAnalysisRecommendationValues),
  executiveSummary: z.string().trim().min(1).max(20_000).nullable(),
  investmentThesis: z.string().trim().min(1).max(80_000).nullable(),
  priceTarget: z.number().finite().positive().nullable(),
  timeHorizon: z.string().trim().min(1).max(2_000).nullable(),
  reports: z.strictObject({
    marketAndTechnical: reportMarkdownSchema,
    sentiment: reportMarkdownSchema,
    news: reportMarkdownSchema,
    fundamentals: reportMarkdownSchema,
    bullCase: reportMarkdownSchema,
    bearCase: reportMarkdownSchema,
    researchManager: reportMarkdownSchema,
    traderPlan: reportMarkdownSchema,
    risk: z.strictObject({
      aggressive: reportMarkdownSchema,
      neutral: reportMarkdownSchema,
      conservative: reportMarkdownSchema,
    }),
    portfolioManager: z.string().trim().min(1).max(120_000),
  }),
});
export type AiAnalysisResultV1 = z.infer<typeof aiAnalysisResultV1Schema>;

export const aiAnalysisCatalogResponseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  universeVersion: z.number().int().positive(),
  stocks: z.array(z.strictObject({
    symbol: stockSymbolSchema,
    company: companyNameSchema,
  })).length(50),
});
export type AiAnalysisCatalogResponse = z.infer<typeof aiAnalysisCatalogResponseSchema>;

export const aiAnalysisHistoryItemSchema = z.strictObject({
  runId: z.string().uuid(),
  symbol: stockSymbolSchema,
  company: companyNameSchema,
  recommendation: z.enum(aiAnalysisRecommendationValues),
  completedAt: isoTimestampSchema,
});
export type AiAnalysisHistoryItem = z.infer<typeof aiAnalysisHistoryItemSchema>;

export const aiAnalysisViewerResponseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  creditsRemaining: z.number().int().nonnegative(),
  ownedSymbols: z.array(stockSymbolSchema).max(50),
});
export type AiAnalysisViewerResponse = z.infer<typeof aiAnalysisViewerResponseSchema>;

const aiAnalysisRunBaseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  runId: z.string().uuid(),
  symbol: stockSymbolSchema,
  company: companyNameSchema,
  requestedAt: isoTimestampSchema,
  creditsRemaining: z.number().int().nonnegative(),
});

export const aiAnalysisRunResponseSchema = z.discriminatedUnion("status", [
  aiAnalysisRunBaseSchema.extend({
    status: z.enum(["queued", "running"]),
    completedAt: z.null(),
    creditRefunded: z.literal(false),
    result: z.null(),
  }),
  aiAnalysisRunBaseSchema.extend({
    status: z.literal("completed"),
    completedAt: isoTimestampSchema,
    creditRefunded: z.literal(false),
    result: aiAnalysisResultV1Schema,
  }),
  aiAnalysisRunBaseSchema.extend({
    status: z.literal("failed"),
    completedAt: z.null(),
    creditRefunded: z.boolean(),
    result: z.null(),
  }),
]);
export type AiAnalysisRunResponse = z.infer<typeof aiAnalysisRunResponseSchema>;

export const aiAnalysisHistoryResponseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  items: z.array(aiAnalysisHistoryItemSchema).max(100),
  nextCursor: z.string().min(1).max(256).nullable(),
});
export type AiAnalysisHistoryResponse = z.infer<typeof aiAnalysisHistoryResponseSchema>;
