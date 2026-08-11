import { demoData } from "@stock-autotrader/contracts/src/demo-data";
import type { DashboardData } from "@stock-autotrader/contracts";
import { z } from "zod";

const reason = z.object({
  id: z.string(),
  outcome: z.enum(["pass", "reject", "info"]),
  code: z.string(),
  label: z.string(),
  observed: z.string().optional(),
  threshold: z.string().optional(),
});
const isoTimestampSchema = z.string().datetime({ offset: true });

const marketDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, "date must be a valid calendar date");

const marketDataPayload = z.object({
  provider: z.string(),
  status: z.enum(["healthy", "degraded", "offline"]),
  asOf: marketDateSchema.nullable(),
  lastSuccessfulUpdate: isoTimestampSchema.nullable(),
  universe: z.object({
    total: z.number().int().nonnegative(),
    eligible: z.number().int().nonnegative(),
    excluded: z.number().int().nonnegative(),
  }),
  benchmarks: z.array(z.object({
    symbol: z.string(),
    date: marketDateSchema,
    open: z.number().positive(),
    high: z.number().positive(),
    low: z.number().positive(),
    close: z.number().positive(),
    adjustedClose: z.number().positive(),
    volume: z.number().int().positive(),
  })),
  warnings: z.array(z.string()),
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

export const dashboardPayload = z.object({
  demo: z.boolean(),
  status: z.object({
    engine: z.enum(["online", "offline", "delayed"]),
    latestScan: isoTimestampSchema.nullable(),
    nextScan: isoTimestampSchema.nullable(),
    lastDataUpdate: isoTimestampSchema.nullable(),
    apiHealth: z.enum(["healthy", "degraded"]),
  }),
  marketData: marketDataPayload,
  scan: z.object({
    universe: z.number().int().nonnegative(),
    passedFilters: z.number().int().nonnegative(),
    candidates: z.number().int().nonnegative(),
    setups: z.number().int().nonnegative(),
    watch: z.number().int().nonnegative(),
  }),
  portfolio: z.object({
    initialCapital: z.number().positive(),
    equity: z.number().nonnegative(),
    returnPct: z.number(),
    cash: z.number().nonnegative(),
    invested: z.number().nonnegative(),
    openPositions: z.number().int().nonnegative(),
    openRiskPct: z.number().nonnegative(),
    grossExposurePct: z.number().nonnegative(),
    riskPolicy: z.object({
      riskPerTradePct: z.number().positive(),
      maxPositions: z.number().int().positive(),
      maxOpenRiskPct: z.number().positive(),
      maxSinglePositionPct: z.number().positive(),
      maxSectorExposurePct: z.number().positive(),
      maxGrossExposurePct: z.number().positive(),
      leverage: z.string(),
      averagingDown: z.boolean(),
      martingale: z.boolean(),
    }),
  }),
  strategies: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      version: z.string(),
      description: z.string(),
      state: z.enum([
        "Research",
        "Validation",
        "Out-of-Sample",
        "Shadow",
        "Live",
      ]),
      enabled: z.boolean(),
      universe: z.string(),
      holdingPeriod: z.string(),
      signalsToday: z.number(),
      openPositions: z.number(),
      parameters: z.record(
        z.string(),
        z.union([z.string(), z.number(), z.boolean()]),
      ),
    }),
  ),
  candidates: z.array(
    z.object({
      symbol: z.string(),
      company: z.string(),
      sector: z.string(),
      marketCap: z.number().nonnegative(),
      price: z.number().nonnegative(),
      quantScore: z.number().min(0).max(100),
      strategyId: z.string(),
      strategyVersion: z.string(),
      strategy: z.string(),
      trend: z.enum(["Strong", "Positive", "Mixed", "Weak"]),
      momentum: z.number(),
      relativeStrength: z.number(),
      relativeVolume: z.number().nonnegative(),
      breakout: z.string().nullable(),
      earningsDate: marketDateSchema.nullable(),
      earningsProximityDays: z.number().nullable(),
      status: z.enum(["Strong Setup", "Watch", "No Setup", "Rejected"]),
      direction: z.enum(["Bullish", "Neutral", "Bearish"]),
      riskFlags: z.array(z.string()),
      updatedAt: isoTimestampSchema,
      reasons: z.array(reason),
    }),
  ),
  events: z.array(
    z.object({
      id: z.string(),
      type: z.string(),
      message: z.string(),
      symbol: z.string().optional(),
      strategyId: z.string().optional(),
      severity: z.enum(["info", "success", "warning", "error"]),
      createdAt: isoTimestampSchema,
    }),
  ),
  earnings: z.array(
    z.object({
      symbol: z.string(),
      company: z.string(),
      date: marketDateSchema,
      timing: z.enum(["BMO", "AMC", "TBD"]),
      eventSignal: z.enum(["Confirmed", "Pending", "Risk Window"]),
      engineRelevant: z.boolean(),
      signal: z
        .enum(["Strong Setup", "Watch", "No Setup", "Rejected"])
        .nullable(),
      strategy: z.string().nullable(),
      hasPosition: z.boolean(),
      tracked: z.boolean(),
      updatedAt: isoTimestampSchema,
    }),
  ),
  positions: z.array(
    z.object({
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
    }),
  ),
  research: z.array(
    z.object({
      id: z.string(),
      strategyId: z.string(),
      strategy: z.string(),
      stage: z.enum([
        "Research",
        "Validation",
        "Out-of-Sample",
        "Shadow",
        "Live",
      ]),
      period: z.string(),
      status: z.enum(["Demo", "Pending", "Complete"]),
      metrics: z.record(z.string(), z.number().nullable()),
    }),
  ),
});

const apiBase = (
  import.meta.env.VITE_API_BASE_URL as string | undefined
)?.replace(/\/$/, "");
const explicitDemo = import.meta.env.VITE_DEMO_MODE !== "false";

export async function getDashboardData(
  signal?: AbortSignal,
): Promise<DashboardData> {
  if (explicitDemo) return demoData;
  // Same-origin by default (worker serves both the SPA and /api/*); override with VITE_API_BASE_URL.
  const url = apiBase ? `${apiBase}/api/dashboard` : "/api/dashboard";
  const response = await fetch(url, {
    signal,
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`Public API returned ${response.status}`);
  return dashboardPayload.parse(await response.json());
}

export { demoData };
