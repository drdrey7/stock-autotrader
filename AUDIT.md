# Repository Audit — stock-autotrader

Date: 2026-08-13
Scope: full monorepo (`apps/web`, `apps/publisher`, `bot`, `packages/contracts`, CI/CD config) at commit `c776ce3` on `main`.

---

## 1. Architecture overview

This is a small polyglot monorepo (npm workspaces + independent Python packages) implementing a **public, read-only market-intelligence site** ("Morning Briefing"), not a live trading system.

```
apps/web/           Cloudflare Worker + React SPA (the only deployed product surface)
  worker/            index.ts (routing + read models), ingest.ts (signed write API),
                      daily-briefings.ts, x-posts.ts, market-context.ts (Cron jobs)
  src/               React 19 SPA (react-router), morning-briefing/ is the live UI;
                      pages.tsx/components.tsx are an unreferenced legacy demo shell
  migrations/        D1 (SQLite) schema, 7 sequential migrations

apps/publisher/      Python, stdlib-only VPS client. Builds the Daily Briefing
                      (X posts + market quotes → validated JSON) and pushes it to
                      the Worker via a signed HTTP event.

bot/                 Python VPS runtime "foundation" (APScheduler). CSV-based market
                      data pipeline is implemented; the actual scan/strategy engine
                      is stubbed (see §8).

packages/contracts/  Shared Zod schemas / TS types for the DailyBriefing and
                      dashboard contracts, intended as the single source of truth.
```

**Data/control flow:**

1. Two independent VPS processes (`bot`, `apps/publisher`) produce normalized JSON "events" and POST them to `apps/web`'s `/ingest/events` endpoint, HMAC-SHA256-signed with a shared `INGEST_SECRET`.
2. The Worker validates each event against a strict Zod schema, applies it to D1 with an idempotency ledger (`ingest_events`), and rejects anything malformed.
3. Cloudflare Cron Triggers independently collect market index and Fear & Greed data directly from the Worker (no VPS in the loop) and write to D1.
4. The public API (`/api/*`, GET-only, unauthenticated, cached 60s) reads D1 and serves the SPA and any external consumer.
5. The React SPA polls `/api/dashboard` every 60s (paused when the tab is hidden) and falls back to bundled demo data if `VITE_DEMO_MODE` is true or a request fails.

This is a genuinely well-thought-out design: every producer writes through one signed, idempotent, schema-validated door; the frontend never mutates anything; and every "freshness" claim (`Live`/`Stale`/`Cached`/`Unavailable`) is derived rather than asserted. Code quality in the write path (`ingest.ts`, `x-posts.ts`, `daily-briefings.ts`) is unusually high — replay protection, atomic D1 batches, out-of-order-event guards, and fail-closed defaults are all handled correctly and are covered by tests.

---

## 2. Code quality

| # | Finding | File/Line | Severity | Fix |
|---|---|---|---|---|
| 2.1 | `pages.tsx` (1907 lines) and the `components.tsx` (57 lines) it imports are **not referenced by any route or component** — `App.tsx` only renders `MorningBriefingApp` and `daily-briefing-pages.tsx`; the old `/scanner`, `/portfolio`, etc. routes just redirect to `/dashboard`. ~1,964 lines of dead code (>20% of `apps/web/src`). | `apps/web/src/pages.tsx`, `apps/web/src/components.tsx` | High | Delete both files (or explicitly archive them outside `src/` if kept for reference); confirm no dynamic import references them first. |
| 2.2 | The dashboard/market-data Zod schema is hand-duplicated in three places: `apps/web/worker/ingest.ts` (`marketDataSchema`, `dashboardReadSchema`), `apps/web/src/lib/api.ts` (`dashboardPayload`), and the plain TS interfaces in `packages/contracts/src/index.ts`. Nothing enforces they stay in sync. | `apps/web/src/lib/api.ts:20-207`, `apps/web/worker/ingest.ts:170-308` | Medium | Move the canonical schema into `packages/contracts` and import it from both the Worker and the frontend instead of re-declaring it. |
| 2.3 | `apps/web/worker/index.ts` (804 lines) mixes routing, response-building, D1 read-model assembly, and source-health scoring in one file with no sub-module boundaries. Not unmanageable today, but it's the single largest and most central file in the backend and has no tests (see §5.1). | `apps/web/worker/index.ts` | Medium | Split `buildDashboard`/`buildSources`/`buildMarketSourceHealth` into a `worker/dashboard.ts` read-model module, leaving `index.ts` as routing only. |
| 2.4 | `bot/stock_autotrader_bot.egg-info/` (a `pip install -e .` build artifact) is committed to git instead of ignored. | `bot/stock_autotrader_bot.egg-info/*` | Low | Add `*.egg-info/` to `.gitignore` and `git rm -r --cached` the directory. |
| 2.5 | The Python packages (`bot`, `apps/publisher`) have no linter/formatter configured (no ruff/flake8/black), unlike the JS side which has a strict ESLint config (`--max-warnings=0`). Style consistency currently depends entirely on reviewer discipline. | `bot/pyproject.toml`, `apps/publisher/` (no config) | Low | Add `ruff` (lint+format) to `bot/pyproject.toml` dev deps and CI. |

