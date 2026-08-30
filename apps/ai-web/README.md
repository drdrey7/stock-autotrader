# AI Web

`apps/ai-web` is the standalone public AI Analytics frontend. It uses React,
TypeScript and Vite, with Motion and GSAP for interaction and scroll-driven
motion. The private Stock AutoTrader frontend remains in `apps/web`.

## Local development

From the repository root:

```bash
npm ci
npm run dev -w @stock-autotrader/ai-web
```

The marketing UI renders without a backend. Authenticated functionality needs
the Cloudflare Worker envelope because the browser intentionally talks to the
existing backend through same-origin `/api/*` routes.

## Preview deployment

Build and inspect the isolated Worker envelope with:

```bash
npm run build -w @stock-autotrader/ai-web
npx wrangler deploy --config apps/ai-web/wrangler.preview.jsonc --dry-run
```

The preview config deploys a separate `ai-web-preview` Worker with one
`AI_BACKEND` service binding to `stock-autotrader-web`. It has no direct D1,
Queue, cron, secret or production-route binding.

```bash
npm run deploy:preview -w @stock-autotrader/ai-web
```

Set the private Stock AutoTrader build variable `VITE_AI_WEB_URL` to the AI Web
URL when the private navigation should open this product.

## API boundary

The AI Web Worker proxies only:

- `/api/auth/*`
- `/api/ai-analysis/*`

All other `/api/*` paths return `404`. Browser writes are checked for a matching
same-origin `Origin` before the Worker rewrites the service-bound request to the
existing backend's canonical origin. This preserves the existing Better Auth
and AI Analysis CSRF model without exposing private Stock AutoTrader APIs.

The frontend uses the canonical AI Analysis contracts from
`@stock-autotrader/contracts` and the existing endpoints for catalog, viewer,
runs and history. Run creation includes an idempotency key. Report pages poll
the existing run endpoint until the run completes or fails.

## Existing backend reused

No second backend is created. The request path remains:

AI Web → service-bound Stock AutoTrader Worker → Better Auth / D1 / Queue → VPS
AI Analysis runner.

The landing page does not fabricate reports, testimonials, counts, uptime,
timing, returns or prices. Stripe, credit purchasing, final pricing and the
production public domain remain separate launch work.

## Merge gate

Do not enable a production route from this branch until CI, Security and Deploy
validation are green. The trusted preview publisher consumes only built static
assets from a PR; Worker code and service bindings always come from the trusted
default branch.
