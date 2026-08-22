# fundamentals-ingestor

Canonical SEC EDGAR → D1 fundamentals pipeline for Stock Autotrader.

## Architecture

```
SEC EDGAR (data.sec.gov)
        ↓
fundamentals-ingestor (VPS/Hermes, async)
        ↓
Cloudflare D1 (stock_fundamental_periods + stock_fundamental_snapshots)
        ↓
Cloudflare Worker (serving-only, no SEC calls on page load)
        ↓
Stock Detail API (v2)
        ↓
Stock Detail frontend
```

The browser **never** calls SEC. The Worker **never** calls SEC during a page request. The VPS is compute/ingestion only. If the VPS is offline, the site continues to serve the latest persisted fundamentals.

## SEC Source

- **Primary:** SEC EDGAR `companyfacts` API (`data.sec.gov/api/xbrl/companyfacts/CIK{cik}.json`)
- **Ticker→CIK map:** `https://www.sec.gov/files/company_tickers_exchange.json`
- **User-Agent:** `StockAutotrader research contact@barroso-labs.com` (required by SEC, verified 2026-08-17)
- **No API key required.**

## Supported Taxonomies

- `us-gaap` (US filers — AAPL, ADBE, MSFT, NVDA, etc.)
- `ifrs-full` (foreign issuers — ASML, NVO, TSM)
- `dei` (entity metadata, used only for `shares_outstanding` when absent from GAAP/IFRS)

Taxonomy priority: `us-gaap` first → `ifrs-full` → `dei`. The first taxonomy with a matching fact wins; concepts are never mixed across taxonomies in a single decision.

## Supported Filing Forms

- `10-Q` (quarterly)
- `10-K` (annual)
- `20-F` (foreign annual)
- `40-F` (Canadian annual)
- `6-K` (foreign interim, only when data can be proven safe)

## Normalization Philosophy

1. **Never trust an arbitrary XBRL fact just because the name looks right.**
2. Each canonical field maps to an explicit `(taxonomy, concept, unit, priority)` list.
3. A field is only resolved when ALL of these hold:
   - concept matches one of the accepted XBRL concepts
   - unit matches exactly
   - fiscal identity is provably comparable
   - the fact comes from an accepted form
   - no conflicting values exist for the same period/context
4. Anything less → `null` with an explicit blocker reason.
5. **Never fabricate or estimate.** Null is a valid value.

## Canonical Fields

| Field | Typical Concept (US GAAP) | Unit |
|-------|---------------------------|------|
| revenue | RevenueFromContractWithCustomerExcludingAssessedTax | USD |
| gross_profit | GrossProfit | USD |
| operating_income | OperatingIncomeLoss | USD |
| pretax_income | IncomeLossFromContinuingOperationsBeforeIncomeTaxes... | USD |
| income_tax | IncomeTaxExpenseBenefit | USD |
| net_income | NetIncomeLoss | USD |
| diluted_eps | EarningsPerShareDiluted | USD/shares |
| operating_cash_flow | NetCashProvidedByUsedInOperatingActivities | USD |
| capex | PaymentsToAcquirePropertyPlantAndEquipment | USD |
| depreciation_amortization | DepreciationDepletionAndAmortization | USD |
| free_cash_flow | (derived) | USD |
| cash | CashAndCashEquivalentsAtCarryingValue | USD |
| short_term_investments | ShortTermInvestments | USD |
| total_debt | LongTermDebt | USD |
| total_assets | Assets | USD |
| total_liabilities | Liabilities | USD |
| shareholders_equity | StockholdersEquity | USD |
| current_assets | AssetsCurrent | USD |
| current_liabilities | LiabilitiesCurrent | USD |
| weighted_avg_diluted_shares | WeightedAverageNumberOfDilutedSharesOutstanding | shares |
| shares_outstanding | CommonStockSharesOutstanding | shares |

## Formulas

### Market Cap
`Market Cap = current price × latest shares outstanding` (computed in Worker from live quote)

### P/E TTM
`P/E = current price / diluted EPS TTM` (null when EPS TTM ≤ 0)

