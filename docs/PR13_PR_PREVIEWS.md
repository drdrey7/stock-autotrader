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
It serves the branch build through the `ASSETS` binding, reads Stock Detail
fundamentals from the dedicated non-production `DB` binding, and delegates
unrelated `/api` and `/api/*` paths to the `PRODUCTION_API` Service Binding.
The binding targets the permanent `stock-autotrader-web` Worker; Stock Detail
preview requests never call Finnhub, SEC, or the production Worker.

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
[`apps/web/wrangler.preview.jsonc`](../apps/web/wrangler.preview.jsonc). It is
used for local/CI dry-runs and documents the intended runtime envelope, which
contains only:

- `ASSETS` static assets;
- `ENVIRONMENT=preview`;
- `DB -> stock-autotrader-preview-db` (Stock Detail only);
- `PRODUCTION_API -> stock-autotrader-web`.

It has no KV, R2, Durable Object, additional service binding, secret, broker
credential, or cron trigger. The D1 is a separate non-production database and
contains only the migrated Stock Detail snapshot plus the minimal active
universe rows needed by that read model.

## Trusted Workers Builds envelope

Workers Builds does not read `wrangler.preview.jsonc` when uploading a branch.
The deploy command and `CF_PREVIEW_CONFIG` build variable are stored in the
Cloudflare Workers Builds trigger, outside the repository. The variable holds
only the dedicated preview D1, the fixed `PRODUCTION_API -> stock-autotrader-web`
service binding, and the asset Worker-first routes. The deploy command first changes
to a new temporary
directory, installs the pinned official Wrangler package there with scripts
disabled and the public npm registry fixed, and invokes that package by its
absolute path:

```sh
P=$(mktemp -d /tmp/cf-w.XXXXXX); printf %s "$CF_PREVIEW_CONFIG" >/tmp/p.jsonc; cd "$P"; NPM_CONFIG_USERCONFIG=/dev/null NPM_CONFIG_REGISTRY=https://registry.npmjs.org npm i --ignore-scripts --no-save --prefix "$P" wrangler@4.122.0 >/dev/null 2>&1; "$P/node_modules/.bin/wrangler" versions upload /opt/buildhome/repo/apps/web/preview-worker.ts -c /tmp/p.jsonc --name stock-autotrader-preview --assets /opt/buildhome/repo/apps/web/dist --var ENVIRONMENT:preview --compatibility-date 2026-08-10
```

The external `CF_PREVIEW_CONFIG` value is exactly:

```json
{"services":[{"binding":"PRODUCTION_API","service":"stock-autotrader-web"}],"d1_databases":[{"binding":"DB","database_name":"stock-autotrader-preview-db","database_id":"9026c34e-15e2-4a55-b7df-2897d8fccd08"}],"assets":{"run_worker_first":["/api","/api/*","/__preview/diagnostics"],"not_found_handling":"single-page-application"}}
```

This trigger command is the binding/deployment security boundary, not GitHub
CI. A PR may change the checked-in config or add a local Wrangler package, but
neither is read by the upload: the envelope comes from the external trigger
variable and the uploader is installed after the build outside the checkout.
The D1 binding is fixed to the dedicated preview database; no PR edit can add
production D1, KV, R2, Durable Objects, cron, secrets, or another service
binding to the preview version. The
two existing triggers retain their branch filters: non-production branches
exclude `main`, and the `main` trigger remains separate from the production
Worker deployment.

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
6. Set `CF_PREVIEW_CONFIG` as a plain build variable to the fixed JSON shown
   above, and set both deploy commands to the fixed trusted command shown
   above. Apply migrations to the dedicated preview D1 before seeding Stock
   Detail symbols. Do not point Workers Builds at
   `apps/web/wrangler.preview.jsonc`; that file is only for local/CI dry-runs.
   Non-production branches upload versions;
   they do not promote a version to the production deployment.
7. Keep builds enabled for non-production branches. Do not add dashboard KV, R2,
   Durable Object, additional Worker/service, secret, broker, or cron bindings.

The Cloudflare trigger configuration is the trusted source of truth for the
binding envelope. Cloudflare posts the commit and branch preview URLs to the connected
GitHub PR. The branch alias remains stable while each commit gets its own
version preview URL, allowing multiple PRs to coexist on the permanent
`stock-autotrader-preview` Worker.

## Security boundary

PR-controlled code never receives production credentials. Production D1 and
secrets remain on `stock-autotrader-web`; the preview DB is a separate
non-production resource. Preview CI validates the isolated configuration and
does not deploy production. The preview API boundary is
read-only in the preview entrypoint, and production ingest remains protected
by its existing HMAC authentication.

## Deferred backend staging

An isolated backend staging Worker and D1 database may be designed later. It is
not part of PR13: PR previews need current production read parity, while
schema, migration, and ingestion testing can be handled in a later isolated
follow-up.
