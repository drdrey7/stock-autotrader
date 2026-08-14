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
  breakout: string | null;
  earningsDate: string | null;
  earningsProximityDays: number | null;
  status: SignalStatus;
  direction: Direction;
  riskFlags: string[];
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
  engineRelevant: boolean;
  signal: SignalStatus | null;
  strategy: string | null;
  hasPosition: boolean;
  tracked: boolean;
  updatedAt: string;
}

export type EarningsStatus = "scheduled" | "reported" | "cancelled" | "unknown";
export type EarningsMetricResult = "Beat" | "In Line" | "Miss" | "Not Available";
export type EarningsOverallResult = "Beat" | "In Line" | "Miss" | "Mixed" | "Not Available";

/**
 * Cloudflare-owned earnings read model. This is intentionally provider-neutral:
 * consumers must not depend on Finnhub, SEC, or another adapter's field names.
 */
export interface EarningsEngineEvent {
  id: string;
  symbol: string;
  company: string;
  cik: string | null;
  fiscalYear: number | null;
  fiscalQuarter: number | null;
  fiscalPeriod: string | null;
  fiscalPeriodEnd: string | null;
  scheduledDate: string | null;
  scheduledTime: string | null;
  timing: "BMO" | "AMC" | "TBD";
  status: EarningsStatus;
  scheduled: boolean;
  reported: boolean;
  cancelled: boolean;
  unknown: boolean;
  epsEstimate: number | null;
  epsActual: number | null;
  epsSurprise: number | null;
  epsSurprisePct: number | null;
  epsResult: EarningsMetricResult;
  revenueEstimate: number | null;
  revenueActual: number | null;
  revenueSurprise: number | null;
  revenueSurprisePct: number | null;
  revenueResult: EarningsMetricResult;
  overallResult: EarningsOverallResult;
  reportedAt: string | null;
  calendarProvider: string | null;
  consensusProvider: string | null;
  providerEventId: string | null;
  providerUpdatedAt: string | null;
  officialReportUrl: string | null;
  investorRelationsUrl: string | null;
  secFilingUrl: string | null;
  secAccession: string | null;
  secForm: string | null;
  secFiledAt: string | null;
  createdAt: string;
  updatedAt: string;
  lastCheckedAt: string | null;
}

export interface EarningsApiSummary {
  today: number;
  thisWeek: number;
  next60Days: number;
}

export interface EarningsApiResponse {
  events: EarningsEngineEvent[];
  summary: EarningsApiSummary;
  from: string;
  to: string;
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
  returnPct: number;
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

export interface MarketDataSnapshot {
  provider: string;
  status: "healthy" | "degraded" | "offline";
  asOf: string | null;
  lastSuccessfulUpdate: string | null;
  universe: {
    total: number;
    eligible: number;
    excluded: number;
  };
  benchmarks: Array<{
    symbol: string;
    date: string;
    open: number;
    high: number;
    low: number;
    close: number;
    adjustedClose: number;
    volume: number;
  }>;
  /** Legacy read compatibility; new context is owned by market_indices. */
  indices?: Array<{
    symbol: "SPX" | "NDX" | "DJI" | "VIX";
    name: string;
    value: number;
    change: number;
    updatedAt: string;
  }>;
  warnings: string[];
  updatedAt: string | null;
}

export * from "./daily-briefing";
export * from "./briefing-universe";
export * from "./source-health";
export * from "./dashboard";

export interface DashboardData {
  demo: boolean;
  status: {
    engine: "online" | "offline" | "delayed";
    latestScan: string | null;
    nextScan: string | null;
    lastDataUpdate: string | null;
    apiHealth: "healthy" | "degraded";
  };
  marketData: MarketDataSnapshot;
  scan: {
    universe: number;
    passedFilters: number;
    candidates: number;
    setups: number;
    watch: number;
  };
  portfolio: {
    initialCapital: number;
    equity: number;
    returnPct: number;
    cash: number;
    invested: number;
    openPositions: number;
    openRiskPct: number;
    grossExposurePct: number;
    riskPolicy: {
      riskPerTradePct: number;
      maxPositions: number;
      maxOpenRiskPct: number;
      maxSinglePositionPct: number;
      maxSectorExposurePct: number;
      maxGrossExposurePct: number;
      leverage: string;
      averagingDown: boolean;
      martingale: boolean;
    };
  };
  strategies: StrategySummary[];
  candidates: Candidate[];
  events: BotEvent[];
  earnings: EarningsEvent[];
  positions: ShadowPosition[];
  research: ResearchResult[];
}