### Free Cash Flow
`FCF = Operating Cash Flow − CapEx` (CapEx normalized to positive magnitude)

### FCF Margin
`FCF Margin = FCF TTM / Revenue TTM × 100`

### Debt / Equity
`D/E = Total Debt / Shareholders' Equity` (null when equity ≤ 0)

### ROIC
```
Effective Tax Rate = Income Tax TTM / Pretax Income TTM
NOPAT = Operating Income TTM × (1 − Effective Tax Rate)
Invested Capital = Total Debt + Shareholders' Equity − Cash − Short-Term Investments
ROIC = NOPAT / Average Invested Capital × 100
```
Guards: tax rate must be in [0, 1]; invested capital must be > 0; no silent 21% tax rate fill.

## Quarter / YTD / TTM Resolution

- **Discrete quarters** derived when provably comparable:
  - Q2 = H1 − Q1
  - Q3 = 9M − H1
  - Q4 = FY − 9M
- **TTM preference:** last 4 discrete quarters
- **TTM fallback:** latest FY + current YTD − prior-year YTD (only when fiscal identity provably equivalent)
- Anything unprovable → `null` + blocker

## CLI Commands

```bash
# Audit (read-only, no D1 write)
npx tsx apps/fundamentals-ingestor/src/cli.ts audit --symbol ADBE
npx tsx apps/fundamentals-ingestor/src/cli.ts audit --all-core

# Bootstrap (fetch SEC + normalize + write D1)
npx tsx apps/fundamentals-ingestor/src/cli.ts bootstrap --symbol ADBE --local
npx tsx apps/fundamentals-ingestor/src/cli.ts bootstrap --all-core --remote --apply

# Maintenance (incremental, detect new filings)
npx tsx apps/fundamentals-ingestor/src/cli.ts maintenance --all-core --remote --apply
```

## D1 Tables

### `stock_fundamental_periods`
One row per `(symbol, fiscal_year, fiscal_period)`. Contains all normalized fields + provenance JSON.

### `stock_fundamental_snapshots`
One row per `symbol`. Latest TTM/derived view. The Worker reads this table only — never periods.

## Systemd Deployment

Timer: daily at 08:30 UTC. RandomizedDelaySec 15m. Persistent=true.

**Install (root):**
```bash
sudo bash apps/fundamentals-ingestor/deploy/install-fundamentals-ingestor-root.sh
sudo systemctl enable fundamentals-ingestor-maintenance.timer
sudo systemctl start fundamentals-ingestor-maintenance.timer
```

Runtime: `User=hermes`, `Group=hermes`. Hardened with `ProtectSystem=full`, `ProtectHome=read-only`, `PrivateTmp=true`, `NoNewPrivileges=true`.

## Secrets

- **No SEC API key needed.**
- Cloudflare/D1 credentials live in `/etc/stock-autotrader/cloudflare.env` (EnvironmentFile, outside repo).
- No secrets in the repo. No `.env` files committed.
- No tokens in logs.

## Recovery / Failure Behavior

- SEC offline: previous snapshot preserved, site works
- Single symbol failure: does not block others
- Dubious field: only that field is null
- D1 write failure: run is not marked success
- Maintenance death: next run safely resumes

## How to Add a New XBRL Concept Safely

1. Add a new entry to `CONCEPT_MAPPINGS[field]` in `src/concepts.ts` with explicit `(taxonomy, concept, unit, priority)`.
2. Add unit tests covering: valid match, unit rejection, fiscal identity mismatch, ambiguous facts.
3. Run `npx vitest run` and `npx tsc --noEmit`.
4. Verify via `audit --symbol <known-filer>` against official SEC filings.

## Non-Goals (future PRs)

- DCF valuation
- Multiples valuation
- Bear/Base/Bull scenarios
- AI analysis
- TradingAgents
- Screener undervalued/overvalued filters
- Redesign visual
- Alpha Spread scraping
- Alpha Vantage fundamentals (unless SEC genuinely cannot cover a concrete case)
