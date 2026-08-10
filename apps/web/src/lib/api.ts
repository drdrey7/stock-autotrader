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
const dashboardPayload = z.object({
  demo: z.boolean(),
  status: z.object({
    engine: z.enum(["online", "offline", "delayed"]),
    latestScan: z.string().nullable(),
    nextScan: z.string().nullable(),
    lastDataUpdate: z.string().nullable(),
    apiHealth: z.enum(["healthy", "degraded"]),
  }),
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
      earningsDate: z.string().nullable(),
      earningsProximityDays: z.number().nullable(),
      status: z.enum(["Strong Setup", "Watch", "No Setup", "Rejected"]),
      direction: z.enum(["Bullish", "Neutral", "Bearish"]),
      updatedAt: z.string(),
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
      createdAt: z.string(),
    }),
  ),
  earnings: z.array(
    z.object({
      symbol: z.string(),
      company: z.string(),
      date: z.string(),
      timing: z.enum(["BMO", "AMC", "TBD"]),
      eventSignal: z.enum(["Confirmed", "Pending", "Risk Window"]),
      strategies: z.array(z.string()),
      tracked: z.boolean(),
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
      rMultiple: z.number(),
      openedAt: z.string(),
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
  if (!apiBase || explicitDemo) return demoData;
  const response = await fetch(`${apiBase}/api/dashboard`, {
    signal,
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`Public API returned ${response.status}`);
  return dashboardPayload.parse(await response.json());
}

export { demoData };
