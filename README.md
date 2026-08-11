# Stock Autotrader — Public Frontend

Public, read-only frontend for a systematic US stock research and swing-trading engine.

This repository contains the public read-only frontend, the Cloudflare Worker/D1
read model and the private VPS runtime foundation. PR #5 adds a deterministic,
reproducible CSV market-data provider and universe pipeline. No broker, automatic
orders or live trading is included.

## What's included

- Landing page — Data. Analysis. Opportunity.
- Public dashboard, scanner and stock analysis views
- Strategies, research/backtests, shadow portfolio, earnings, activity and status
- Methodology and disclaimer pages
- Responsive mobile + desktop layouts
- Deterministic CSV market-data provider: universe normalization/filtering, OHLCV validation, SPY/QQQ benchmarks, freshness checks and atomic cache
- Private VPS runtime: scheduler, SQLite ledger, health and publishing bridge
- Cloudflare Worker/D1 ingest and public API read model
- Central demo/mock data in `packages/contracts/src/demo-data.ts`
- Frontend, Python publisher and runtime tests, lint, typecheck and production build

## What's not included (later PRs)

- Python quant features, strategies, risk, portfolio and backtester
- AI schemas/providers, TradingView MCP, Firecrawl
- External market-data API provider credentials or network ingestion
- IBKR or any broker integration
- Automatic/live trading
- Docker for the bot/VPS

## Development

Prerequisites: Node 20+ (22 recommended), npm.

```bash
npm ci
npm run dev
```

The web app opens at `http://localhost:5173` and runs in demo mode by default
(`VITE_DEMO_MODE !== "false"`). Every demo number comes from the central
`demo-data.ts` fixture and every affected view is labelled **Demo Data**.

To point at a future public API, set `VITE_DEMO_MODE=false` and
`VITE_API_BASE_URL` (see `.env.example`).

## Market-data pipeline (PR #5)

The private runtime reads two files from `MARKET_DATA_DIR`:

- `universe.csv`: `symbol,company,sector,exchange,security_type,index_membership,active,market_cap,avg_volume,price`
- `bars.csv`: `symbol,date,open,high,low,close,adjusted_close,volume`

The CSV adapter is intentionally network-free and reproducible. It accepts only
active common stocks/ADRs from the SP500/NASDAQ core universe, normalizes symbols,
requires positive finite OHLCV values and validates SPY/QQQ freshness (default:
three days). Invalid, missing, stale or future market data produces a degraded
snapshot with explicit warnings and never becomes healthy silently. `adjusted_close` is the provider's
corporate-action-adjusted field when supplied.

```bash
cd bot
python -m bot market-data --no-cache       # validate and print public snapshot
python -m bot market-data                  # validate and write latest.json
python -m bot market-data --publish        # validate, cache and publish to D1
```

`--publish` requires `INGEST_SECRET`; production publication is HMAC-signed through
`MARKET_DATA_UPDATED`. The scheduler's hourly `data_refresh` job runs the same
pipeline and records the result in the local SQLite health ledger.

## Quality gates

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

## Project structure

```text
apps/web                 React 19 + TypeScript + Vite public UI
apps/web/worker          Cloudflare Worker routes, protected ingest and D1 read model
bot/bot                  Private Python runtime, scheduler, state and market-data pipeline
packages/contracts       Shared TypeScript types and central demo fixtures
```

## Disclaimer

Stock Autotrader provides model-generated research for educational and
informational purposes. Strong Setup, Watch, No Setup, Bullish, Neutral and
Bearish are model labels, not personalised investment advice. Demo data,
backtests and shadow portfolios are hypothetical and do not guarantee future
results.
