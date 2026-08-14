# Repository Audit — stock-autotrader

Date: 2026-08-14 (recheck)
Scope: full monorepo (`apps/web`, `apps/publisher`, `bot`, `packages/contracts`, CI/CD config) at commit `97ec2d6` on `main` (`+` two merged PRs since the prior audit: #12 "fully automated earnings engine", #18 "safe PR previews and durable review workflow").

## Since the last audit

| Finding (prior report) | Status |
|---|---|
| 3.1 Critical — `pull_request_target` "pwn request" in `deploy.yml` | **Fixed.** See §3.1 below — build/test now runs under plain `pull_request` with no elevated token; preview deployment moved entirely out of GitHub Actions. |
| 2.1 High — dead code (`pages.tsx`/`components.tsx`) | **Still open.** Unchanged. |
| 5.1 High — no tests for `worker/index.ts` | **Still open.** Unchanged (now 823 lines). |
| 6.1 Medium — narrow endpoints re-run full `buildDashboard()` | **Partially fixed.** `/api/earnings` now has its own scoped read path; `/api/strategies`, `/api/portfolio/shadow`, `/api/stocks/:symbol`, `/api/market-data` still don't. |
| 2.2/8.2 Medium — duplicated dashboard schema | **Still open.** Unchanged. |
| 8.1 Medium — `bot` scan jobs are stubs | **Still open, but now documented** (see §7). |
| 2.4/8.3 Low — `bot/*.egg-info` tracked in git | **Still open.** Unchanged. |
| 7.1 Low — no `bot`/`apps/publisher` README | **Still open.** Unchanged. |
| 2.5 Low — no Python linter | **Still open.** Unchanged. |

The rest of this report re-audits the whole repository from scratch, including the large new Automated Earnings Engine, so it reflects the current state end to end — not just a diff.

---

## 1. Architecture overview

```
apps/web/           Cloudflare Worker + React SPA (the only deployed product surface)
  worker/            index.ts (routing + read models), ingest.ts (signed write API),
                      daily-briefings.ts, x-posts.ts, market-context.ts (Cron),
                      earnings/ (new: fully automated earnings engine, Cron)
  src/               React 19 SPA; morning-briefing/ is the live UI;
                      pages.tsx/components.tsx are unreferenced legacy demo code
  migrations/        D1 (SQLite) schema, 9 sequential migrations
  preview-worker.ts   Isolated read-only preview entrypoint (new, see §3.1)

apps/publisher/      Python, stdlib-only VPS client. Builds the Daily Briefing and
                      pushes it via a signed HTTP event.

bot/                 Python VPS runtime "foundation" (APScheduler). Market-data CSV
                      pipeline is implemented; scan/strategy engine is still stubbed.

packages/contracts/  Shared Zod schemas / TS types (DailyBriefing, dashboard,
                      now also the Earnings Engine's public contract).
```

**New since last audit — the Automated Earnings Engine (`apps/web/worker/earnings/`, ~2,300 lines + 617 lines of tests):** a second, independent earnings pipeline that runs *inside the Worker itself* (no VPS involved), on two Cron triggers (`0 6 * * *` daily calendar sync, `*/15 * * * *` monitor). It pulls from Financial Modeling Prep (paid, keyed) with SEC EDGAR (`company_tickers_exchange.json`, full-text index, `submissions/CIK*.json`) as a free fallback/enrichment source, normalizes Beat/Miss/In-Line results, and serves `/api/earnings` from its own `earnings_events`/`earnings_universe` tables — deliberately separate from the legacy publisher-fed `earnings` table (still used by `/api/dashboard`'s `earnings` field), and the README now explicitly documents that split. This is genuinely careful engineering: an explicit external-subrequest budget (`subrequest-budget.ts`) tracked against the Cloudflare Workers Free plan's 50-subrequest limit, SEC rate-limiting (125ms min interval), retry/backoff with `Retry-After` handling, and fail-degraded (never fail-closed-to-wrong-data) semantics throughout.

**CI/CD, rebuilt (`#18`):** preview deployment for PRs no longer runs in GitHub Actions at all. It's now handled by Cloudflare Workers Builds (external, trusted trigger) building a permanent `stock-autotrader-preview` Worker whose config (service binding, routes, env vars) is fixed outside the repo — a PR cannot inject D1/KV/secrets/cron into its own preview no matter what it changes in-repo. GitHub Actions now only validates config shape and runs tests. Documented in `docs/PR13_PR_PREVIEWS.md`.

Control flow (VPS → ingest → D1 → public API → SPA) is otherwise unchanged from the prior audit and remains a well-designed, fail-closed, idempotent write path.

---

## 2. Code quality

| # | Finding | File/Line | Severity | Fix |
|---|---|---|---|---|
| 2.1 | `pages.tsx` (1907 lines) and `components.tsx` (57 lines) remain entirely unreferenced — `App.tsx` still only renders `MorningBriefingApp`/`daily-briefing-pages.tsx`; legacy routes just redirect. Unchanged since the last audit. | `apps/web/src/pages.tsx`, `apps/web/src/components.tsx` | High | Delete both files. |
| 2.2 | The dashboard/market-data Zod schema is still hand-duplicated between `apps/web/worker/ingest.ts` (`marketDataSchema`, `dashboardReadSchema`) and `apps/web/src/lib/api.ts` (`dashboardPayload`, 228-line file), instead of both importing one schema from `packages/contracts`. The Earnings Engine, notably, did **not** repeat this mistake — its types live once in `packages/contracts` (`EarningsEngineEvent`, `EarningsApiResponse`) and are imported by both sides. | `apps/web/src/lib/api.ts:60-207`, `apps/web/worker/ingest.ts:170-308` | Medium | Apply the same pattern the Earnings Engine already uses: move the dashboard schema into `packages/contracts` and import it. |
| 2.3 | `apps/web/worker/index.ts` has grown to 823 lines and still mixes routing, dashboard read-model assembly, and source-health scoring with no sub-module split — even as the Earnings Engine correctly landed its own logic in a dedicated `earnings/` module. `index.ts` remains the outlier. | `apps/web/worker/index.ts` | Medium | Split `buildDashboard`/`buildSources`/`buildMarketSourceHealth` into their own module, mirroring `worker/earnings/`. |
| 2.4 | `bot/stock_autotrader_bot.egg-info/` build artifact is still committed (5 files), still not in `.gitignore`. | `bot/stock_autotrader_bot.egg-info/*` | Low | Add `*.egg-info/` to `.gitignore`; `git rm -r --cached`. |
| 2.5 | Python packages (`bot`, `apps/publisher`) still have no linter/formatter (ruff/flake8/black), unlike the JS side's `eslint --max-warnings=0`. | `bot/pyproject.toml` | Low | Add `ruff` to `bot` dev deps + CI. |
| 2.6 | Two parallel earnings systems now coexist: the legacy `earnings` table (populated by the publisher's `EARNINGS_UPDATED` ingest event, exposed via `dashboardReadSchema.earnings`) and the new `earnings_events` engine (`/api/earnings`). This is intentional and clearly documented in the README ("legacy `earnings` table remains a quant/screening table and is not read by `/api/earnings`"), so it's not a defect — but it is a second earnings code path a future contributor can accidentally read from, and there's no in-code comment at the `earnings` field's usage site in `index.ts` pointing at that README section. | `apps/web/worker/index.ts:429` vs `apps/web/worker/earnings/index.ts:323-355` | Low | A one-line code comment at `index.ts:429` cross-referencing the README section would prevent a future edit from "fixing" the wrong table. |

Elsewhere: still zero `any`/`as any` in the TS codebase, no stray `console.log`s, no new dead code introduced by the earnings PR, and the new provider/storage code (§3, §5) is held to the same high bar as the rest of the write path — input validation, typed error tuples, fail-degraded defaults.

---

## 3. Security

| # | Finding | File/Line | Severity | Fix |
|---|---|---|---|---|
| 3.1 | **Resolved.** The prior critical finding — `deploy.yml` running untrusted fork PR code (`npm ci`/build/test) under `pull_request_target` before the fork-ownership check, exposing an elevated `GITHUB_TOKEN` — is fixed. `deploy.yml` now triggers on plain `pull_request` (default, unprivileged token), checks out with `persist-credentials: false` (nothing for PR-run code to read even if it wanted to), and uses `npm ci --ignore-scripts`. Deployment (the only place secrets are used) is gated to `push` on `main` only. PR preview deployment moved out of Actions entirely into a Cloudflare Workers Builds trigger whose config lives outside the repo (§1), so no PR-controlled code path can reach production credentials or inject infrastructure into its own preview. | `.github/workflows/deploy.yml` | — (fixed) | — |
| 3.2 | The new `deferred-review-issues.yml` workflow correctly uses `pull_request_target` (which does grant `issues: write`/`pull-requests: write`) safely: it triggers only on `closed`+`merged`, has **no checkout step**, and only reads GitHub's review-thread API and writes Issues/comments — it never executes repository code. This is exactly the safe pattern for `pull_request_target`. | `.github/workflows/deferred-review-issues.yml:1-27` | — | — |
| 3.3 | The Earnings Engine introduces two new secrets, `FMP_API_KEY` and `SEC_USER_AGENT`. Both are handled correctly: only read from `env` inside the Worker, never interpolated into logged messages (errors log only HTTP status/short messages, not the request URL that carries `apikey=`), and `deploy.yml` only `secret put`s them when non-empty. No leak path found. | `apps/web/worker/earnings/providers.ts:232-237`, `.github/workflows/deploy.yml:66-71` | — | — |
| 3.4 | SEC filing URLs are built from provider data (CIK, accession number, filename) and are strictly validated with anchored regexes (`^\d{10}$`, `^\d{10}-\d{2}-\d{6}$`, `^[A-Za-z0-9._-]+$`) before being embedded in a URL — no path/URL injection from a malicious or malformed provider response. | `apps/web/worker/earnings/providers.ts:329-336` | — | — |
| 3.5 | The preview Worker's API proxy (`preview-api-proxy.ts`) is a solid boundary: allowlists GET/HEAD only, builds the downstream request from a fixed hostname (not client-controlled `Host`), strips `Set-Cookie` from the upstream response, and forwards no `Authorization`/`Cookie`/body. Good practice for a Worker that has a live service binding into production. | `apps/web/preview-api-proxy.ts` | — | — |
| 3.6 | No hardcoded secrets, injection risk, or new unvalidated-input path found anywhere in the diff since the last audit; all prior findings in this section (HMAC ingest auth, parameterized SQL, CSP headers, X-post URL validation) remain correct and unchanged. | — | — | — |

---

## 4. Dependencies

| # | Finding | Severity | Fix |
|---|---|---|---|
| 4.1 | `npm audit --production` still reports **0 vulnerabilities**. Wrangler is now pinned to an exact version (`4.122.0`) in every CI/deploy invocation rather than floating `@4`, which is a small reproducibility improvement over the prior audit. | — | Keep pinning; consider Dependabot/renovate for the pinned Wrangler version so it doesn't silently go stale. |
| 4.2 | The Earnings Engine adds a new *runtime* (not npm) dependency on Financial Modeling Prep, a paid third-party API, as the primary calendar/consensus source, with SEC EDGAR as a keyless fallback. This is a real availability/cost dependency (a lapsed `FMP_API_KEY` silently degrades to the free SEC-only path per `createDefaultEarningsProviders`), but it's deliberately designed to degrade rather than fail, and is documented in the README. | Low (self-disclosed, gracefully degrading) | No urgent action; monitor FMP quota/billing. |
| 4.3 | `bot/pyproject.toml` still pins loose ranges with no lockfile (unchanged from prior audit). | Low | Add a lockfile or pin exact versions. |

---

## 5. Testing

| # | Finding | File/Line | Severity | Fix |
|---|---|---|---|---|
| 5.1 | `apps/web/worker/index.ts` — routing, `buildDashboard`, `buildSources`, all source-health scoring — **still has no dedicated test file**, unchanged from the last audit, now at 823 lines. Every other worker module, including the large new `earnings/` package, has thorough tests. | `apps/web/worker/index.ts` | High | Add Miniflare/`vitest-pool-workers` tests for routing + the exported pure functions (`buildSources`, `buildMarketSourceHealth`, etc.). |
| 5.2 | The new Earnings Engine is well tested: `earnings.test.ts` (617 lines) plus a dedicated `subrequest-budget.test.ts` that asserts the request-budget math stays under the Workers Free plan limit — a good example of testing an operational constraint, not just business logic. `cron-dispatcher.test.ts` covers the new dual-cron dispatch table. | `apps/web/worker/earnings.test.ts`, `apps/web/worker/earnings/subrequest-budget.test.ts`, `apps/web/worker/cron-dispatcher.test.ts` | — | — |
| 5.3 | `ci.yml` gained a genuinely strong new safety net: it asserts the *production* `wrangler.jsonc` has exactly the two expected cron triggers, and that `wrangler.preview.jsonc` contains **zero** storage bindings/secrets/crons and exactly one service binding — failing the build if a future PR accidentally widens the preview Worker's envelope. This directly protects the fix in §3.1/§3.5 from regressing. | `.github/workflows/ci.yml:33-42` | — | — |
| 5.4 | `bot/tests/` still has no `test_scheduler.py` (unchanged, low). No skipped/disabled tests found anywhere in either language. | `bot/tests/` | Low | Add direct `_cron()`/`next_runs()` tests. |

---

## 6. Performance

| # | Finding | File/Line | Severity | Fix |
|---|---|---|---|---|
| 6.1 | `buildDashboard(env)`'s 7-parallel-query D1 read is now scoped correctly for `/api/earnings` (moved to `readEarningsApi`, its own targeted query), but `/api/strategies`, `/api/portfolio/shadow`, `/api/stocks/:symbol`, and `/api/market-data` still fetch and discard the entire dashboard for a single-table answer. | `apps/web/worker/index.ts:420-433` (called from lines ~803, 811, 754, 765) | Medium | Give the remaining narrow endpoints their own scoped queries, same pattern already used for `/api/earnings`. |
| 6.2 | The Earnings Engine's SEC full-index path fetches up to 3 quarterly master indexes (each potentially large text files) per calendar sync, parsed with a per-line regex — bounded and rate-limited, not a concern at current scale, but worth watching if the tracked universe grows substantially. | `apps/web/worker/earnings/providers.ts:466-500` | Low | No action now; revisit if `EARNINGS_UNIVERSE` grows materially. |
| 6.3 | Client-side polling and edge caching (60s `cache-control`) are unchanged and still correctly implemented. | `apps/web/src/lib/data-provider.tsx` | — | — |

---

## 7. Documentation

| # | Finding | Severity | Fix |
|---|---|---|---|
| 7.1 | The README grew substantially (+103 lines) and now documents the Earnings Engine's ownership boundaries, the legacy/new earnings table split, cron schedules, and the preview-Worker security model in detail — a real improvement over the last audit. | — | — |
| 7.2 | `bot/` and `apps/publisher/` still have no package-level README (unchanged, low). | Low | Add short READMEs for each, per the last audit's recommendation. |
| 7.3 | The prior finding that the README didn't disclose `bot`'s scan jobs are stubs is **no longer accurate as stated** — the current README frames `bot/bot` correctly as a "foundation," and the stub nature is discoverable from `bot/bot/scheduler.py`'s own comments (`"Skeleton jobs — handlers arrive in later PRs"`). Downgrading this from a documentation gap to a tracked-but-unimplemented feature; no README change strictly required, though an explicit one-line callout would still remove any ambiguity for a new contributor skimming only the README. | Low | Optional: one line in the README's `bot/bot` description. |
| 7.4 | No standalone `/api/*` reference doc still exists (unchanged); the Earnings Engine adds yet another route (`/api/earnings`) with query parameters (`from`, `to`, `symbol`, `status`) that are currently only documented in code (`validateEarningsQueryValue`, `readEarningsApi`). | Low | A `docs/api.md` would now cover two undocumented-but-public route families instead of one. |

---

## 8. Tech debt / TODOs

`grep -rn "TODO|FIXME|HACK|XXX"` across the entire repo (including the new `earnings/` module and CI scripts) still returns **no real hits** — the codebase remains unusually clean of debt markers.

| # | Finding | File/Line | Severity | Priority |
|---|---|---|---|---|
| 8.1 | `bot`'s scan engine (`pre_market_scan`, `post_close_scan`) is still `_noop`. Notably, the team chose to build the new Earnings Engine as a *separate, Worker-native* system rather than wiring it through `bot`, which is a reasonable call given `bot`'s scan engine isn't ready — but it does mean `bot`'s original purpose (screening/signal generation feeding `scan_candidates`) is now the only unimplemented piece of the originally-designed architecture. | `bot/bot/scheduler.py:52-67` | Medium | Medium |
| 8.2 | Duplicated dashboard schema (2.2) remains the most concrete "should fix" debt item, made more visible by contrast with the Earnings Engine's correct single-source-of-truth contract. | `apps/web/src/lib/api.ts`, `apps/web/worker/ingest.ts` | Medium | Medium |
| 8.3 | `bot/stock_autotrader_bot.egg-info/` still tracked (unchanged). | `bot/stock_autotrader_bot.egg-info/` | Low | Low |

---

## Prioritized top 10

1. **Add tests for `apps/web/worker/index.ts`** — still the only major untested file in the backend, and now the clear outlier next to the well-tested `earnings/` module. (§5.1 — High)
2. **Delete `apps/web/src/pages.tsx` and `components.tsx`** — ~2,000 lines of confirmed-dead code, unaddressed since the last audit. (§2.1 — High)
3. **Unify the dashboard/market-data schema** into `packages/contracts`, following the pattern the Earnings Engine already established correctly. (§2.2/§8.2 — Medium)
4. **Finish scoping the remaining narrow endpoints** (`/api/strategies`, `/api/portfolio/shadow`, `/api/stocks/:symbol`, `/api/market-data`) off `buildDashboard()`, matching what was already done for `/api/earnings`. (§6.1 — Medium)
5. **Split `apps/web/worker/index.ts`** into routing vs. dashboard/read-model modules, mirroring `worker/earnings/`'s structure — do this alongside #1. (§2.3 — Medium)
6. **Decide the fate of `bot`'s scan engine** — implement it or formally retire/repurpose `bot` now that the Earnings Engine proved the "runs natively in the Worker" pattern works well. (§8.1 — Medium)
7. **Add a one-line cross-reference comment** at `index.ts:429` pointing to the README's legacy-vs-engine earnings-table explanation, to stop a future edit from reading the wrong table. (§2.6 — Low)
8. **Add `bot/README.md` and `apps/publisher/README.md`.** (§7.2 — Low)
9. **Gitignore and remove `bot/stock_autotrader_bot.egg-info/`.** (§2.4/§8.3 — Low)
10. **Add `ruff` to `bot`/`apps/publisher` + CI.** (§2.5 — Low)

The prior #1 (the `pull_request_target` CI hole) is off this list because it's fixed — and fixed unusually well, with a regression test (§5.3) added to keep it fixed.

---

*No code was modified as part of this audit.*
