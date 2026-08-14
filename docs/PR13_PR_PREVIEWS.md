# PR13 developer workflow

## Permanent Worker preview

Every same-repository PR branch is built by Cloudflare Workers Builds into a
new version of one permanent preview Worker:

```text
same-repository PR branch
  -> Cloudflare Workers Builds / Git integration
  -> versioned stock-autotrader-preview
  -> branch frontend assets
  -> same-origin GET/HEAD /api/*
  -> PRODUCTION_API Service Binding
  -> stock-autotrader-web public read model
```

Production remains the existing `stock-autotrader-web` Worker, deployed by the
trusted main-branch workflow. The preview Worker is
`stock-autotrader-preview`; it is never used for production deployment and is
not created or deleted per PR.

The preview entrypoint is [`apps/web/preview-worker.ts`](../apps/web/preview-worker.ts).
It serves the branch build through the `ASSETS` binding and delegates only
`/api` and `/api/*` paths to the `PRODUCTION_API` Service Binding. The binding
targets the permanent `stock-autotrader-web` Worker, so the preview reads the
current production public read model without accessing production storage
directly.

The service-boundary proxy accepts only GET and HEAD, rejects POST/PUT/PATCH/
DELETE and other non-read methods with 405 before invoking the binding,
forwards only pathname, query string and `Accept`, never forwards
Authorization or Cookie, strips upstream Set-Cookie, and fails closed on
upstream errors. The preview has no scheduled handler, ingest path, or
production credentials.

`/__preview/diagnostics` performs compact GET checks through the same Service
Binding and returns only HTTP statuses, availability, and row counts. It never
returns production payloads, secrets, or financial data.

The dedicated config is
[`apps/web/wrangler.preview.jsonc`](../apps/web/wrangler.preview.jsonc). Its
runtime configuration contains only:

- `ASSETS` static assets;
- `ENVIRONMENT=preview`;
- `PRODUCTION_API -> stock-autotrader-web`.

It has no D1, KV, R2, Durable Object, additional service binding, secret,
broker credential, or cron trigger. A separate staging Worker/D1 is not part of
PR13.

## One-time Cloudflare setup

Workers Builds is account-level configuration and must be connected once in
the Cloudflare dashboard:

1. Open **Workers & Pages → Create application → Get started → Import a
   repository**.
2. Choose GitHub and authorize the Cloudflare GitHub App for the GitHub account
   that owns `drdrey7/stock-autotrader`.
3. Select `drdrey7/stock-autotrader` and create/select the permanent Worker
   `stock-autotrader-preview`.
4. Use the repository root, Node.js 22, and `main` as the production branch.
   Keep `stock-autotrader-web` as the separate production Worker.
5. Set the build command to
   `npm ci --ignore-scripts && npm run build`.
6. Set both the production and non-production deploy command to
   `npx wrangler@4.122.0 versions upload --config
   apps/web/wrangler.preview.jsonc`. Non-production branches upload versions;
   they do not promote a version to the production deployment.
7. Keep builds enabled for non-production branches. Do not add dashboard D1,
   KV, R2, Durable Object, Worker/service, secret, broker, or cron bindings.

The checked-in Wrangler config is the source of truth for the one service
binding. Cloudflare posts the commit and branch preview URLs to the connected
GitHub PR. The branch alias remains stable while each commit gets its own
version preview URL, allowing multiple PRs to coexist on the permanent
`stock-autotrader-preview` Worker.

## Security boundary

PR-controlled code never receives production credentials. Production D1 and
secrets remain on `stock-autotrader-web`. Preview CI validates the isolated
configuration and does not deploy production. The preview API boundary is
read-only in the preview entrypoint, and production ingest remains protected
by its existing HMAC authentication.

## Deferred backend staging

An isolated backend staging Worker and D1 database may be designed later. It is
not part of PR13: PR previews need current production read parity, while
schema, migration, and ingestion testing can be handled in a later isolated
follow-up.
