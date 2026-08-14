# Repository Audit — stock-autotrader

Date: 2026-08-14
Commit: `831434e` (`main`)
Scope: full monorepo — `apps/web`, `apps/publisher`, `bot`, `packages/contracts`, CI/CD.

This is a fresh full audit, not a diff against the previous one. It supersedes
the earlier report. Since that audit, three follow-up PRs merged (#21
housekeeping, #22 worker tests, #23 schema unification + routing split), and
the findings below reflect the post-merge state — including two findings that
those PRs created or left behind.

**Baseline verified at audit time:** 242 web tests, 62 publisher tests, 44 bot
tests — all passing. `npm audit`: 0 vulnerabilities. `ruff check`: clean.
`grep -rE "TODO|FIXME|HACK|XXX"`: no real hits (one test-fixture string).

---

## 1. Architecture overview

```
apps/web/                Cloudflare Worker + React 19 SPA — the only deployed surface
  worker/index.ts         Routing only (258 lines)
  worker/dashboard.ts     Dashboard/source-health read model + scoped table readers (694)
  worker/ingest.ts        HMAC-signed write API for VPS-produced events (478)
  worker/earnings/        Automated Earnings Engine: providers, logic, storage (~1,900)
  worker/market-context.ts  Index + Fear&Greed collectors (Cron) (528)
  worker/{daily-briefings,x-posts,cron-dispatcher}.ts
  src/morning-briefing/   The live product UI
  migrations/             D1 schema, 9 migrations

apps/publisher/          Python stdlib-only VPS client → signed ingest
bot/                     Python VPS runtime (APScheduler); market-data pipeline live,
                          scan/signal engine still stubbed
packages/contracts/      Shared Zod schemas + TS types (daily-briefing, dashboard,
                          source-health, briefing-universe)
```

**Two independent write paths into D1:**

1. **VPS → signed ingest.** `bot` and `apps/publisher` POST normalized events to
   `/ingest/events`, HMAC-SHA256 signed over `${timestamp}.${body}`, with a
   5-minute replay window, a 1 MB body cap, per-`event_id` idempotency ledger,
   and strict Zod validation. Nothing enters D1 unvalidated.
2. **Worker-native Cron.** Two triggers (`*/15 * * * *`, `0 6 * * *`) fan out via
   `cron-dispatcher.ts` to the earnings monitor, market-context collector,
   sentiment collector, and daily earnings calendar sync — no VPS in the loop.

**Read path.** GET-only `/api/*`, unauthenticated, `cache-control: max-age=60`.
`index.ts` routes; `dashboard.ts` builds and validates every read model,
failing closed to conservative empties rather than serving unvalidated shapes.

The design principle throughout is *honest provenance*: freshness is derived
(`Live`/`Stale`/`Cached`/`Error`/`Unavailable`) rather than asserted, and every
degradation path is explicit. That principle is implemented unusually well, and
most findings below are about places where it isn't yet fully enforced by
construction.

---

## 2. Code quality

| # | Finding | File/Line | Severity | Fix |
|---|---|---|---|---|
| 2.1 | **The entire frontend dashboard data layer is dead code.** `main.tsx` renders `<App/>` with no `DataProvider` wrapper; `App.tsx` routes only to `MorningBriefingApp` (which uses its own `MorningBriefingDataProvider`) and `daily-briefing-pages.tsx`. Nothing imports `DataProvider` or `useData`. That makes `lib/data-provider.tsx`, `lib/data-context.ts` and `lib/api.ts`'s `getDashboardData()` unreachable from the app entry graph — kept alive only by `api.test.ts` — and transitively strands `packages/contracts/src/demo-data.ts` (560 lines, deep-import only). ~700 lines total. Knock-on effects: `/api/dashboard` has **no frontend consumer at all**, and the `VITE_DEMO_MODE` / `VITE_API_BASE_URL` plumbing (in `.env.example`, `.env.production` and `deploy.yml`) configures a code path that never runs. Same class of leftover as the `pages.tsx` shell removed in #21, one layer deeper. | `apps/web/src/lib/{api.ts,data-provider.tsx,data-context.ts}`, `packages/contracts/src/demo-data.ts` | High | Delete the three `lib/` modules and their test; keep `demo-data.ts` only if you want it as a test fixture (then move it under a test directory). Decide separately whether `/api/dashboard` stays as a public API or goes. |
| 2.2 | The `isoTimestamp` primitive (`z.string().datetime({ offset: true })`) is defined **six times** and the calendar-date primitive three times, across `worker/{ingest,x-posts,dashboard}.ts` and `contracts/{dashboard,daily-briefing,source-health}.ts`. PR #23 unified the composite `dashboardReadSchema` but left the leaf validators duplicated, so the same drift risk it fixed still exists one level down. | see grep in §8 | Medium | Export `isoTimestampSchema` / `marketDateSchema` from `packages/contracts` and import them everywhere. |
| 2.3 | `normalizeEvent()` hardcodes `calendarProvider: "fmp-earnings-calendar"` and `consensusProvider: "fmp-earnings-calendar"`, but the engine falls back to SEC EDGAR whenever `FMP_API_KEY` is unset (`createDefaultEarningsProviders`). Every current call site immediately corrects this via `applyProviderNames()`, so it is **not a live bug** — but it is a loaded gun in the one part of the codebase whose entire thesis is never mislabelling where data came from. A future direct call would silently attribute SEC data to FMP. | `apps/web/worker/earnings/logic.ts:186-187` | Medium | Make the provider names required parameters of `normalizeEvent()` so the type system forces the caller to supply them. |
| 2.4 | Dead exports left by the #23 schema move: `EVENT_TYPES` and `dailyBriefingPublishedEventSchema` have zero references outside `ingest.ts`; `marketDateSchema` and `isoTimestampSchema` are still `export`ed there but no module imports them from `ingest.ts` any more. | `apps/web/worker/ingest.ts:16,44,76,180` | Low | Drop the `export` keyword or delete. |
| 2.5 | `apps/web/public/_routes.json` is a **Cloudflare Pages** routing file. This project deploys as a Worker with Assets, which ignores it (the equivalent is `assets.run_worker_first`, which production doesn't set — it relies on asset-miss fallthrough, which works). Inert config that reads as load-bearing. | `apps/web/public/_routes.json` | Low | Delete it, or add a comment in `wrangler.jsonc` noting production routes by fallthrough. |

Positives worth recording: zero `any`/`as any` in the TS codebase, no stray
`console.log`, no debt markers, all `target="_blank"` links carry
`rel="noreferrer"`, and the D1 access layer is uniformly parameterized.

---

## 3. Correctness

| # | Finding | File/Line | Severity | Fix |
|---|---|---|---|---|
| 3.1 | **`startOfWeek()` is inconsistent on Sundays.** `day === 0 ? 0 : 1 - day` makes Sunday its own week start while every other day anchors to Monday. Verified: Fri 2026-08-14 → week `08-10..08-16`; Sat 08-15 → `08-10..08-16`; **Sun 08-16 → `08-16..08-22`**. So a Sunday is simultaneously the last day of the Mon–Sun week and the first day of its own, and `/api/earnings`'s `summary.thisWeek` silently reports a *forward* week for one day out of seven. | `apps/web/worker/earnings/logic.ts:46-51` | Medium | `return addDays(dateKey, day === 0 ? -6 : 1 - day)` — verified to give all seven weekdays the same Mon–Sun week. Add a seven-weekday test. |

---

## 4. Security

Overall posture is strong; no exploitable finding was identified.

| # | Finding | Severity | Notes |
|---|---|---|---|
| 4.1 | **No hardcoded secrets.** The only matches are test fixtures (`"wrong-secret"`, `"super-secret-value"`). `bot/config.py` actively rejects placeholder values in production. `FMP_API_KEY`/`SEC_USER_AGENT` are read only from `env`, never logged (provider errors log HTTP status only, not the `apikey=`-bearing URL). | — | No action |
| 4.2 | **No SQL injection.** The three template-literal `prepare()` calls interpolate only generated `?` placeholder strings and a static column-name constant; all values go through `.bind()`. | — | No action |
| 4.3 | **No XSS vector into `href`.** Defense in depth is real here: X post URLs are validated server-side against a strict host/path/encoding allowlist, briefing `reference` is `httpsUrl` in the contract, and `earnings-view.ts` **re-validates** every URL client-side with a protocol allowlist before rendering. | — | No action |
| 4.4 | **CI is safe.** `deploy.yml` runs on plain `pull_request` with `persist-credentials: false` and `npm ci --ignore-scripts`; secrets are gated to `push` on `main`. The one `pull_request_target` workflow (`deferred-review-issues.yml`) has no checkout and never executes repo code. `ci.yml` asserts the preview Worker config carries zero storage bindings/secrets/crons — a regression test for the boundary itself. | — | No action |
| 4.5 | The `_headers` CSP and hardening headers apply to **static asset** responses. `/api/*` JSON is generated by the Worker's own `json()` helper, which sets CORS + cache headers but **not** `X-Content-Type-Options: nosniff`. Low impact for `application/json`, but it's a free hardening win and the asset side already sets it. | Low | Add `"x-content-type-options": "nosniff"` to the `json()` helper in `worker/index.ts:46-56`. |
| 4.6 | `earnings-view.ts`'s `httpUrlValue()` accepts `http:` as well as `https:`, so a plaintext SEC/IR link would render as a live link under an HTTPS page (mixed-content downgrade). Upstream data is SEC/FMP so this is unlikely in practice. | Low | Restrict to `https:` unless a real `http:`-only source is known. |

---

## 5. Dependencies

| # | Finding | Severity | Fix |
|---|---|---|---|
| 5.1 | `npm audit` (with and without dev): **0 vulnerabilities**. | — | — |
| 5.2 | **Broad major-version drift.** ~16 packages are a full major behind: `eslint` 9→10, `vite` 7→8, `vitest` 3→4, `typescript` 5.9→7, `jsdom` 26→30, `@cloudflare/workers-types` 4→5, `lucide-react` 0.468→1.31, `motion` 12→13, `@vitejs/plugin-react` 5→6, `eslint-plugin-react-hooks` 5→7, `globals` 16→17, `@testing-library/jest-dom` 6→7. No security exposure today, but the longer this sits the more the eventual upgrade becomes one large risky change instead of several small ones. | Medium | Schedule a batched upgrade (tooling first: eslint/vitest/vite/TS; then runtime deps), or add Renovate/Dependabot to keep the delta small. |
| 5.3 | `bot/pyproject.toml` still pins loose ranges with no lockfile — reproducibility on a long-lived VPS process depends on install-time resolution. | Low | Add a lockfile (`uv lock` / `pip-compile`) or pin exact versions. |
| 5.4 | Two unofficial third-party runtime endpoints (Yahoo chart, CNN Fear & Greed) plus paid FMP. All isolated behind provider interfaces, degrade rather than fail, and documented. Accepted risk. | Low | No urgent action. |

---

## 6. Testing

| # | Finding | Severity | Fix |
|---|---|---|---|
| 6.1 | **Coverage is unmeasured** — `@vitest/coverage-v8` isn't installed, so `vitest run --coverage` fails. With 242 tests across 18 files there is clearly substantial coverage, but no one can see where the holes are, and CI can't enforce a floor. | Medium | Add `@vitest/coverage-v8` as a dev dep and print a coverage summary in CI (a threshold can come later). |
| 6.2 | Every worker module is exercised by at least one test file except `earnings/universe.ts`, which no test imports directly. | Low | Add direct tests for `normalizeSymbol` / `isInEarningsUniverse`. |
| 6.3 | `bot` still has no `test_scheduler.py`; `_cron()` 5-field parsing and `next_runs()` are only covered indirectly through `bot smoke`. | Low | Add direct tests. |
| 6.4 | No skipped, `.only`, or disabled tests anywhere in either language. Test hygiene is good. | — | — |

---

## 7. Performance

| # | Finding | File/Line | Severity | Fix |
|---|---|---|---|---|
| 7.1 | **`/api/status` is the remaining unscoped hot path.** It runs the full `buildDashboard()` (9 D1 queries) plus `readBriefingStatus`, `readMarketContext` and `buildSources` (2 more) — roughly **12 queries per call** — and the Morning Briefing UI polls it **every 60s per open tab**. Yet the UI consumes only three fields from that response (`briefing`, `market.indices`, `sentiment`); it never touches the `candidates`/`strategies`/`positions`/`research`/`events` half of the dashboard payload. This is precisely the pattern PR #23 fixed for the four narrow endpoints, left standing on the one endpoint that actually gets polled. | `apps/web/worker/index.ts:99-124`, `apps/web/src/morning-briefing/MorningBriefingData.tsx:312-317,423` | Medium | Either add a scoped `/api/status` variant (or `?fields=` projection) returning just briefing + market + sentiment + sources, or have the UI stop requesting the dashboard half. Edge caching softens but does not remove the cost. |
| 7.2 | Client polling is otherwise well-behaved: 60s interval, `visibilitychange`-gated, request-id guarded against races, 8s `AbortController` timeouts, and earnings on a separate 1h cadence. | `MorningBriefingData.tsx` | — | — |
| 7.3 | No N+1 patterns found; `buildDashboard` batches its reads via `Promise.all` and fetches `decision_reasons` in a single `IN (...)` query. Migrations index the columns actually queried. | — | — | — |

---

## 8. Documentation

| # | Finding | Severity | Fix |
|---|---|---|---|
| 8.1 | The README's project-structure block is **stale in its most important rows**: it lists `worker/daily-briefings.ts` and `worker/x-posts.ts` but omits `worker/dashboard.ts` (694 lines — the entire read model) and the whole `worker/earnings/` package (~1,900 lines — the Earnings Engine). A newcomer reading only the README would not know the two largest backend modules exist. | Medium | Add both rows. |
| 8.2 | Still no `/api/*` reference doc. There are now two undocumented public route families with query parameters (`/api/earnings` takes `from`/`to`/`symbol`/`status`; `/api/x/posts` takes `author`/`symbol`/`limit`), discoverable only by reading `validateEarningsQueryValue` and the route handlers. The README frames the product as a public read-only API, which raises the bar here. | Low | A short `docs/api.md`; `packages/contracts` now gives it a natural home for the shapes. |
| 8.3 | `bot/README.md` and `apps/publisher/README.md` (added in #21) are accurate, and the root README correctly discloses the `bot` scan-engine stub. | — | — |
| 8.4 | `AUDIT.md` (this file's predecessor) was never merged to `main` — it lived only on `claude/repository-audit-tq3ifc` and had gone stale as its findings were fixed. | Low | Merge this one, or keep audits out of the repo deliberately. |

---

## 9. Tech debt / TODOs

`grep -rE "TODO|FIXME|HACK|XXX"` across all source, config, SQL and Markdown
returns **one** hit, and it is a test fixture string (`"HACK_EVENT"` in
`ingest-schema.test.ts:288`) — not debt. The codebase carries no debt markers.

The real debt is structural rather than annotated:

| # | Item | Location | Severity |
|---|---|---|---|
| 9.1 | `bot`'s scan/signal engine remains unimplemented — `pre_market_scan` / `post_close_scan` are registered against live cron schedules but resolve to `_noop()`. Everything around it (scheduler, state ledger, market-data pipeline, publishing) is production-quality. This is now honestly documented, but it means the `scan_candidates` / `strategies` / `shadow_positions` half of the public contract has no producer — which is also *why* finding 2.1 and 7.1 exist: the frontend stopped consuming that data, but the API and schema still carry it. | `bot/bot/scheduler.py:52-67` | Medium |
| 9.2 | Duplicated schema primitives (2.2) and dead exports (2.4) — the residue of the #23 unification. | worker + contracts | Low–Medium |

---

## Prioritized top 10

1. **Delete the dead frontend data layer** — `lib/api.ts`, `lib/data-provider.tsx`, `lib/data-context.ts` (+ decide the fate of `demo-data.ts` and `/api/dashboard`). ~700 unreachable lines, and it's actively misleading: it makes `VITE_DEMO_MODE` look meaningful. (§2.1 — High)
2. **Scope `/api/status`** — 12 D1 queries every 60s per tab to serve three fields. The single highest-traffic query path in the system. (§7.1 — Medium)
3. **Fix the Sunday `startOfWeek()` boundary** — a real, reproducible wrong number in `/api/earnings` one day a week; add a seven-weekday test. (§3.1 — Medium)
4. **Make provider names required parameters of `normalizeEvent()`** — close the provenance trap by construction rather than by convention. (§2.3 — Medium)
5. **Add `@vitest/coverage-v8` and report coverage in CI** — 242 tests with no visibility into what they miss. (§6.1 — Medium)
6. **Plan the dependency-major upgrade** (or enable Renovate) — 16 packages one major behind, zero vulns today, compounding risk. (§5.2 — Medium)
7. **Add `worker/dashboard.ts` and `worker/earnings/` to the README structure block** — the two biggest backend modules are invisible in the docs. (§8.1 — Medium)
8. **Hoist `isoTimestampSchema` / `marketDateSchema` into `packages/contracts`** — finish the #23 unification at the leaf level. (§2.2 — Medium)
9. **Decide `bot`'s scan engine: build it or formally retire it.** It's the root cause behind several other findings, and the Earnings Engine proved the Worker-native pattern works well. (§9.1 — Medium)
10. **Small hardening + cleanup**: `nosniff` on API JSON (§4.5), `https:`-only in `earnings-view.ts` (§4.6), drop dead `ingest.ts` exports (§2.4) and the inert `_routes.json` (§2.5). (Low)

---

*No code was modified as part of this audit.*