Elsewhere, code quality is notably good: zero `any`/`as any` usages in the TS codebase, no `console.log` debug statements left in source, consistent error-handling patterns (fail-closed defaults, typed exception tuples in Python), and no god-functions found outside the `buildDashboard`/`ingest.ts` event-type switch (which, while long, is a flat and readable dispatch table, not deeply nested).

---

## 3. Security

| # | Finding | File/Line | Severity | Fix |
|---|---|---|---|---|
| 3.1 | **CI runs untrusted PR code with an elevated token before the fork check.** `deploy.yml` triggers on `pull_request_target` and explicitly checks out the **fork's head commit** (`ref: github.event.pull_request.head.sha`). `npm ci`, `npm run build`, `lint`, `typecheck`, and `test` all run **unconditionally**, before the one step (`Deploy preview`) that gates on `head.repo.full_name == github.repository`. `pull_request_target` grants `pull-requests: write` and an ambient `GITHUB_TOKEN` that `actions/checkout` writes into the local git credential store — any code that runs during `npm ci`/`build`/`test` (a malicious `postinstall` script, a crafted `vite.config.ts`, a test file) can read that token from `.git/config` and use its `pull-requests: write` scope. This is the textbook GitHub Actions "pwn request" pattern. Cloudflare secrets themselves are correctly gated (only used in the fork-checked/main-branch-checked steps), so this is a token/CI-integrity risk, not a direct production-secret leak — but it is a real, exploitable hole. | `.github/workflows/deploy.yml:1-63` | Critical | Split the workflow: run `npm ci`/build/lint/test for fork PRs under plain `pull_request` (read-only token, no secrets, no elevated permissions) in `ci.yml` (which already does this safely); reserve `pull_request_target` exclusively for the post-build "comment preview URL" step, triggered only after `ci.yml` succeeds, with checkout of the **base** ref (not the fork's head) for anything that isn't already gated. |
| 3.2 | No hardcoded secrets found anywhere in the repo (`.env.example`/`.dev.vars.example` contain only placeholders, and `bot/config.py` actively rejects the placeholder value `dev-secret-change-me` in production). Ingest auth is solid: HMAC-SHA256 over `timestamp.body`, constant-time comparison, 5-minute replay window, 1MB body cap, per-event idempotency ledger. Good practice, no action needed. | `apps/web/worker/ingest.ts:340-369`, `bot/bot/config.py:75-80` | — | — |
| 3.3 | CSP (`default-src 'self'`, `script-src 'self'`, `frame-ancestors 'none'`) and other security headers (`X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`) are all present and reasonably strict. No action needed. | `apps/web/public/_headers` | — | — |
| 3.4 | All D1 access uses parameterized `.bind()` queries throughout `ingest.ts`, `index.ts`, `x-posts.ts`, `daily-briefings.ts`, `market-context.ts` — no string-concatenated SQL found, no injection risk identified. | — | — | — |
| 3.5 | The X-post ingestion path validates URLs against a very defensive allowlist (host, path-segment traversal, control characters, percent-encoding, unicode normalization) before trusting `symbol`/`author` fields extracted from it — an unusually careful anti-spoofing check for a "just display it" field. Good practice. | `apps/web/worker/x-posts.ts:13-56`, `apps/publisher/publisher/x_feed.py:39-90` | — | — |

---

## 4. Dependencies

