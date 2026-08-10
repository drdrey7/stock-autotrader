# VPS handoff — Stock Autotrader V5.1

## Project state

The repository contains a complete public V1 surface, read-only Cloudflare Worker API, D1 migration, deterministic quant features, baseline strategy registry, risk/shadow framework, smoke backtest, tests, containers and CI. It deliberately does **not** contain real market providers, credentials, a Cloudflare account/database ID, a permanent scan loop, an authenticated ingest Worker or any IBKR integration.

The public frontend/API can run in demo mode before the VPS exists. The VPS phase connects provider adapters, existing MCPs and an authenticated public-data publishing path; it must not move private functionality into the public Worker.

## 1. Inspect first — read-only commands

Run these before cloning or changing services. Do not paste their output publicly if it contains hostnames, IPs or internal routes.

```bash
uname -a
cat /etc/os-release
id
df -h
free -h
docker --version 2>/dev/null || true
docker compose version 2>/dev/null || true
git --version 2>/dev/null || true
python3 --version 2>/dev/null || true
node --version 2>/dev/null || true
ss -lntup
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}' 2>/dev/null || true
systemctl --type=service --state=running --no-pager
systemctl list-timers --all --no-pager
find /etc -maxdepth 2 -type f \( -name '*cloudflared*' -o -name '*nginx*' -o -name '*caddy*' -o -name '*traefik*' \) 2>/dev/null
docker network ls 2>/dev/null || true
```

Inspect Cloudflare and MCP configuration by listing names/locations only first. Do not print secret file contents:

```bash
systemctl status cloudflared --no-pager 2>/dev/null || true
docker ps --format '{{.Names}} {{.Image}}' | grep -Ei 'cloudflare|mcp|firecrawl|trading|proxy' || true
find /opt /srv /etc -maxdepth 3 -type f \( -name 'config.yml' -o -name 'wrangler.jsonc' -o -name 'docker-compose.yml' -o -name 'compose.yml' \) 2>/dev/null
```

Record existing reverse proxy, Tunnel/service names, Docker networks, occupied ports, service users, firewall rules and secret-management convention. Reuse them when safe.

## 2. Clone safely

Choose a dedicated path that does not overlap an existing service. For a private repository, authenticate using the VPS's existing approved GitHub mechanism (deploy key, GitHub App or credential helper); never put a token in the URL or shell history.

```bash
sudo install -d -o "$USER" -g "$USER" /opt/stock-autotrader
git clone https://github.com/drdrey7/stock-autotrader /opt/stock-autotrader
cd /opt/stock-autotrader
git status --short --branch
git remote -v
git log -5 --oneline --decorate
```

If `/opt/stock-autotrader` already exists, stop and inspect it; do not delete it. Fetch and review before pull:

```bash
cd /opt/stock-autotrader
git status --short --branch
git fetch --prune origin
git log --oneline --decorate HEAD..origin/main
git diff --stat HEAD..origin/main
```

## 3. Environment and secrets

Create `.env` locally from `.env.example`, set permissions to `600`, and confirm `.env` stays ignored.

```bash
cd /opt/stock-autotrader
cp .env.example .env
chmod 600 .env
git check-ignore -v .env
```

Required only when the corresponding adapter is enabled:

- `PUBLIC_INGEST_URL` and `PUBLIC_INGEST_TOKEN`: authenticated Cloudflare publish boundary.
- `MARKET_DATA_PROVIDER` / `MARKET_DATA_API_KEY`: point-in-time OHLCV and universe provider.
- `EARNINGS_PROVIDER` / `EARNINGS_API_KEY`: earnings dates, BMO/AMC and availability time.
- `OPENAI_API_KEY`: structured assessment for quant-filtered candidates only.
- `TRADINGVIEW_MCP_URL`: existing private MCP endpoint.
- `FIRECRAWL_API_KEY`: event/news retrieval if chosen.
- `ENGINE_DATABASE_PATH`, `ENGINE_TIMEZONE=America/New_York`, `ENGINE_LOG_LEVEL`.

Use existing VPS secret storage if present. Never commit, log or echo values. Cloudflare-side secrets use interactive `wrangler secret put`, not `wrangler.jsonc` vars.

## 4. Validate before starting services

```bash
cd /opt/stock-autotrader
docker compose config --quiet
docker compose build
docker compose run --rm worker stock-engine smoke
docker compose run --rm worker python -m bot.scheduler describe
```

Run repository tests in a disposable development environment or CI before production changes. The root README contains the exact Node/Python commands.

## 5. Cloudflare and D1

First inspect the existing account, Tunnel and route pattern. Do not create duplicates. From a trusted interactive session:

```bash
cd /opt/stock-autotrader
npx wrangler whoami
npx wrangler d1 list
```

