import { z } from "zod";

export const symbolSchema = z.string().regex(/^[A-Z][A-Z0-9.-]{0,9}$/);
export const idSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
export const signalSchema = z.enum([
  "Strong Setup",
  "Watch",
  "No Setup",
  "Rejected",
]);
export const decisionReasonSchema = z.object({
  id: z.string(),
  outcome: z.enum(["pass", "reject", "info"]),
  code: z.string(),
  label: z.string(),
  observed: z.string().optional(),
  threshold: z.string().optional(),
});
export const candidateSchema = z.object({
  symbol: symbolSchema,
  company: z.string(),
  sector: z.string(),
  marketCap: z.number().nonnegative(),
  price: z.number().nonnegative(),
  quantScore: z.number().min(0).max(100),
  strategyId: idSchema,
  strategyVersion: z.string(),
  strategy: z.string(),
  trend: z.enum(["Strong", "Positive", "Mixed", "Weak"]),
  momentum: z.number(),
  relativeStrength: z.number(),
  relativeVolume: z.number().nonnegative(),
  earningsDate: z.string().nullable(),
  earningsProximityDays: z.number().nullable(),
  status: signalSchema,
  direction: z.enum(["Bullish", "Neutral", "Bearish"]),
  updatedAt: z.string(),
  reasons: z.array(decisionReasonSchema),
});
export const strategySchema = z.object({
  id: idSchema,
  name: z.string(),
  version: z.string(),
  description: z.string(),
  state: z.enum(["Research", "Validation", "Out-of-Sample", "Shadow", "Live"]),
  enabled: z.boolean(),
  universe: z.string(),
  holdingPeriod: z.string(),
  signalsToday: z.number(),
  openPositions: z.number(),
  parameters: z.record(
    z.string(),
    z.union([z.string(), z.number(), z.boolean()]),
  ),
});
export const statusSchema = z.object({
  engine: z.enum(["online", "offline", "delayed"]),
  latestScan: z.string().nullable(),
  nextScan: z.string().nullable(),
  lastDataUpdate: z.string().nullable(),
  apiHealth: z.enum(["healthy", "degraded"]),
});
export const scanSchema = z.object({
  id: idSchema,
  scanType: z.enum(["PRE_MARKET", "POST_CLOSE", "MANUAL", "SMOKE"]),
  status: z.enum(["STARTED", "COMPLETED", "FAILED"]),
  universe: z.number().int().nonnegative(),
  passedFilters: z.number().int().nonnegative(),
  candidates: z.number().int().nonnegative(),
  setups: z.number().int().nonnegative(),
  dataSource: z.string(),
  dataAsOf: z.string(),
  startedAt: z.string(),
  completedAt: z.string().nullable(),
  demo: z.boolean(),
});
export const earningsSchema = z.object({
  symbol: symbolSchema,
  company: z.string(),
  date: z.string(),
  timing: z.enum(["BMO", "AMC", "TBD"]),
  eventSignal: z.enum(["Confirmed", "Pending", "Risk Window"]),
  strategies: z.array(z.string()),
  tracked: z.boolean(),
});
export const eventSchema = z.object({
  id: z.string(),
  type: z.string(),
  message: z.string(),
  symbol: symbolSchema.optional(),
  strategyId: idSchema.optional(),
  severity: z.enum(["info", "success", "warning", "error"]),
  createdAt: z.string(),
});
export const positionSchema = z.object({
  symbol: symbolSchema,
  strategy: z.string(),
  entryPrice: z.number().positive(),
  currentPrice: z.number().positive(),
  stopPrice: z.number().positive(),
  quantity: z.number().int().positive(),
  riskAmount: z.number().nonnegative(),
  unrealizedPnl: z.number(),
  rMultiple: z.number(),
  openedAt: z.string(),
});
export const researchSchema = z.object({
  id: idSchema,
  strategyId: idSchema,
  strategy: z.string(),
  stage: z.enum(["Research", "Validation", "Out-of-Sample", "Shadow", "Live"]),
  period: z.string(),
  status: z.enum(["Demo", "Pending", "Complete"]),
  metrics: z.record(z.string(), z.number().nullable()),
});
export const analysisSchema = z.object({
  id: idSchema,
  symbol: symbolSchema,
  strategyId: idSchema.nullable(),
  strategyVersion: z.string().nullable(),
  quantFactors: z.record(z.string(), z.unknown()),
  marketStructure: z.record(z.string(), z.unknown()),
  publicSummary: z.string(),
  aiAssessment: z.record(z.string(), z.unknown()).nullable(),
  dataSource: z.string(),
  dataAsOf: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  reasons: z.array(decisionReasonSchema),
});
export const dashboardSchema = z.object({
  demo: z.boolean(),
  status: statusSchema,
  scan: z.object({
    universe: z.number().int().nonnegative(),
    passedFilters: z.number().int().nonnegative(),
    candidates: z.number().int().nonnegative(),
    setups: z.number().int().nonnegative(),
  }),
  portfolio: z.object({
    initialCapital: z.number().positive(),
    equity: z.number().nonnegative(),
    returnPct: z.number(),
    openPositions: z.number().int().nonnegative(),
    openRiskPct: z.number().nonnegative(),
    grossExposurePct: z.number().nonnegative(),
    maxPositions: z.number().int().positive(),
    maxOpenRiskPct: z.number().positive(),
    maxGrossExposurePct: z.number().positive(),
  }),
  strategies: z.array(strategySchema),
  candidates: z.array(candidateSchema),
  events: z.array(eventSchema),
  earnings: z.array(earningsSchema),
  positions: z.array(positionSchema),
  research: z.array(researchSchema),
});
