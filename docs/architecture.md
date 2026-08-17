# Frontend Architecture

The web app is public and read-only. The frontend should stay easy to extend without turning route shells into feature monoliths.

## Core rules

1. **Route shells orchestrate; features own behavior.**
   `App.tsx` and `MorningBriefingApp.tsx` should decide what page to render, not contain feature UI, data parsing, or network requests.

2. **Data is loaded by the feature that needs it.**
   - Morning Briefing owns sentiment/status loading.
   - X Pulse owns X feed loading and cache behavior.
   - Earnings owns earnings loading, validation, and refresh policy.
   Opening `/` must not fetch X Pulse or Earnings data.

3. **Keep lazy routes lazy end-to-end.**
   Code-splitting a page is not enough if its data/parser module is imported by the default route. Route-specific data modules must remain behind the lazy page boundary.

4. **Prefer cohesive modules over giant files.**
   Extract a component or hook when it has its own state, effects, API contract, accessibility behavior, or reusable presentation logic. Do not split trivial markup into one-file-per-div components.

5. **No new feature pages loose in `src/`.**
   Existing root files are legacy/app entry points. New product areas must live in their own directory or an existing feature directory.

6. **Global state is exceptional.**
   Theme, navigation, and truly app-wide concerns can be global. X posts, earnings, stock detail data, breakouts, etc. should not be put into a global provider simply for convenience.

7. **CSS ownership follows features.**
   Avoid new generic global class names. Prefer feature-scoped selectors and keep shared global styles limited to tokens, resets, shell, and genuinely shared primitives.

## Review checklist

Every frontend PR should answer:

- Does this increase coupling between unrelated routes/features?
- Does a central/root component gain feature-specific state, effects, API calls, or business rules?
- Does the default route load code or data for a route the user has not opened?
- Is there a new global provider or global CSS rule that can remain feature-local?
- Is a file becoming a mixed-responsibility module?
- Can the feature be removed or changed without editing unrelated feature internals?

## Automated guardrail

`npm run lint -w @stock-autotrader/web` also runs `scripts/check-architecture.mjs`.

The script intentionally checks only high-signal rules: central-shell size, raw fetch ownership, root-level feature files, route-data boundaries, and oversized production TS/TSX modules. It is not a substitute for architecture review.
