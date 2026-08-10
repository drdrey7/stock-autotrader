import { z } from "zod";

export const symbolSchema = z.string().regex(/^[A-Z][A-Z0-9.-]{0,9}$/);
export const idSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
export const signalSchema = z.enum(["Strong Setup", "Watch", "No Setup", "Rejected"]);
export const candidateSchema = z.object({
  symbol: symbolSchema,
  company: z.string(),
  sector: z.string(),
  marketCap: z.number().nonnegative(),
  price: z.number().nonnegative(),
  quantScore: z.number().min(0).max(100),
  strategyId: idSchema,
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
  reasons: z.array(z.object({ id: z.string(), outcome: z.enum(["pass", "reject", "info"]), code: z.string(), label: z.string(), observed: z.string().optional(), threshold: z.string().optional() }))
});
export const strategySchema = z.object({ id: idSchema, name: z.string(), version: z.string(), description: z.string(), state: z.enum(["Research", "Validation", "Shadow", "Live"]), enabled: z.boolean(), universe: z.string(), holdingPeriod: z.string(), signalsToday: z.number(), openPositions: z.number(), parameters: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])) });
export const statusSchema = z.object({ engine: z.enum(["online", "offline", "delayed"]), latestScan: z.string(), nextScan: z.string(), lastDataUpdate: z.string(), apiHealth: z.enum(["healthy", "degraded"]) });

