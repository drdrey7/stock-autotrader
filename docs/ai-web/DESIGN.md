# AI Web — Design & Implementation Specification

## 1. Purpose

Build a new **public AI Stock Analysis frontend** inside the existing `stock-autotrader` monorepo.

This new app is a separate public product surface. The current Stock AutoTrader site remains personal/private and should keep its existing architecture and behaviour.

The new public app must reuse the existing backend infrastructure wherever possible:

- existing Cloudflare Worker API
- existing Cloudflare D1 database
- existing Better Auth implementation
- existing AI Analysis API
- existing credits state/ledger behaviour
- existing Cloudflare Queue
- existing VPS AI Analysis Runner
- existing TradingAgents execution flow
- existing shared contracts

Do **not** rebuild the AI Analysis backend from scratch.

The new app should live at:

`apps/ai-web/`

The final public brand name is not decided yet. Use a neutral internal name such as `AI Web` / `ai-web` in code. Do not hard-wire `StockAI` as the final brand just because it appears in the reference image.

---

## 2. Primary visual reference

The approved design direction is **Teal & Blue Nebula**.

Reference image:

`docs/ai-web/reference/landing-teal-blue-nebula.jpeg`

Treat the image as the visual source of truth for overall mood, composition, spacing, colours, density and responsive intent. Do not mechanically copy fake content or fake metrics from the mockup.

Key visual characteristics:

- premium dark-first fintech / AI aesthetic
- very dark navy / near-black canvas in dark mode
- teal and cyan accents
- blue/teal nebula glow
- subtle stars / particles / atmospheric depth
- curved planetary horizon near the lower part of the hero on desktop
- glassy surfaces with restrained borders and glow
- large high-contrast typography
- strong visual hierarchy
- minimal chrome
- fluid motion and micro-interactions
- responsive mobile composition
- equally polished light mode using pale blue/white atmospheric nebula styling

Avoid a generic SaaS template look.

---

## 3. Product architecture

The target architecture is:

```text
Public AI frontend (Astro 7)
        |
        | same-origin /api routes where practical
        v
Existing Cloudflare Worker
        |
        +--> Better Auth
        +--> AI Analysis API
        +--> Credits
        |
        v
Existing D1
        |
        v
Existing Cloudflare Queue
        |
        v
Existing VPS AI Analysis Runner
        |
        v
TradingAgents / LLM
        |
        v
D1 result
```

The existing Stock AutoTrader frontend stays separate and private/personal.

Do not expose unrelated private Stock AutoTrader data or APIs through the new public app.

The public AI app should only need access to the data required for:

- authentication/session
- current user
- credits
- creating AI analyses
- analysis status/progress
- completed reports
- user analysis history
- account/billing data when Stripe is later added

---

## 4. Framework and implementation principles

Use **Astro 7** as the frontend framework.

Preferred principles:

- Astro server rendering where authenticated/dynamic data is required
- static/server-rendered HTML for marketing content
- TypeScript
- minimal client JavaScript
- Vanilla JS / CSS for simple interactions where practical
- Astro islands only where real interactivity requires them
- do not introduce React globally just because the existing app uses React
- if a React island is justified later, keep it isolated
- optimise for Core Web Vitals and mobile performance
- semantic HTML and accessibility from the start

Use the philosophy seen in `canivibecodeit/canivibecodeit`: fast server-rendered pages, minimal unnecessary framework runtime in the browser, and interaction layered on top rather than making the entire site a heavy SPA.

---

## 5. PR1 scope

PR1 must be **visible and usable**, not infrastructure-only.

By the end of PR1, it should be possible to open the new frontend and clearly see the approved Teal & Blue Nebula visual direction.

PR1 should include:

- `apps/ai-web/` Astro 7 app
- monorepo/workspace integration
- Cloudflare-compatible build/runtime configuration
- shared contract integration where appropriate
- landing page
- dark mode
- light mode
- desktop layout
- mobile layout
- responsive navigation
- account icon / sign-in entry point
- public `/pricing` page shell
- authenticated `/app` shell
- Better Auth integration using the existing backend
- session-aware UI
- existing credit balance visible for authenticated users
- basic existing analysis history visible if practical within the current API boundary
- sponsor/ad placeholders with the placement rules below
- first-pass motion system
- tests, typecheck, lint/build integration
- documentation for local development

PR1 does **not** need Stripe checkout or full billing.

PR1 does **not** need to rebuild the AI execution backend.

---

## 6. Landing page layout — desktop

### Header

Desktop header should feel light and integrated into the hero rather than a bulky navbar.

Include:

- temporary logo/wordmark area on the left
- centre/right navigation links such as:
  - How it works
  - Pricing
  - Examples
  - About
- Sign in
- account/user icon
- optional primary sign-up CTA if it improves the composition
- dark/light theme control, preferably compact and visually consistent

Do not overcrowd the header.

### Hero

Core approved composition:

- large centered headline
- visual wording direction:
  - `AI Analysis.`
  - `Better Decisions.`
