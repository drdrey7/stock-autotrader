# AI Web PR1 implementation notes

The public AI Web surface is a separate Astro 7 application and Cloudflare
Worker. `apps/web` remains the existing private Stock AutoTrader frontend and
Worker. Both products reuse the existing D1-backed Better Auth and AI Analysis
system through a narrow service-bound proxy owned by `apps/ai-web`.

## Preview setup

The AI Web config is `apps/ai-web/wrangler.preview.jsonc` and uses the
non-production Worker name `ai-web-preview`. It binds only the existing
`stock-autotrader-web` Worker as `AI_BACKEND`. It does not declare a D1, Queue,
secret or cron. Deploying this config does not alter the production Worker,
custom domains or routes.

The Stock AutoTrader Vite build reads `VITE_AI_WEB_URL`. Configure that build
variable in the Stock AutoTrader preview build to the AI Web workers.dev
preview URL. If the variable is empty, the existing internal `/ai-analysis`
route remains the safe navigation fallback.

## Authentication and privacy

The AI Web API proxy accepts only same-origin state-changing requests and
forwards the browser Cookie and response Set-Cookie headers to the existing
Better Auth handler through the service binding. It rewrites the internal
service-bound request Origin to the canonical backend envelope, so the
existing exact-origin Better Auth policy remains active without adding a
wildcard trusted origin. Browser cookies stay host-only on the AI Web origin.

Protected AI Analysis routes authenticate with Better Auth and the existing
storage layer, which scopes viewer, history and run reads by the authenticated
user ID. The frontend never receives D1 or Queue credentials.

## Deferred work

PR2 owns the full run/progress/report experience and richer history UI. PR3
owns Stripe, final pricing, credit purchases, a production public domain,
abuse controls and launch hardening.
