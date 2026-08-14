import { z } from "zod";
import { isoTimestampSchema, marketDateSchema } from "./primitives";

/**
 * The public dashboard/market-data read contract: the single source of
 * truth for what `/api/status` (and the now-removed `/api/dashboard`) once
 * returned. The Worker validates its own constructed read model against it
 * before serving.
 */

const directionSchema = z.enum(["Bullish", "Neutral", "Bearish"]).or(
  z.literal("Long").transform(() => "Bullish" as const),
);

const marketBarSchema = z.object({
  symbol: z.string().regex(/^[A-Z0-9.-]{1,12}$/),
  date: marketDateSchema,
  open: z.number().positive(),
  high: z.number().positive(),
  low: z.number().positive(),
  close: z.number().positive(),
  adjustedClose: z.number().positive(),
  volume: z.number().int().positive(),
}).superRefine((bar, ctx) => {
  if (bar.high < Math.max(bar.open, bar.close)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["high"], message: "high must cover open and close" });
  }
  if (bar.low > Math.min(bar.open, bar.close)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["low"], message: "low must cover open and close" });
  }
});

const marketIndexSchema = z.object({
  symbol: z.enum(["SPX", "NDX", "DJI", "VIX"]),
  name: z.string().min(1).max(32),
  value: z.number().finite().positive(),
  change: z.number().finite(),
  updatedAt: isoTimestampSchema,
});

export const marketDataSchema = z.object({
  provider: z.string().min(1).max(64),
  status: z.enum(["healthy", "degraded", "offline"]),
  asOf: marketDateSchema.nullable(),
  lastSuccessfulUpdate: isoTimestampSchema.nullable(),
  universe: z.object({
    total: z.number().int().nonnegative(),
    eligible: z.number().int().nonnegative(),
    excluded: z.number().int().nonnegative(),
  }),
  benchmarks: z.array(marketBarSchema).max(10),
  // Real-time index context (S&P 500, Nasdaq-100, Dow Jones, VIX). Optional so
  // snapshots published before the field existed stay valid.
  indices: z.array(marketIndexSchema).max(8).optional(),
  warnings: z.array(z.string().max(200)).max(20),
  updatedAt: isoTimestampSchema.nullable(),
}).superRefine((snapshot, ctx) => {
  if (snapshot.universe.total !== snapshot.universe.eligible + snapshot.universe.excluded) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["universe"], message: "universe counts must add up" });
  }
  if (snapshot.status === "healthy") {
    const symbols = snapshot.benchmarks.map((bar) => bar.symbol);
    if (!snapshot.asOf || !snapshot.lastSuccessfulUpdate || !snapshot.updatedAt) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["lastSuccessfulUpdate"], message: "healthy snapshots require freshness" });
    }
    if (symbols.length !== 2 || symbols[0] !== "SPY" || symbols[1] !== "QQQ") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["benchmarks"], message: "healthy snapshots require SPY and QQQ" });
    }
    if (snapshot.warnings.length > 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["warnings"], message: "healthy snapshots cannot contain warnings" });
    }
  }
});

const dashboardReasonSchema = z.object({
  id: z.string().min(1).max(64),
  code: z.string().min(1).max(64),
  label: z.string().min(1).max(200),
  outcome: z.enum(["pass", "reject", "info"]),
  observed: z.string().max(200).optional(),
  threshold: z.string().max(200).optional(),
});

export const dashboardCandidateSchema = z.object({
  symbol: z.string().regex(/^[A-Za-z0-9.-]{1,12}$/),
  company: z.string().min(1).max(200),
  sector: z.string(),
  marketCap: z.number().nonnegative(),
  price: z.number().nonnegative(),
  quantScore: z.number().int().min(0).max(100),
  strategyId: z.string().min(1).max(64),
  strategyVersion: z.string().min(1).max(32),
  strategy: z.string().min(1).max(64),
  trend: z.enum(["Strong", "Positive", "Mixed", "Weak"]),
  momentum: z.number().optional().nullable(),
  relativeStrength: z.number().optional().nullable(),
  relativeVolume: z.number().optional().nullable(),
  breakout: z.string().max(64).optional().nullable(),
  earningsDate: marketDateSchema.nullable(),
  earningsProximityDays: z.number().int().optional().nullable(),
  status: z.enum(["Strong Setup", "Watch", "No Setup", "Rejected"]),
  direction: directionSchema,
  riskFlags: z.array(z.string().max(200)).default([]),
  updatedAt: isoTimestampSchema,
  reasons: z.array(dashboardReasonSchema),
});

