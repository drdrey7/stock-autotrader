# Stock Autotrader V5.1

Public, read-only observability for a private systematic US stock research and swing-trading engine.

V5.1 scans a demo universe, displays structured quant signals, versioned strategies, research stages and a simulated $5,000 shadow portfolio. It contains no broker integration, order execution, live market claims or investment recommendations.

## Architecture

| Boundary | Components | Responsibility |
|---|---|---|
| Public Cloudflare | React/Vite app, read-only Worker API, D1 | Safe public status, scans, signals, analyses, research and simulated performance |
| Private VPS | Python engine, providers, MCPs, AI, risk, backtests, scheduler, shadow portfolio | Market research and future authenticated publication of sanitised data |

The browser never receives provider credentials and never talks to IBKR, TradingView MCP, Firecrawl, OpenAI or the VPS. See [docs/architecture.md](docs/architecture.md) and [docs/security.md](docs/security.md).

## Repository

```text
apps/web                 React 19 + TypeScript + Vite public UI
apps/api                 Cloudflare Worker read-only API
packages/contracts       Shared TypeScript types and central demo fixtures
bot/data                 Point-in-time market provider contracts
bot/features             Deterministic technical features
bot/screening            Core/future universe separation
bot/strategies           Metadata-driven strategy registry
bot/risk                 Deterministic position sizing and limits
bot/portfolio            Simulated shadow portfolio
bot/backtest             Next-bar execution backtest baseline
bot/research             Research orchestration boundary
ai                       Structured post-quant event assessment contracts
database/migrations      Authoritative D1 schema
infra                    Cloudflare and Docker configuration
docs                     Research, security and VPS handoff
tests                    Python, API, feature, risk and migration tests
```

## Public routes

- `/` polished Clean Light Minimal landing page
- `/dashboard`, `/scanner`, `/stocks/:symbol`
- `/strategies`, `/strategies/:strategyId`
- `/research`, `/research/:researchId`
- `/portfolio`, `/earnings`, `/activity`, `/status`
- `/methodology`, `/disclaimer`

Demo numbers live only in `packages/contracts/src/demo-data.ts` and every affected view is labelled **Demo Data**. Set `VITE_DEMO_MODE=false` with `VITE_API_BASE_URL` to use the deployed public API.

## Read-only API

The Worker exposes `GET` only:

```text
/api/status
/api/dashboard
/api/scans/latest
/api/scans/:id
/api/candidates
/api/stocks/:symbol
/api/stocks/:symbol/analysis
/api/strategies
/api/strategies/:id
/api/research
/api/backtests
/api/portfolio/shadow
/api/trades/shadow
/api/earnings
/api/activity
/openapi.json
/healthz
```

There are no public mutation, admin, broker, strategy-control, remote-execution or shell endpoints.

## Local development

Prerequisites: Node 20+ (22 recommended), npm, Python 3.11+ and optionally Docker Compose.

```bash
npm ci
npm run dev
```

The web app opens at `http://localhost:5173`. Run the Worker/D1 emulator separately:

```bash
npm run dev:api
```

Create a Python virtual environment without committing it:

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -e '.[dev]'
stock-engine smoke
uvicorn bot.service:app --host 127.0.0.1 --port 8000
```

## Quality gates

```bash
npm run lint
npm run typecheck
npm test
npm run build

ruff check .
mypy bot ai
pytest

npm run db:migrate:local -w @stock-autotrader/api
docker compose config --quiet
```

## Environment

Copy `.env.example` to `.env` only on a trusted machine and keep permission `600`. The default fixture configuration needs no secret. Provider values are required only on the future VPS. Do not put secrets in `wrangler.jsonc`; use Wrangler secrets or the existing VPS secret store.

## Cloudflare setup

1. Authenticate interactively with the intended Cloudflare account.
2. Inspect existing D1 databases, Workers, routes and Tunnels.
3. Create or confirm a dedicated D1 database.
4. Replace the explicit D1 and origin markers in the `env.production` block with confirmed values; keep the top-level local environment in demo mode.
5. Generate binding types and validate locally.
6. List and apply migrations only to the confirmed database.
7. Dry-run both deployments before setting routes/custom domains.

```bash
npx wrangler whoami
npx wrangler d1 list
npm run cf:types
npm run db:migrate:local -w @stock-autotrader/api
npx wrangler deploy --dry-run --env production --config apps/api/wrangler.jsonc
VITE_API_BASE_URL=https://REPLACE_WITH_PUBLIC_API_ORIGIN VITE_DEMO_MODE=false npm run build -w @stock-autotrader/web
npx wrangler deploy --dry-run --config apps/web/wrangler.jsonc
```

Automatic production deployment is intentionally absent from CI.

## Strategy architecture

Strategies implement `screen`, `generate_signal`, `calculate_stop` and `exit_signal`, and publish a `StrategyMetadata` record. `bot/strategies/registry.py` is the discovery boundary; adding and registering `momentum_v1` makes its metadata available without a new frontend page architecture.

Initial baselines:

- `trend_breakout_v1`: market regime, EMA structure, SPY/QQQ relative strength, 20D/50D breakout, relative volume and ATR%.
- `post_earnings_v1`: timestamp-safe earnings event, price reaction, volume and relative strength, with guidance status reserved as structured metadata.

Parameters are documented baselines, not mined performance claims.

## Quant and research rules

Features include EMA20/50/100/200, ATR14/ATR%, 1/3/6/12-month momentum, SPY/QQQ relative strength, ADV20, median dollar volume, relative volume, prior 20D/50D highs, swing points, breakouts and basic market regime.

The backtest signals at bar close, executes no earlier than the next open, includes three cost scenarios and executes at the next open when price gaps through a stop. Full rules and fixed research partitions are in [docs/research_contract.md](docs/research_contract.md).

## Shadow portfolio

Default simulated capital is $5,000. Hard rules: 0.5% risk/trade, four positions, 2% open risk, 100% gross exposure, 30% single position, 40% sector, no leverage, no averaging down and no martingale. AI cannot alter these rules.

## Docker concept

`docker-compose.yml` supports local web/API and private engine containers. Production public web/API/D1 belong on Cloudflare; the VPS runs only private engine components and publisher. The `worker` and `scheduler` profiles are safe handoff scaffolding, not an enabled live market loop.

```bash
cp .env.example .env
docker compose config --quiet
docker compose up --build web api engine-api
docker compose run --rm worker stock-engine smoke
```

## VPS handoff

Do not configure the VPS from this repository session. The inspection-first installation guide is [docs/VPS_HANDOFF.md](docs/VPS_HANDOFF.md), and the future ready-to-copy Codex instruction is [docs/VPS_CODEX_PROMPT.md](docs/VPS_CODEX_PROMPT.md).

## Disclaimer

Stock Autotrader provides model-generated research for educational and informational purposes. Strong Setup, Watch, No Setup, Bullish, Neutral and Bearish are model labels, not personalised investment advice. Backtests, demo data and shadow portfolios are hypothetical and do not guarantee future results.