| # | Finding | Severity | Fix |
|---|---|---|---|
| 4.1 | `npm audit --production` reports **0 vulnerabilities** across the workspace. Dependency versions (React 19.1, Vite 7, Zod 4, TypeScript 5.9, wrangler 4) are all current major lines. | — | Keep running `npm audit` in CI (it currently is not a dedicated CI step — only implicit via `npm ci`); consider adding `npm audit --omit=dev --audit-level=high` as an explicit CI gate. |
| 4.2 | `bot/pyproject.toml` pins loose ranges (`pydantic>=2.7,<3`, `apscheduler>=3.10,<4`) with no lockfile — reproducibility across environments relies on whatever is latest-compatible at install time. | Low | Add a lockfile (`pip-compile`/`uv lock`) or pin exact versions for the VPS runtime, since it's a long-lived process rather than a rebuilt-per-deploy artifact. |
| 4.3 | The Worker depends on two **unofficial third-party HTTP endpoints** at runtime: Yahoo Finance's undocumented chart API and CNN's Fear & Greed JSON feed (`market-context.ts:134-235`). Both are explicitly called out in the README as temporary/no-SLA. This is a legitimate architectural dependency risk (unannounced format changes or rate-limiting would degrade `/api/market-context`), but it is already knowingly accepted and isolated behind a `MarketDataProvider`/`SentimentProvider` interface, so the blast radius is contained and the fix is already planned. | Low (self-disclosed, well-isolated) | Track replacement with a licensed/stable provider as originally planned; no urgent action. |

---

## 5. Testing

| # | Finding | File/Line | Severity | Fix |
|---|---|---|---|---|
| 5.1 | `apps/web/worker/index.ts` — the file that implements **every public API route** (`/api/status`, `/api/dashboard`, `/api/briefs/*`, `/api/x/posts`, `/api/stocks/:symbol`, `/api/earnings`, `/api/portfolio/shadow`, `/api/strategies`) plus `buildDashboard`, `buildSources`, and all the source-health scoring logic — **has no dedicated test file.** Every other worker module (`ingest.ts`, `daily-briefings.ts`, `x-posts.ts`, `market-context.ts`) has thorough tests; this one, the highest blast-radius file in the backend, does not. | `apps/web/worker/index.ts` (no `index.test.ts`) | High | Add worker-level integration tests (Miniflare/`vitest-pool-workers`) covering routing, `buildDashboard` field mapping, and the `buildSources`/`buildMarketSourceHealth`/`buildMarketContextHealth` freshness logic — these three functions in particular already have exported pure functions ready to unit-test directly. |
| 5.2 | `bot/bot/scheduler.py` (cron parsing, job registration, `_noop` stub wiring) has no dedicated `test_scheduler.py`; it's only exercised indirectly through `bot smoke`/`test_cli.py`. | `bot/tests/` (no `test_scheduler.py`) | Low | Add direct tests for `_cron()` parsing edge cases (5-field validation) and `next_runs()`. |
| 5.3 | No skipped, disabled, or `.only`-scoped tests found anywhere in the JS or Python suites — good test hygiene. | — | — | — |
| 5.4 | Test coverage elsewhere is genuinely strong: `ingest-schema.test.ts` (453 lines) exercises the full discriminated-union event schema; `MorningBriefingData.test.tsx` (697 lines) and `daily-briefings.test.ts` (481 lines) cover the freshness/fallback logic in depth; the publisher has both unit tests and dedicated regression/e2e-smoke scripts (`regression_b1b2.py`, `regression_b3.py`, `e2e_smoke.py`). | — | — | — |

---

## 6. Performance

| # | Finding | File/Line | Severity | Fix |
|---|---|---|---|---|
| 6.1 | `buildDashboard(env)` runs **7 parallel D1 queries** (scans, strategies, candidates, earnings, positions, events, research) plus a conditional `decision_reasons` query, and is called fresh on **every** hit to `/api/dashboard`, `/api/status`, `/api/market-data`, `/api/stocks/:symbol`, `/api/earnings`, `/api/portfolio/shadow`, and `/api/strategies`. The narrow endpoints (e.g. `/api/earnings`, `/api/strategies`) fetch and discard the entire dashboard just to return one slice. This is meaningfully over-fetching D1 read volume for endpoints that need one table. | `apps/web/worker/index.ts:414-427` (called from lines 677, 647, 739, 753, 778, 786, 794) | Medium | Give narrow endpoints their own targeted queries (they already have precedent in `readXPosts`/`readMarketContext`), reserving full `buildDashboard` for `/api/dashboard` and `/api/status`. |
| 6.2 | GET responses set `cache-control: public, max-age=60`, which mitigates 6.1 somewhat at Cloudflare's edge, but every cache-miss still pays the full 7-query cost even for narrow endpoints. | `apps/web/worker/index.ts:45-55` | Low | Same fix as 6.1; caching is not a substitute for scoping the query. |
| 6.3 | Client-side polling (`DataProvider`, every 60s) correctly pauses via `document.visibilitychange` when the tab isn't visible, and aborts in-flight requests on unmount/re-trigger — no wasted background polling. Good practice. | `apps/web/src/lib/data-provider.tsx` | — | — |

No N+1 query patterns, unbounded loops, or missing indexes were found; migrations add indexes on the columns actually queried (`scan_id`, `candidate_id`, `created_at`).

