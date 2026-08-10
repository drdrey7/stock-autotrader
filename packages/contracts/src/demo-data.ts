import type { DashboardData, DecisionReason } from "./index";

const positiveReasons: DecisionReason[] = [
  { id: "r1", outcome: "pass", code: "MARKET_REGIME", label: "Market regime positive", observed: "SPY above EMA200" },
  { id: "r2", outcome: "pass", code: "EMA_STACK", label: "Above EMA20 / EMA50 / EMA200", observed: "Positive stack" },
  { id: "r3", outcome: "pass", code: "RELATIVE_STRENGTH", label: "Relative strength vs SPY positive", observed: "+8.4% over 3M" },
  { id: "r4", outcome: "pass", code: "BREAKOUT_50D", label: "50-day breakout", observed: "Close above prior high" },
  { id: "r5", outcome: "pass", code: "VOLUME_CONFIRM", label: "Volume confirmation", observed: "1.7x ADV20", threshold: ">= 1.5x" },
  { id: "r6", outcome: "pass", code: "EARNINGS_WINDOW", label: "Earnings outside risk window", observed: "21 days away" }
];

export const demoData: DashboardData = {
  demo: true,
  status: {
    engine: "online",
    latestScan: "2026-08-10T20:15:00Z",
    nextScan: "2026-08-11T12:30:00Z",
    lastDataUpdate: "2026-08-10T20:16:12Z",
    apiHealth: "healthy"
  },
  scan: { universe: 1648, passedFilters: 972, candidates: 14, setups: 3 },
  portfolio: { initialCapital: 5000, equity: 5143, returnPct: 2.86, openPositions: 2, openRiskPct: 0.92 },
  strategies: [
    { id: "trend_breakout_v1", name: "Trend Breakout", version: "1.0.0", description: "Trend, relative-strength and volume-confirmed breakouts in liquid US equities.", state: "Shadow", enabled: true, universe: "US Core ≥ $1B", holdingPeriod: "5–30 sessions", signalsToday: 2, openPositions: 1, parameters: { breakoutWindow: "20D / 50D", minRelativeVolume: 1.5, earningsBufferDays: 5 } },
    { id: "post_earnings_v1", name: "Post Earnings", version: "1.0.0", description: "Price and volume follow-through after a confirmed earnings event.", state: "Research", enabled: true, universe: "US Core ≥ $1B", holdingPeriod: "2–20 sessions", signalsToday: 1, openPositions: 1, parameters: { eventWindowDays: 5, minGapPct: 3, minRelativeVolume: 1.8 } }
  ],
  candidates: [
    { symbol: "NVDA", company: "NVIDIA Corporation", sector: "Technology", marketCap: 4100000000000, price: 182.64, quantScore: 89, strategyId: "trend_breakout_v1", strategy: "Trend Breakout", trend: "Strong", momentum: 91, relativeStrength: 88, relativeVolume: 1.7, earningsDate: "2026-08-26", earningsProximityDays: 16, status: "Strong Setup", direction: "Bullish", updatedAt: "2026-08-10T20:15:00Z", reasons: positiveReasons },
    { symbol: "NOW", company: "ServiceNow, Inc.", sector: "Technology", marketCap: 205000000000, price: 104.21, quantScore: 82, strategyId: "trend_breakout_v1", strategy: "Trend Breakout", trend: "Positive", momentum: 84, relativeStrength: 79, relativeVolume: 1.42, earningsDate: "2026-10-28", earningsProximityDays: 79, status: "Watch", direction: "Bullish", updatedAt: "2026-08-10T20:15:00Z", reasons: positiveReasons.slice(0, 4) },
    { symbol: "AMD", company: "Advanced Micro Devices, Inc.", sector: "Technology", marketCap: 298000000000, price: 184.32, quantScore: 77, strategyId: "post_earnings_v1", strategy: "Post Earnings", trend: "Positive", momentum: 80, relativeStrength: 74, relativeVolume: 2.1, earningsDate: "2026-08-04", earningsProximityDays: -6, status: "Watch", direction: "Bullish", updatedAt: "2026-08-10T20:15:00Z", reasons: positiveReasons.slice(0, 5) },
    { symbol: "META", company: "Meta Platforms, Inc.", sector: "Communication Services", marketCap: 1900000000000, price: 768.52, quantScore: 63, strategyId: "trend_breakout_v1", strategy: "Trend Breakout", trend: "Mixed", momentum: 62, relativeStrength: 55, relativeVolume: 0.94, earningsDate: "2026-10-21", earningsProximityDays: 72, status: "No Setup", direction: "Neutral", updatedAt: "2026-08-10T20:15:00Z", reasons: [{ id: "rr1", outcome: "reject", code: "VOLUME", label: "Volume below confirmation threshold", observed: "0.94x", threshold: ">= 1.5x" }] },
    { symbol: "TSLA", company: "Tesla, Inc.", sector: "Consumer Cyclical", marketCap: 1090000000000, price: 338.45, quantScore: 42, strategyId: "trend_breakout_v1", strategy: "Trend Breakout", trend: "Weak", momentum: 38, relativeStrength: 33, relativeVolume: 0.81, earningsDate: "2026-10-14", earningsProximityDays: 65, status: "Rejected", direction: "Bearish", updatedAt: "2026-08-10T20:15:00Z", reasons: [{ id: "rr2", outcome: "reject", code: "RELATIVE_STRENGTH", label: "Relative strength below threshold", observed: "33 / 100", threshold: ">= 60" }] }
  ],
  events: [
    { id: "e1", type: "SCAN_COMPLETED", message: "Post-close scan completed: 14 candidates, 3 setups", severity: "success", createdAt: "2026-08-10T20:16:12Z" },
    { id: "e2", type: "SIGNAL_CREATED", message: "Strong setup created for NVDA", symbol: "NVDA", strategyId: "trend_breakout_v1", severity: "success", createdAt: "2026-08-10T20:15:41Z" },
    { id: "e3", type: "SIGNAL_REJECTED", message: "TSLA rejected: relative strength below threshold", symbol: "TSLA", strategyId: "trend_breakout_v1", severity: "warning", createdAt: "2026-08-10T20:15:22Z" },
    { id: "e4", type: "FILTER_COMPLETED", message: "972 securities passed core universe filters", severity: "info", createdAt: "2026-08-10T20:14:03Z" },
    { id: "e5", type: "SCAN_STARTED", message: "Post-close scan started", severity: "info", createdAt: "2026-08-10T20:12:00Z" }
  ],
  earnings: [
    { symbol: "NVDA", company: "NVIDIA Corporation", date: "2026-08-26", timing: "AMC", eventSignal: "Pending", strategies: ["Trend Breakout"], tracked: true },
    { symbol: "CRM", company: "Salesforce, Inc.", date: "2026-08-27", timing: "AMC", eventSignal: "Pending", strategies: ["Post Earnings"], tracked: true },
    { symbol: "AMD", company: "Advanced Micro Devices, Inc.", date: "2026-08-04", timing: "AMC", eventSignal: "Confirmed", strategies: ["Post Earnings"], tracked: true },
    { symbol: "PLTR", company: "Palantir Technologies Inc.", date: "2026-08-03", timing: "AMC", eventSignal: "Confirmed", strategies: ["Post Earnings"], tracked: false }
  ],
  positions: [
    { symbol: "NVDA", strategy: "Trend Breakout", entryPrice: 177.2, currentPrice: 182.64, stopPrice: 169.4, quantity: 3, riskAmount: 23.4, unrealizedPnl: 16.32, rMultiple: 0.7, openedAt: "2026-08-06T14:35:00Z" },
    { symbol: "AMD", strategy: "Post Earnings", entryPrice: 179.8, currentPrice: 184.32, stopPrice: 172.1, quantity: 3, riskAmount: 23.1, unrealizedPnl: 13.56, rMultiple: 0.59, openedAt: "2026-08-05T13:45:00Z" }
  ],
  research: [
    { id: "bt1", strategyId: "trend_breakout_v1", strategy: "Trend Breakout V1", stage: "Research", period: "2010–2024", status: "Demo", metrics: { cagr: 12.4, totalReturn: 418.2, maxDrawdown: -21.3, profitFactor: 1.42, expectancy: 0.31, sharpe: 1.08, sortino: 1.51, calmar: 0.58, trades: 684, winRate: 44.8, averageWin: 6.2, averageLoss: -3.1, exposure: 61.4, averageHoldingPeriod: 13.2 } },
    { id: "bt2", strategyId: "post_earnings_v1", strategy: "Post Earnings V1", stage: "Research", period: "2010–2024", status: "Demo", metrics: { cagr: 9.8, totalReturn: 306.1, maxDrawdown: -18.7, profitFactor: 1.31, expectancy: 0.24, sharpe: 0.92, sortino: 1.29, calmar: 0.52, trades: 491, winRate: 47.1, averageWin: 5.1, averageLoss: -3.3, exposure: 42.8, averageHoldingPeriod: 8.6 } }
  ]
};

