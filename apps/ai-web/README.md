# AI Web

`apps/ai-web` is the standalone public AI Analytics frontend. It is an Astro
7 server-rendered application using the official Cloudflare adapter. The
private Stock AutoTrader frontend remains in `apps/web`.

## Local development

From the repository root:

```bash
npm ci
npm run dev -w @stock-autotrader/ai-web
```

The public pages render locally without a backend binding. Auth and personal
AI Analysis data intentionally show an unavailable state unless the app is run
with a Cloudflare service binding.

## Preview deployment

Build and inspect the isolated Worker envelope with:

```bash
ASTRO_TELEMETRY_DISABLED=1 npm run build -w @stock-autotrader/ai-web
npx wrangler deploy --config apps/ai-web/wrangler.preview.jsonc --dry-run
```

The preview config deploys a separate `ai-web-preview` Worker with one
`AI_BACKEND` service binding to `stock-autotrader-web`. It has no D1, Queue,
secret, cron, or production route binding. A trusted Cloudflare Workers Build
or an approved preview deploy can run:

```bash
npm run deploy:preview -w @stock-autotrader/ai-web
```

The resulting workers.dev URL is the AI Web Preview URL. Set the existing
Stock AutoTrader preview build variable `VITE_AI_WEB_URL` to that exact URL
(the variable is optional; the private app safely falls back to its internal
AI Analysis route when absent). This keeps the two previews independently
deployable while allowing the Stock AutoTrader AI Analytics navigation to link
to AI Web.

## API boundary

The Astro Worker proxies only `/api/auth/*` and `/api/ai-analysis/*` to the
existing Worker service binding. All other `/api/*` paths return `404`. The
proxy forwards the host-only browser session cookie to the existing Better
Auth implementation and applies `no-store` to personalized responses. It does
not bind D1 or the Queue and does not expose Stock AutoTrader quotes,
fundamentals, screener, market context, ingest, admin, or operational APIs.

The landing page and pricing page do not fabricate reports, testimonials,
counts, uptime, timing, returns, or prices. Analysis execution and purchases
are intentionally deferred.