- second line / emphasized words use teal/cyan accent
- supporting copy describing multi-agent stock analysis
- ticker input/search field
- primary `Analyze Stock` CTA
- small popular ticker shortcuts below or near the input
- decorative nebula atmosphere around the content
- planetary horizon / curved planetary surface toward the lower hero area on desktop

The exact marketing copy can be refined later. Keep it credible and do not fabricate performance claims.

### Stats / proof strip

The mockup contains items such as agent count, average analysis time, report count and uptime.

For implementation:

- `7 AI Agents` can be shown if it matches the actual engine configuration
- do **not** publish fabricated values such as `50K+ reports`, `99.9% uptime`, ratings, testimonials or user counts unless backed by real data
- where a metric is not yet available, use a neutral product capability instead or omit it

Examples of safer capability cards:

- 7 AI Agents
- Multi-angle Research
- Bull + Bear Debate
- Saved Reports

### Lower landing sections

PR1 may include a concise first version of:

- How it works
- agent/team overview
- example report preview shell
- pricing CTA
- footer

Keep the page focused rather than extremely long.

---

## 7. Landing page layout — mobile

Mobile is a first-class requirement, not a desktop afterthought.

Target common iPhone widths around 390–430 px and test smaller widths too.

Mobile behaviour:

- compact header
- hamburger/menu icon if needed
- logo centered or left depending on balance
- account icon remains clearly available
- headline remains large but does not overflow
- ticker input and CTA become full-width stacked controls if required
- capability/stat cards may use a 2-column grid
- agent cards become a vertical list or compact carousel/list
- no horizontal overflow
- comfortable touch targets
- respect iOS safe areas

---

## 8. Advertising placement

Advertising placeholders are part of the layout from the beginning so the future monetisation model does not destroy the design later.

### Desktop

Use vertical sponsor/ad slots on the **left and right sides** of the main hero/content column.

Requirements:

- visually secondary
- must not squeeze the core app excessively
- disappear or reposition below the desktop breakpoint
- reserve stable dimensions to minimise layout shift
- placeholder styling should fit the design but clearly indicate sponsor/ad inventory

### Mobile

Do not use side ads.

Use a **horizontal sponsor/ad slot near the top** of the page, below or adjacent to the mobile header as appropriate.

Requirements:

- stable reserved height
- must not dominate the first viewport
- responsive width
- accessible label such as `Sponsor` / `Advertisement`

No real ad network integration is required in PR1 unless explicitly requested later.

---

## 9. Dark mode

Dark mode is the primary visual reference.

Suggested palette direction, to be implemented as design tokens rather than scattered literals:

- background: near-black navy
- elevated surface: deep blue-black
- border: low-opacity cyan/blue
- primary teal: vivid but not fluorescent
- secondary cyan/blue
- text primary: soft white
- text secondary: desaturated blue-grey
- success/status colours should remain accessible

Nebula/space effects must remain subtle enough that text readability stays excellent.

Do not use huge raster backgrounds if a smaller optimised asset plus gradients/CSS effects can achieve the same result.

---

## 10. Light mode

Light mode must feel intentionally designed, not simply inverted.

Direction:

- off-white / very pale blue canvas
- soft blue and teal atmospheric nebula
- darker navy text
- teal accents
- subtle glass/white surfaces
- restrained shadows
- planetary horizon may become pale/icy rather than dark space

Maintain contrast to WCAG-friendly levels.

Theme choice should persist for returning users.

System preference can be respected on first visit unless product requirements specify a fixed default later.

---

## 11. Motion and interaction system

The site should feel fluid and modern, but performance takes precedence over decorative animation.

Use restrained, high-quality animation such as:

- slow nebula drift
- subtle star/particle movement
- low-amplitude glow breathing
- gentle parallax on desktop only where performant
- hero content entrance transitions
- small hover lift/glow on capability cards
- button highlight sweep or gradient motion
- smooth theme transition
- scroll reveal for lower sections
- subtle account/menu transitions

Rules:

- honour `prefers-reduced-motion`
- avoid continuous CPU-heavy canvas/WebGL unless measurement proves it is worthwhile
- avoid animation libraries for effects CSS can handle cleanly
- no excessive bouncy motion
- animation should feel premium, not game-like
- mobile animations should be lighter than desktop

---

## 12. Authentication

Reuse the existing Better Auth implementation.

Current backend already binds Better Auth to Cloudflare D1.

Do not create a second authentication database or separate auth stack.

The new public app needs a safe origin/session integration. Prefer same-origin public routes/proxy/service binding behaviour where practical so the browser can use paths like:

```text
/api/auth/*
/api/ai-analysis/*
```

without unnecessary cross-origin complexity.

Review the existing Better Auth configuration, especially `baseURL`, `trustedOrigins`, secure cookies and production behaviour. Preserve fail-closed security semantics.

Authenticated UI requirements:

- account icon in header
- signed-out state: `Sign in`
- signed-in state: avatar/account menu or equivalent
- `/app` protected
- credits visible to the authenticated owner
- user must never be able to access another user's reports

---

## 13. `/app` dashboard shell

PR1 should create a clean authenticated shell.

Suggested layout:

