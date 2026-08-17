import type {
  EarningsDataQualityStatus,
  EarningsEngineEvent,
  EarningsMetricResult,
  EarningsMetricSource,
  EarningsOverallResult,
  EarningsStatus,
} from "@stock-autotrader/contracts";

export interface EarningsDateRange {
  from: string;
  to: string;
}

export interface OfficialFiling {
  url: string;
  accession: string;
  form: string;
  filedAt: string;
  reportDate: string | null;
  items: string[];
}

export interface EarningsCalendarObservation {
  symbol: string;
  company: string | null;
  scheduledDate: string | null;
  scheduledTime: string | null;
  timing: "BMO" | "AMC" | "TBD";
  fiscalYear: number | null;
  fiscalQuarter: number | null;
  fiscalPeriod: string | null;
  fiscalPeriodEnd: string | null;
  epsEstimate: number | null;
  revenueEstimate: number | null;
  epsActual: number | null;
  revenueActual: number | null;
  providerEventId: string | null;
  providerUpdatedAt: string | null;
  officialReportUrl: string | null;
  officialFiling?: OfficialFiling;
  cancelled?: boolean;
  // Provider-declared provenance. The production Finnhub adapter tags its
  // estimates as consensus and its calendar actuals as adjusted/non-GAAP;
  // SEC-derived observations never carry these.
  epsEstimateSource?: "finnhub-consensus";
  revenueEstimateSource?: "finnhub-consensus";
  epsActualAdjusted?: number | null;
  epsActualAdjustedSource?: "finnhub-adjusted";
}

export interface EarningsConsensusObservation {
  symbol: string;
  scheduledDate: string | null;
  fiscalYear: number | null;
  fiscalQuarter: number | null;
  fiscalPeriodEnd: string | null;
  epsEstimate: number | null;
  revenueEstimate: number | null;
  epsActual: number | null;
  revenueActual: number | null;
  providerEventId: string | null;
  providerUpdatedAt: string | null;
  cancelled?: boolean;
}

export interface EarningsProviderResult<T> {
  provider: string;
  observations: T[];
  warnings: string[];
  updatedAt: string;
  /** False means the provider returned a partial/incomplete view. */
  complete?: boolean;
}

export interface EarningsCalendarProvider {
  readonly name: string;
  /** False when the adapter only knows filed/past events and cannot authoritatively reconcile future dates. */
  readonly supportsForwardCalendar?: boolean;
  fetchCalendar(
    range: EarningsDateRange,
    universe: ReadonlySet<string>,
    collectedAt: string,
  ): Promise<EarningsProviderResult<EarningsCalendarObservation>>;
  /**
   * Optional targeted historical query for one symbol. Used by the daily
   * recovery pass for active Core symbols whose recent reported history is
   * missing from the bulk calendar response. Absent on adapters that cannot
   * scope a query to a symbol.
   */
  fetchSymbolHistory?(
    symbol: string,
    range: EarningsDateRange,
    collectedAt: string,
  ): Promise<EarningsProviderResult<EarningsCalendarObservation>>;
}

export interface EarningsConsensusProvider {
  readonly name: string;
  fetchConsensus(
    range: EarningsDateRange,
    universe: ReadonlySet<string>,
    collectedAt: string,
  ): Promise<EarningsProviderResult<EarningsConsensusObservation>>;
}

export interface CompanyMetadata {
  symbol: string;
  company: string;
  cik: string | null;
  exchange: string | null;
  investorRelationsUrl?: string | null;
}

/**
 * Stable company profile metadata from Finnhub Company Profile 2. All fields
 * are optional on the wire; only `symbol` must survive normalization.
 */
export interface CompanyProfileObservation {
  symbol: string;
  company: string | null;
  logoUrl: string | null;
  industry: string | null;
  websiteUrl: string | null;
  exchange: string | null;
}

export interface CompanyProfileProvider {
  readonly name: string;
  fetchProfile(symbol: string, collectedAt: string): Promise<CompanyProfileObservation>;
}

export interface OfficialFilingsProvider {
  readonly name: string;
  fetchCompanyMetadata(collectedAt: string): Promise<EarningsProviderResult<CompanyMetadata>>;
  findRelevantFiling(
    event: Pick<EarningsEngineEvent, "scheduledDate" | "fiscalPeriodEnd" | "cik">,
    asOf: string,
  ): Promise<OfficialFiling | null>;
}

export interface EarningsProviderBundle {
  calendar: EarningsCalendarProvider;
  consensus: EarningsConsensusProvider;
  official: OfficialFilingsProvider;
  /**
   * Best-effort company profile enrichment (Finnhub Company Profile 2 in
   * production). Never on the critical earnings path: provider/profile
   * failures must not degrade the calendar/monitor health gate.
   */
  profile?: CompanyProfileProvider;
}

export interface NormalizedEarningsEvent {
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
  reportedAtSource: EarningsMetricSource | null;
  epsActualGaap: number | null;
  epsActualGaapSource: EarningsMetricSource | null;
  epsActualAdjusted: number | null;
  epsActualAdjustedSource: EarningsMetricSource | null;
  revenueActualOfficial: number | null;
  revenueActualSource: EarningsMetricSource | null;
  epsEstimateSource: EarningsMetricSource | null;
  revenueEstimateSource: EarningsMetricSource | null;
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
  // Read-model-only company metadata: joined from earnings_universe at read
  // time, never written through the event write path (which owns the
  // earnings_events columns only).
  logoUrl: string | null;
  industry: string | null;
  websiteUrl: string | null;
}
