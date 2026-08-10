# Stock Autotrader — Public Frontend

Public, read-only frontend for a systematic US stock research and swing-trading engine.

This repository currently contains **only the public frontend foundation**:
UI, routing, shared demo data and frontend tooling. It runs entirely on a
central demo-data adapter — no backend, database, broker, AI or live market
data is required or included in this PR.

Backend, D1, quant engine, VPS and AI are intentionally deferred to later PRs.

## What's included

- Landing page — Data. Analysis. Opportunity.
- Public dashboard, scanner and stock analysis views
- Strategies, research/backtests, shadow portfolio, earnings, activity and status
- Methodology and disclaimer pages
- Responsive mobile + desktop layouts
- Central demo/mock data in `packages/contracts/src/demo-data.ts`
- Frontend tests, lint, typecheck and production build

## What's not included (later PRs)

- Python quant engine, strategies, risk, portfolio and backtester
- FastAPI/backend and Cloudflare Worker API
- AI schemas/providers, TradingView MCP, Firecrawl
- Market-data providers, scheduler, VPS worker/deployment
- IBKR or any broker integration
- Database/D1 schema and migrations
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
packages/contracts       Shared TypeScript types and central demo fixtures
```

## Disclaimer

Stock Autotrader provides model-generated research for educational and
informational purposes. Strong Setup, Watch, No Setup, Bullish, Neutral and
Bearish are model labels, not personalised investment advice. Demo data,
backtests and shadow portfolios are hypothetical and do not guarantee future
results.
