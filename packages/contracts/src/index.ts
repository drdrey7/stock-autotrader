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
 * Explicit provenance for every Earnings metric that can be produced by more
 * than one source. Vague values ("api", "provider", "official") are forbidden.
 */
export type EarningsMetricSource =
  | "sec-xbrl"
  | "sec-filing"
  | "finnhub-consensus"
  | "finnhub-adjusted";

/**
 * Data-quality verdict for the latest reported quarter of an earnings event.
 * Mirrors the backfill audit decision vocabulary:
 *
 * - `match`:        provider actual ≈ official GAAP actual (same basis within tolerance)
 * - `different-basis`: provider actual differs from official GAAP (adjusted vs GAAP)
 * - `conflict`:     provider and SEC disagree on fiscal identity or context
 * - `official-only`: only the SEC GAAP value resolved (provider actual missing)
 * - `finnhub-only`: only the provider value exists (SEC unresolved)
 * - `unresolved`:   audit could not determine a canonical official value
 * - `pending`:      not audited yet (default for new provider events)
 */
export type EarningsDataQualityStatus =
  | "match"
  | "different-basis"
  | "conflict"
  | "official-only"
  | "finnhub-only"
  | "unresolved"
  | "pending";

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
  // Provider-neutral stable company metadata enriched from Finnhub Company
  // Profile 2 and joined from earnings_universe at read time. Null when the
  // company has not been enriched yet; the frontend falls back to a
  // deterministic ticker icon in that case.
  logoUrl: string | null;
  industry: string | null;
  websiteUrl: string | null;
  scheduledDate: string | null;
  scheduledTime: string | null;
  timing: "BMO" | "AMC" | "TBD";
  status: EarningsStatus;
  scheduled: boolean;
  reported: boolean;
  cancelled: boolean;
  unknown: boolean;
  epsEstimate: number | null;
  /**
   * Legacy provider actual, kept for backward compatibility with the UI/API.
   * In production this is the Finnhub calendar actual, which is an
   * adjusted/non-GAAP figure. Prefer the explicit split: `epsActualGaap`
   * (official) vs `epsActualAdjusted` (provider). Never compare this legacy
   * value against `epsEstimate` basis-blind — see `dataQualityStatus`.
   */
  epsActual: number | null;
  epsSurprise: number | null;
  epsSurprisePct: number | null;
  epsResult: EarningsMetricResult;
  revenueEstimate: number | null;
  /**
   * Legacy provider actual (Finnhub calendar, adjusted basis) — same
   * compatibility semantics as `epsActual`. Official quarterly GAAP revenue
   * lives in `revenueActualOfficial`.
   */
  revenueActual: number | null;
  revenueSurprise: number | null;
  revenueSurprisePct: number | null;
  revenueResult: EarningsMetricResult;
  overallResult: EarningsOverallResult;
  reportedAt: string | null;
  reportedAtSource: EarningsMetricSource | null;
  /** Official SEC GAAP diluted EPS for the event's fiscal quarter, when resolved. */
  epsActualGaap: number | null;
  /** Provenance of `epsActualGaap` — `sec-xbrl` in production. */
  epsActualGaapSource: EarningsMetricSource | null;
  /** Provider adjusted/non-GAAP EPS actual, mirrored from the provider path. */
  epsActualAdjusted: number | null;
  /** Provenance of `epsActualAdjusted` — `finnhub-adjusted` in production. */
  epsActualAdjustedSource: EarningsMetricSource | null;
  /** Official GAAP quarterly revenue (never YTD), when resolved. */
  revenueActualOfficial: number | null;
  /** Provenance of `revenueActualOfficial` — `sec-xbrl` in production. */
  revenueActualSource: EarningsMetricSource | null;
  /** Provenance of the consensus estimate — `finnhub-consensus` in production. */
  epsEstimateSource: EarningsMetricSource | null;
  /** Provenance of the revenue estimate — `finnhub-consensus` in production. */
  revenueEstimateSource: EarningsMetricSource | null;
  /**
   * Audit/quality verdict for the latest reported quarter. NULL/pending means
   * the official-metric enrichment has not resolved this event yet.
   */
  dataQualityStatus: EarningsDataQualityStatus | null;
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
  next30Days: number;
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

export * from "./primitives";
export * from "./daily-briefing";
export * from "./briefing-universe";
export * from "./core-universe";
export * from "./source-health";
export * from "./quotes";
export * from "./stock-detail";
export * from "./intrinsic-value";
export * from "./dashboard";
export * from "./ai-analysis";

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
