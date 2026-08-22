/**
 * fundamentals-ingestor configuration.
 *
 * Centralises every tunable knob: SEC EDGAR endpoints + pacing, D1 database
 * name, wrangler pin, logging. Secrets (Cloudflare API token, SEC User-Agent
 * contact) live in EnvironmentFiles provisioned by the systemd installer —
 * never here.
 */

export interface FundamentalsConfig {
  readonly secUserAgent: string;
  readonly secPaceMs: number;
  readonly secCompanyfactsUrl: string;
  readonly secTickersUrl: string;
  readonly dbName: string;
  readonly wranglerVersion: string;
  readonly batchSize: number;
}

const DEFAULT_CONFIG: FundamentalsConfig = {
  secUserAgent: "StockAutotrader research contact@barroso-labs.com",
  secPaceMs: 1100,
  secCompanyfactsUrl: "https://data.sec.gov/api/xbrl/companyfacts",
  secTickersUrl: "https://www.sec.gov/files/company_tickers_exchange.json",
  dbName: "stock-autotrader-db",
  wranglerVersion: "4.122.0",
  batchSize: 50,
};

export function loadConfig(overrides: Partial<FundamentalsConfig> = {}): FundamentalsConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}