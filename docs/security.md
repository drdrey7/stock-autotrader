# Security model

- Public API accepts only `GET` and `OPTIONS`; unknown methods fail closed.
- Dynamic symbols and identifiers are allow-list validated.
- API output is runtime-validated before serialization in demo/core routes.
- Browser and API responses set restrictive security headers.
- CORS permits only the configured exact public origin.
- Secrets are ignored by Git and belong in `.env`, `.dev.vars`, Wrangler secrets or the existing VPS secret store.
- D1 receives only public-safe, sanitised data.
- Logs contain public paths and generic error messages, never stack traces in responses.
- No broker, mutation, admin, remote execution, shell or strategy-control endpoint exists.
- Rate limiting is an edge/deployment control to enable against the API route after the actual Cloudflare account is inspected. The architecture does not use unsafe process-global counters.