---

## 7. Documentation

| # | Finding | Severity | Fix |
|---|---|---|---|
| 7.1 | The root `README.md` is good (routes, dev/quality-gate commands, briefing rhythm, market-context provider isolation, disclaimer) but is the **only** README in the repo — `bot/` and `apps/publisher/` have no package-level README; onboarding relies on inline docstrings and `.env.example` comments only. | Low | Add a short `bot/README.md` and `apps/publisher/README.md` covering the CLI commands (`python -m bot ...`, `python -m publisher.cli ...`) already documented as module docstrings. |
| 7.2 | The README describes `bot/bot` as "Private runtime foundation" but does not disclose that the two scan jobs it schedules (`pre_market_scan`, `post_close_scan`) are currently no-ops (see §8.1) — a reader would reasonably assume scanning is live. | Medium | Add a line to the README (or a `bot/README.md`) noting which scheduled jobs are implemented vs. placeholder. |
| 7.3 | No standalone API reference for the public `/api/*` surface (routes, response shapes, status codes) beyond reading the Worker source and the `packages/contracts` types. Fine for the current single-consumer (the SPA) but a gap if this API is meant to be public/external-facing per the README's framing ("Public, read-only market intelligence"). | Low | A short `docs/api.md` enumerating routes/shapes would help external consumers and reduce the schema-duplication risk in 2.2 by giving it one place to live. |

---

## 8. Tech debt / TODOs

A `grep` for `TODO|FIXME|HACK|XXX` across the repo returned **no real hits** — the codebase is unusually clean of debt markers. However, functional debt exists without being flagged as such:

| # | Finding | File/Line | Severity | Priority |
|---|---|---|---|---|
| 8.1 | `bot`'s core scan engine is not implemented: `pre_market_scan` and `post_close_scan` are registered against real cron triggers but resolve to `_noop()`, which only logs `"handler not wired yet — coming in later PRs"`. The scheduler, state store, and market-data pipeline around it are production-quality; the actual signal-generation logic referenced throughout the contracts (`Candidate`, `StrategySummary`, `DecisionReason`) doesn't exist yet in `bot`. | `bot/bot/scheduler.py:52-67` | Medium (by design, but should be tracked as an open item, not silent) | Medium |
| 8.2 | Same duplication concern as 2.2 — three independent copies of the dashboard/market-data schema is technical debt even though no `TODO` marks it. | `apps/web/src/lib/api.ts`, `apps/web/worker/ingest.ts`, `packages/contracts` | Medium | Medium |
| 8.3 | `bot/stock_autotrader_bot.egg-info/` build artifact tracked in git (2.4) is small but is the kind of thing that silently reappears and gets re-committed without a `.gitignore` fix. | `bot/stock_autotrader_bot.egg-info/` | Low | Low |

---

## Prioritized top 10

1. **Fix the `pull_request_target` CI hole in `deploy.yml`** — untrusted fork code currently runs (`npm ci`/build/test) before the fork-ownership check, with an elevated `GITHUB_TOKEN` reachable via `.git/config`. (§3.1 — Critical)
2. **Add tests for `apps/web/worker/index.ts`** — the entire public API surface has zero direct test coverage today. (§5.1 — High)
3. **Delete `apps/web/src/pages.tsx` and `components.tsx`** — ~2,000 lines of dead code that nothing routes to. (§2.1 — High)
4. **Stop re-running the full 7-query `buildDashboard()` for narrow endpoints** (`/api/earnings`, `/api/strategies`, `/api/portfolio/shadow`, `/api/stocks/:symbol`, `/api/market-data`) — give them scoped queries. (§6.1 — Medium)
5. **Unify the dashboard/market-data schema** into `packages/contracts` instead of three hand-maintained copies. (§2.2/§8.2 — Medium)
6. **Document (or wire up) the `bot` scan-engine stub** — either implement `pre_market_scan`/`post_close_scan` or make the README explicit that they're placeholders. (§8.1/§7.2 — Medium)
7. **Split `apps/web/worker/index.ts`** into a routing layer and a dashboard/read-model module now, before it grows further and before tests are added on top of it (do this alongside #2). (§2.3 — Medium)
8. **Add `bot/README.md` and `apps/publisher/README.md`** with the CLI usage already written as docstrings. (§7.1 — Low)
9. **Gitignore and remove `bot/stock_autotrader_bot.egg-info/`** from version control. (§2.4/§8.3 — Low)
10. **Add a Python linter (`ruff`) to `bot`/`apps/publisher` and to CI**, matching the strict ESLint gate already enforced on the JS side. (§2.5 — Low)

---

*No code was modified as part of this audit.*
