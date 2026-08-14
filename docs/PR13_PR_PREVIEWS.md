# PR13 developer workflow

## Cloudflare Pages PR previews

The preview path is deliberately separate from the production Worker:

```text
same-repository PR branch
  -> Cloudflare Pages Git preview
  -> branch frontend
  -> same-origin /api/* Pages Function
  -> public GET-only production Worker API
```

`functions/api/[[path]].ts` is the only server-side code in the Pages project.
It accepts GET and HEAD, rejects all other methods with 405, forwards
only the URL and an `Accept` header, and strips upstream `Set-Cookie` headers.
It does not receive or use Authorization headers, browser cookies, credentials,
D1, service bindings, Worker bindings, `INGEST_SECRET`, FMP/SEC secrets or cron
triggers. The frontend continues to call `/api/*` with same-origin URLs, so the
normal market, earnings, X Pulse and status reads work without a preview secret.

The tracked Pages configuration is
[`wrangler.pages.jsonc`](../wrangler.pages.jsonc). The
production Worker continues to use
[`apps/web/wrangler.jsonc`](../apps/web/wrangler.jsonc).

### One-time Cloudflare setup

Cloudflare Pages Git integration is account/project configuration and cannot be
fully created from this repository. Create one Pages project connected to
`drdrey7/stock-autotrader` with these settings:

1. Project name: `stock-autotrader-pr-preview`.
2. Root directory: repository root (`.`).
3. Build command: `npm run build`.
4. Build output directory: `apps/web/dist`.
5. Node.js version: 22.
6. Production branch: `main`, with automatic production-branch deployments
   disabled. This project is for preview branches only; production remains the
   existing Worker deployment from `.github/workflows/deploy.yml`.
7. Preview branch control: enable all non-production branches so every
   same-repository PR branch is built.
8. In the Pages **Preview** environment, set the non-secret variable
   `PUBLIC_API_ORIGIN` to the public production Worker origin. The checked-in
   value is `https://stock-autotrader-web.barroso-labs.workers.dev`; update both
   the Pages variable and `wrangler.pages.jsonc` if the production origin ever
   changes.
9. Do not add any D1, KV, R2, Durable Object, service, Worker, AI or other
   bindings. Do not add Pages secrets. Do not configure cron triggers.

`apps/web/.env.production` sets the public build flags to API mode and leaves
`VITE_API_BASE_URL` empty, so the frontend uses same-origin `/api/*`. No secret
is required to open normal preview data. Pages adds the preview deployment URL
and keeps its PR URL/branch alias updated as new commits arrive. Cloudflare does
not create PR preview URLs for pull requests from forks; those remain untrusted
and continue to use CI validation only.

If the dashboard is configured from Wrangler instead, run commands from the
repository root with `wrangler.pages.jsonc`; do not use the production
`wrangler.jsonc` for a Pages deployment.

### Future backend staging

An isolated backend staging Worker and D1 database may be designed later. It is
not part of PR13: previews intentionally consume the current public,
read-only production API and never access production storage directly.