const dashboardEarningsSchema = z.object({
  symbol: z.string().regex(/^[A-Za-z0-9.-]{1,12}$/),
  company: z.string().min(1).max(200),
  date: marketDateSchema,
  timing: z.enum(["BMO", "AMC", "TBD"]),
  eventSignal: z.enum(["Confirmed", "Pending", "Risk Window"]),
  engineRelevant: z.boolean(),
  signal: z.enum(["Strong Setup", "Watch", "No Setup", "Rejected"]).nullable(),
  strategy: z.string().max(64).nullable(),
  hasPosition: z.boolean(),
  tracked: z.boolean(),
  updatedAt: isoTimestampSchema,
});

export const dashboardStatusSchema = z.object({
  engine: z.enum(["online", "offline", "delayed"]),
  latestScan: isoTimestampSchema.nullable(),
  nextScan: isoTimestampSchema.nullable(),
  lastDataUpdate: isoTimestampSchema.nullable(),
  apiHealth: z.enum(["healthy", "degraded"]),
});

export const dashboardRiskPolicySchema = z.object({
  riskPerTradePct: z.number().positive(),
  maxPositions: z.number().int().positive(),
  maxOpenRiskPct: z.number().positive(),
  maxSinglePositionPct: z.number().positive(),
  maxSectorExposurePct: z.number().positive(),
  maxGrossExposurePct: z.number().positive(),
  leverage: z.string(),
  averagingDown: z.boolean(),
  martingale: z.boolean(),
});

export const dashboardPortfolioSchema = z.object({
  initialCapital: z.number().positive(),
  equity: z.number().nonnegative(),
  returnPct: z.number(),
  cash: z.number().nonnegative(),
  invested: z.number().nonnegative(),
  openPositions: z.number().int().nonnegative(),
  openRiskPct: z.number().nonnegative(),
  grossExposurePct: z.number().nonnegative(),
  riskPolicy: dashboardRiskPolicySchema,
});

export const dashboardStrategySchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  description: z.string(),
  state: z.enum(["Research", "Validation", "Out-of-Sample", "Shadow", "Live"]),
  enabled: z.boolean(),
  universe: z.string(),
  holdingPeriod: z.string(),
  signalsToday: z.number(),
  openPositions: z.number(),
  parameters: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
});

export const dashboardPositionSchema = z.object({
  symbol: z.string(),
  strategy: z.string(),
  entryPrice: z.number(),
  currentPrice: z.number(),
  stopPrice: z.number(),
  quantity: z.number().int(),
  riskAmount: z.number(),
  unrealizedPnl: z.number(),
  returnPct: z.number(),
  rMultiple: z.number(),
  openedAt: isoTimestampSchema,
});

const dashboardEventSchema = z.object({
  id: z.string(),
  type: z.string(),
  message: z.string(),
  severity: z.enum(["info", "success", "warning", "error"]),
  symbol: z.string().optional(),
  strategyId: z.string().optional(),
  createdAt: isoTimestampSchema,
});

const dashboardResearchSchema = z.object({
  id: z.string(),
  strategyId: z.string(),
  strategy: z.string(),
  stage: z.enum(["Research", "Validation", "Out-of-Sample", "Shadow", "Live"]),
  period: z.string(),
  status: z.enum(["Demo", "Pending", "Complete"]),
  metrics: z.record(z.string(), z.number().nullable()),
});

export const dashboardReadSchema = z.object({
  demo: z.boolean(),
  status: dashboardStatusSchema,
  marketData: marketDataSchema,
  scan: z.object({
    universe: z.number().int().nonnegative(),
    passedFilters: z.number().int().nonnegative(),
    candidates: z.number().int().nonnegative(),
    setups: z.number().int().nonnegative(),
    watch: z.number().int().nonnegative(),
  }),
  portfolio: dashboardPortfolioSchema,
  strategies: z.array(dashboardStrategySchema),
  candidates: z.array(dashboardCandidateSchema),
  events: z.array(dashboardEventSchema),
  earnings: z.array(dashboardEarningsSchema),
  positions: z.array(dashboardPositionSchema),
  research: z.array(dashboardResearchSchema),
});
