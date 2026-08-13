import type {
  EarningsEngineEvent,
  EarningsMetricResult,
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
