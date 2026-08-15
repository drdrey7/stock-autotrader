# CI hardening and merge discipline

This repository uses deterministic CI gates to reduce the risk of AI-generated or human-authored changes reaching `main` without independent validation.

## Required green checks before merge

A pull request should not be merged unless all applicable checks are green:

- CI: lint, TypeScript typecheck, unit/integration tests, coverage thresholds, build, Cloudflare dry-runs, local D1 migrations/seed verification, Python lint/tests.
- E2E: Playwright smoke tests on desktop Chromium and a mobile Chromium profile for `/`, `/x`, and `/earnings`, including primary navigation.
- Security: `npm audit` at high severity or above, `pip-audit` against the locked bot requirements, and Gitleaks history scanning.
- Independent review: no unresolved P0/P1/P2 findings from the configured review workflow.

## Coverage baseline

The frontend application coverage gate is scoped to `apps/web/src/**/*.{ts,tsx}`, excluding test files and `src/test-setup.ts`. The initial floor is 45% for lines, functions, branches, and statements, set just below the current frontend baseline so regressions fail CI without relying on worker or script coverage to subsidize the result.

This is a minimum regression barrier, not a target. Raise the thresholds as frontend coverage improves; do not lower them to make a feature PR green without documenting a specific reason.

## GitHub Free limitation

This repository is private and currently uses GitHub Free. Server-side branch protection/rulesets for private repositories may not be available on this plan. Until that changes, the repository owner must treat the checks above as mandatory merge policy and avoid direct feature work on `main`.

## Definition of done for feature/fix PRs

1. Keep scope small and avoid unrelated refactors.
2. Add or update tests for changed behavior and realistic failure modes.
3. Never commit secrets, credentials, API tokens, production `.env` values, or private user data.
4. CI, E2E, Security, deployment validation, and independent review must be green.
5. Resolve all blocking review threads before merge.
6. Prefer squash merge for noisy agent iteration history when appropriate.

## Supply-chain notes

GitHub Actions touched by the hardening work are pinned to immutable commit SHAs rather than floating tags. OpenCode is pinned to a verified commit rather than the annotated `latest` tag object. External CLI tools used only by CI are version-pinned and do not become production dependencies.
