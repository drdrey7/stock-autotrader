# PR13 developer workflow

## Permanent Worker preview

Preview deployments use one permanent Worker, separate from production:

```text
same-repository PR branch
  -> Cloudflare Workers Builds / Git integration
  -> versioned preview of stock-autotrader-preview
  -> branch frontend assets
  -> same-origin GET/HEAD /api/* proxy
  -> public read-only stock-autotrader-web API
```

Production remains the existing `stock-autotrader-web` Worker, deployed by
the trusted main-branch workflow. The preview Worker is
`stock-autotrader-preview`; it is never used for production deployment and is
not created or deleted per PR.

The preview entrypoint is [`apps/web/preview-worker.ts`](../apps/web/preview-worker.ts).
It serves the branch build through the `ASSETS` binding and delegates only
`/api` and `/api/*` paths to [`apps/web/preview-api-proxy.ts`](../apps/web/preview-api-proxy.ts).
The proxy accepts GET and HEAD, rejects mutation methods with 405, forwards
only `Accept`, omits credentials, strips `Set-Cookie`, requires an HTTPS API
origin, preserves query strings and fails closed on upstream redirects/errors.

The dedicated config is
[`apps/web/wrangler.preview.jsonc`](../apps/web/wrangler.preview.jsonc). It
contains only `ENVIRONMENT=preview`, the public API origin and static assets.
It has no D1, KV, R2, Durable Object, service binding, secret or cron trigger.
The preview runtime has no scheduled handler, ingest route or production
storage access and is structurally incapable of writing production data.

## One-time Cloudflare setup

Workers Builds is account-level configuration and must be connected once in
the Cloudflare dashboard:

1. Open **Workers & Pages → Create application → Get started → Import a
   repository**.
2. Choose GitHub and authorize the Cloudflare GitHub App for the GitHub account
   that owns `drdrey7/stock-autotrader`.
3. Select `drdrey7/stock-autotrader` and create/select the Worker
   `stock-autotrader-preview`.
4. Set the repository root as the root directory and select branch `main` as
   the production branch. Keep the production Worker name
   `stock-autotrader-web` separate.
5. Set the build command to
   `npm ci --ignore-scripts && npm run build`.
6. Set both the deploy command and the non-production branch deploy command
   to `npx wrangler@4.122.0 versions upload --config
   apps/web/wrangler.preview.jsonc`. This creates a versioned preview URL for
   each branch commit without promoting any version to the active Worker
   deployment.
7. Set the build output produced by the config to `apps/web/dist`; Node.js 22
   is required for the build environment.
8. Enable builds for non-production branches. Do not add any D1, KV, R2,
   Durable Object, service or Worker binding, secret, broker credential or
   cron trigger to the preview Worker.

Cloudflare posts the build result and versioned preview URL to the GitHub PR
when the connected branch build runs. The URL is version-specific, so previews
for multiple PR branches coexist while the permanent Worker name remains
`stock-autotrader-preview`.

The public API origin is intentionally non-secret and is checked into the
preview config as:
`https://stock-autotrader-web.barroso-labs.workers.dev`.
No secret is required to view normal preview data.

## Security boundary

PR-controlled code never receives production credentials. The production
workflow deploys only on trusted pushes to `main`; PR validation performs no
Cloudflare deployment. Workers Builds uploads the isolated preview version
using Cloudflare's native Git integration. The preview can consume only
anonymous public GET/HEAD API responses and cannot access production storage
or mutation endpoints.

## Future backend staging

An isolated backend staging Worker and D1 database may be designed later. It
is not part of PR13: previews intentionally consume the current public,
read-only production API and never access production storage directly.
