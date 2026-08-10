export type SignalStatus = "Strong Setup" | "Watch" | "No Setup" | "Rejected";
export type Direction = "Bullish" | "Neutral" | "Bearish";
export type TrendStrength = "Strong" | "Positive" | "Mixed" | "Weak";

export interface DecisionReason {
  id: string;
  outcome: "pass" | "reject" | "info";
  code: string;
  label: string;
  observed?: string;
  threshold?: string;
}

export interface Candidate {
  symbol: string;
  company: string;
  sector: string;
  marketCap: number;
  price: number;
  quantScore: number;
  strategyId: string;
  strategyVersion: string;
  strategy: string;
  trend: TrendStrength;
  momentum: number;
  relativeStrength: number;
  relativeVolume: number;
  earningsDate: string | null;
  earningsProximityDays: number | null;
  status: SignalStatus;
  direction: Direction;
  updatedAt: string;
  reasons: DecisionReason[];
}

export interface StrategySummary {
  id: string;
  name: string;
  version: string;
  description: string;
  state: "Research" | "Validation" | "Out-of-Sample" | "Shadow" | "Live";
  enabled: boolean;
  universe: string;
  holdingPeriod: string;
  signalsToday: number;
  openPositions: number;
  parameters: Record<string, string | number | boolean>;
}

export interface BotEvent {
  id: string;
  type: string;
  message: string;
  symbol?: string;
  strategyId?: string;
  severity: "info" | "success" | "warning" | "error";
  createdAt: string;
}

export interface EarningsEvent {
  symbol: string;
  company: string;
  date: string;
  timing: "BMO" | "AMC" | "TBD";
  eventSignal: "Confirmed" | "Pending" | "Risk Window";
  strategies: string[];
  tracked: boolean;
}

export interface ShadowPosition {
  symbol: string;
  strategy: string;
  entryPrice: number;
  currentPrice: number;
  stopPrice: number;
  quantity: number;
  riskAmount: number;
  unrealizedPnl: number;
  rMultiple: number;
  openedAt: string;
}

export interface ResearchResult {
  id: string;
  strategyId: string;
  strategy: string;
  stage: "Research" | "Validation" | "Out-of-Sample" | "Shadow" | "Live";
  period: string;
  status: "Demo" | "Pending" | "Complete";
  metrics: Record<string, number | null>;
}

export interface DashboardData {
  demo: boolean;
  status: {
    engine: "online" | "offline" | "delayed";
    latestScan: string | null;
    nextScan: string | null;
    lastDataUpdate: string | null;
    apiHealth: "healthy" | "degraded";
  };
  scan: {
    universe: number;
    passedFilters: number;
    candidates: number;
    setups: number;
  };
  portfolio: {
    initialCapital: number;
    equity: number;
    returnPct: number;
    openPositions: number;
    openRiskPct: number;
    grossExposurePct: number;
    maxPositions: number;
    maxOpenRiskPct: number;
    maxGrossExposurePct: number;
  };
  strategies: StrategySummary[];
  candidates: Candidate[];
  events: BotEvent[];
  earnings: EarningsEvent[];
  positions: ShadowPosition[];
  research: ResearchResult[];
}

export interface AiEventAssessment {
  symbol: string;
  eventStatus: "CONFIRM" | "REVIEW" | "REJECT";
  riskLevel: "LOW" | "MEDIUM" | "HIGH";
  earningsRisk: boolean;
  materialEvent: boolean;
  summary: string;
  sources: Array<{ title: string; url: string; publishedAt?: string }>;
}

export const API_PATHS = {
  status: "/api/status",
  latestScan: "/api/scans/latest",
  candidates: "/api/candidates",
  strategies: "/api/strategies",
  research: "/api/research",
  backtests: "/api/backtests",
  shadowPortfolio: "/api/portfolio/shadow",
  shadowTrades: "/api/trades/shadow",
  earnings: "/api/earnings",
  activity: "/api/activity",
} as const;
