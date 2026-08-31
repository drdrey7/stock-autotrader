# AI Web implementation notes

The public AI Web surface is a separate React + TypeScript + Vite application
served by its own Cloudflare Worker. `apps/web` remains the existing private
Stock AutoTrader frontend and Worker. Both products reuse the existing
D1-backed Better Auth and AI Analysis system through a narrow service-bound
proxy owned by `apps/ai-web`.

## Preview setup

The AI Web config is `apps/ai-web/wrangler.preview.jsonc` and uses the
non-production Worker name `ai-web-preview`. It binds only the existing
`stock-autotrader-web` Worker as `AI_BACKEND` plus static `ASSETS`. It does not
declare D1, Queue, secrets or cron bindings.

The Stock AutoTrader Vite build reads `VITE_AI_WEB_URL`. Configure that build
variable to the AI Web URL when private navigation should open the separate
public product.

## Authentication and privacy

The AI Web Worker proxies only `/api/auth/*` and `/api/ai-analysis/*`. Other
`/api/*` paths return 404. Browser state-changing requests must have an Origin
matching the AI Web origin. The service-bound request is then rewritten to the
canonical backend origin so the existing Better Auth and AI Analysis
same-origin policy remains unchanged.

Session cookies are forwarded through the proxy. Personalized API responses are
`no-store`. The public frontend receives no D1, Queue or provider credentials.

## AI Analysis integration

The React frontend imports the canonical contracts from
`@stock-autotrader/contracts` and uses the existing endpoints:

- `GET /api/ai-analysis/catalog`
- `GET /api/ai-analysis/viewer`
- `POST /api/ai-analysis/runs`
- `GET /api/ai-analysis/runs/:runId`
- `GET /api/ai-analysis/history`

Run creation uses an idempotency key. The report route polls queued/running runs
and renders the normalized completed result returned by the existing backend.
The workspace reads the real catalog, credits and history. Auth uses the
existing Better Auth email/password endpoints; no second authentication system
is introduced.

## Preview trust model (accepted)

PR previews intentionally bind `AI_BACKEND` to the existing `stock-autotrader-web`
Worker so authenticated AI Analysis flows can be exercised end-to-end before
merge. The repository is private, PR authors are controlled, and the trusted
preview publisher checks out default-branch Worker code before applying
credentials. PR-controlled content contributes built static assets only.

This is an accepted pre-merge trust trade-off: full product validation against
the real backend is required. Production launch still needs a public domain,
abuse controls and commercial hardening. This PR does **not** introduce a second
staging D1/Queue/auth backend.

Do not treat preview access as a substitute for production isolation. Reviewers
should avoid using production-only credentials in preview browsers when possible.

## Remaining launch work

Stripe, credit purchases, final pricing, the production public domain, abuse
controls and commercial launch hardening remain separate work. Before merging,
the PR must have green CI/Security/Deploy validation; a live preview smoke is
preferred before enabling any production route.
