# Cloudflare deployment preparation

- `apps/web/wrangler.jsonc` deploys the Vite build as Worker static assets with SPA fallback.
- `apps/api/wrangler.jsonc` deploys the read-only API with a D1 binding named `DB`.
- `database/migrations/` is the single source of truth for D1.

No account ID, database ID, token, route or custom domain is committed. Copy/patch the clearly marked D1 placeholder only after inspecting the existing Cloudflare account. Use `wrangler secret put` for any future ingest secret; never add it to `vars`.

The top-level API environment is deliberately local/demo. Production is fail-explicit: replace the markers in `env.production` and `apps/web/public/_headers`, build web with `VITE_DEMO_MODE=false` plus the confirmed public API origin, and use `wrangler ... --env production`. The VPS handoff contains the exact inspection and verification sequence.