```text
[Logo]                         [credits] [account]

What stock should we research?

[Ticker input                         ]
[Run AI Analysis]

Recent analyses
-------------------------------------
NVDA        Completed        View
MSFT        Completed        View
...
```

Keep this much simpler than the private Stock AutoTrader interface.

The public product is not a stock terminal or screener.

---

## 14. Future analysis experience — design now, implement mainly in PR2

PR2 will build the full run/progress/report experience, but PR1 architecture should not block it.

Expected flow:

```text
Ticker
  -> create analysis
  -> credit reservation
  -> queued
  -> running
  -> stage/progress UI
  -> completed
  -> report
```

The run screen should eventually show stage-level progress rather than an opaque spinner, for example:

- Market Analyst
- Fundamentals Analyst
- News & Sentiment Analyst
- Bull Researcher
- Bear Researcher
- Risk / Research Manager stages
- Portfolio Manager / final decision

Do not expose hidden chain-of-thought or raw model reasoning. Only display safe progress/status and final report content intended for the user.

---

## 15. Pricing page

PR1: build the polished visual shell and explain the credit model without wiring payments.

PR3 will add Stripe.

Do not hard-code final prices until actual per-analysis cost and target margin are validated.

Pricing page should be designed for simple prepaid credit packs rather than forcing a subscription model in v1.

---

## 16. Existing private Stock AutoTrader

Do not migrate or duplicate these private product surfaces into `ai-web`:

- Screener
- Stock Detail
- Heatmap
- X Pulse
- earnings UI
- private market context
- private quote/fundamental/history interfaces

The private app remains as-is.

Later, its `AI Analysis` navigation item can simply link externally to the new public AI product.

---

## 17. Security boundary

This separation is important.

The public frontend must not accidentally expose the broad private Worker API just because it shares infrastructure.

Review and enforce a narrow public API surface.

Requirements include:

- server-side authorization on every user-owned resource
- ownership checks for report/history reads
- authenticated mutations
- CSRF/origin protections appropriate to Better Auth/current Worker architecture
- no client-side secrets
- no D1 binding in browser code
- no direct Queue credentials in browser code
- no LLM/provider secrets in browser code
- no unrelated private Stock AutoTrader endpoints made public
- sanitized errors
- rate limiting / abuse controls planned for launch

---

## 18. Accessibility and responsiveness

Minimum expectations:

- semantic landmarks
- keyboard navigation
- visible focus states
- accessible inputs/buttons
- labels / ARIA only where appropriate
- adequate colour contrast in both themes
- reduced-motion support
- responsive at mobile/tablet/desktop widths
- no critical interaction dependent only on hover

---

## 19. Performance goals

The visual design should not compromise the reason for choosing Astro.

Priorities:

1. fast first render
2. minimal JS on public pages
3. stable layout
4. optimised image/assets
5. no unnecessary framework hydration
6. lazy-load below-fold media
7. avoid giant animation bundles

Measure rather than assume.

Do not add WebGL/Three.js merely to reproduce the nebula look unless a simpler approach demonstrably cannot achieve the approved experience.

---

## 20. Testing expectations for PR1

Before opening PR1, run the repo's normal validation plus tests for the new app.

At minimum verify:

- install/workspace integrity
- build
- TypeScript/typecheck
- lint where configured
- relevant unit/integration tests
- existing Stock AutoTrader tests remain green
- auth/session behaviour
- signed-out landing
- signed-in account state
- credit display from existing backend
- desktop dark mode
- desktop light mode
- mobile dark mode
- mobile light mode
- no horizontal overflow
- `prefers-reduced-motion`

Use browser testing/screenshots at representative widths such as:

- 1440 px desktop
- 1024 px/tablet as useful
- 430 px mobile
- 390 px mobile

---

## 21. PR sequence

### PR1 — AI Web Foundation + Landing

Astro app, design system, landing, themes, responsive ads, auth/session, credit visibility, `/app` shell, CI/tests.

### PR2 — AI Analysis Experience

Ticker workflow, create analysis, progress/stages, history, report viewer, account UX, polished error/retry states.

### PR3 — Commercial Launch

Stripe, credit packs, payment webhooks, idempotency, billing history, production domain, analytics, rate limits/abuse protection, legal pages, financial/AI disclaimer, launch hardening.

---

## 22. Definition of done for PR1

PR1 is ready only when all of the following are true:

- `apps/ai-web` exists and is a real Astro 7 application
- it builds inside the existing monorepo
- the private existing app is not functionally regressed
- opening the new app clearly reflects the approved Teal & Blue Nebula design
- dark and light themes are polished
- desktop and mobile are polished
- desktop side-ad placeholders exist
- mobile top-ad placeholder exists
- account/sign-in affordance exists
- existing Better Auth is actually reused
- authenticated user state works
- existing credit balance can be surfaced securely
- no unrelated private backend data is exposed
- animation is fluid and reduced-motion compatible
- build/typecheck/tests pass
- browser smoke tests have been performed
- implementation notes are documented

The goal is not pixel-perfect duplication of the generated concept. The goal is to turn the approved direction into a credible, fast, production-quality product foundation using the real architecture of this repository.