Then either reuse an intentionally dedicated D1 database or create one after approval. In the `env.production` block, replace both `REPLACE_WITH_D1_DATABASE_ID` occurrences with the confirmed database ID and `REPLACE_WITH_PUBLIC_WEB_ORIGIN` with the exact HTTPS web origin. Replace `REPLACE_WITH_PUBLIC_API_HOST` in `apps/web/public/_headers` with the confirmed API hostname (hostname only, no path). Keep the top-level environment in demo mode for safe local development. Never invent an ID or domain. Preview migrations locally, then target the production environment explicitly:

```bash
npm ci
npm run cf:types
npm run db:migrate:local -w @stock-autotrader/api
npx wrangler d1 migrations list stock-autotrader-public --remote --env production --config apps/api/wrangler.jsonc
npx wrangler d1 migrations apply stock-autotrader-public --remote --env production --config apps/api/wrangler.jsonc
```

Create a private authenticated ingest Worker/service binding or reuse the existing secure Cloudflare integration. The ingest contract must validate a short-lived or rotatable token, schema, payload size, timestamp freshness and allowed fields. It publishes only public data to D1. Do not expose the engine API or MCP endpoints through a public route.

Build the public web app with an explicit API origin and demo mode disabled. These are public build-time settings, not secrets. Deploy only after dry runs, inspecting the built asset, and explicit domain confirmation:

```bash
VITE_API_BASE_URL=https://REPLACE_WITH_PUBLIC_API_ORIGIN VITE_DEMO_MODE=false npm run build -w @stock-autotrader/web
npm run build -w @stock-autotrader/api
npx wrangler deploy --dry-run --env production --config apps/api/wrangler.jsonc
npx wrangler deploy --dry-run --config apps/web/wrangler.jsonc
```

Before the real deploy, verify that the production Worker dry-run reports `DEMO_MODE=false`, the intended D1 binding and the exact allowed web origin. Verify the web bundle contains the intended public API origin, copies `_headers`, contains no unresolved `REPLACE_WITH_` marker, and does not display `Demo Data`. Then run the same two deploy commands without `--dry-run`; do not deploy from the top-level API environment.

## 6. Provider and MCP adapters

Implement concrete adapters behind these existing contracts:

- Market data: `bot/data/providers.py`; return point-in-time universe and adjusted, timestamped OHLCV.
- TradingView MCP: feature/event confirmation only, private network.
- Firecrawl: source retrieval with URL/title/published/available timestamps.
- OpenAI: `ai/providers.py` → `AiEventAssessment`; only after quant screening.
- Earnings: populate `EarningsSnapshot` with event and information-availability timestamps.

AI must never calculate position size, override stops, relax portfolio limits or return hidden reasoning. Persist the structured public summary and sources only.

## 7. Permanent services

Intended private components:

- `engine-api`: internal health/readiness only; bind to a private Docker network or loopback.
- `worker`: one scan invocation at a time; no overlapping scans.
- `scheduler`: use the existing trusted scheduler (systemd timer, cron or established orchestrator) after inspection.
- private SQLite/state volume or existing approved private store.
- authenticated publisher to Cloudflare.

Do not start the placeholder `scheduler` profile as a real schedule. It only describes disabled jobs. Configure approximately:

- Pre-market scan: 08:30 America/New_York, weekdays.
- Post-close scan: 16:15 America/New_York, weekdays.
- Health/smoke: every 15 minutes, UTC.

Account for US market holidays and daylight-saving time through an exchange calendar before enabling production schedules. Add a lock/idempotency key to prevent duplicate scans.

## 8. Smoke tests

```bash
docker compose ps
docker compose run --rm worker stock-engine smoke
curl --fail --silent http://127.0.0.1:8000/healthz
curl --fail --silent http://127.0.0.1:8787/healthz
curl --fail --silent http://127.0.0.1:8787/api/status
curl --fail --silent http://127.0.0.1:8080/ >/dev/null
```

For the confirmed Cloudflare URLs, verify `/healthz`, `/api/status`, `/api/candidates`, `/openapi.json`, SPA deep links, CORS, security headers and stale-state behaviour. Run one `SMOKE` scan against fixtures, then one provider scan with publishing disabled, then one end-to-end scan with a uniquely tagged payload. Confirm database rows, public API output, activity event and frontend display.

## 9. Rollback

Before each change, record current image tags, Git commit, Worker version and D1 migration state. Prefer reversible version switches:

```bash
cd /opt/stock-autotrader
git rev-parse HEAD
docker compose images
npx wrangler deployments list --config apps/api/wrangler.jsonc
```

For application rollback, redeploy the previously known-good Git commit/image or use Cloudflare deployment rollback. Do not `git reset --hard`, delete volumes or reverse a D1 migration blindly. D1 schema changes require a tested forward-fix migration or a verified restore plan. Stop new schedules first, allow/terminate the current scan safely, switch the application version, smoke test, then re-enable schedules.
