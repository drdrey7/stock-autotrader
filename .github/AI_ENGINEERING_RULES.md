# AI engineering rules

These rules are mandatory for AI-generated changes that affect runtime behavior, user-facing product behavior, persistent state, provider APIs, quotas, retries, timers, background jobs, authentication, deployment or production infrastructure.

## 1. Define invariants and acceptance criteria before implementation

Write down the real-world property, not only the local function behavior. Define the acceptance criteria that will prove the change complete before editing code. Examples:

- A limit described as `per day` must survive process restarts and multiple invocations in the same UTC day.
- Partial work must resume from the first unfinished item after restart.
- A weekly reset must not erase unrelated workflow progress.
- Re-running an idempotent task must not duplicate or corrupt D1 state.
- A user-visible metric is not complete until its source, persistence/API mapping and rendered UI are connected and validated.

Implementation is not complete until the applicable invariants are covered by tests or another explicit validation method.

## 2. Architecture before patching

- Preserve the requested product outcome, but do not blindly implement a proposed technical approach when it conflicts with repository evidence or creates unnecessary fragility.
- Prefer the architecture that best matches the intended final behavior, even when its initial implementation is slightly larger.
- Reuse established ingestion, persistence, API, UI and deployment patterns before introducing parallel paths.
- Do not create a new dependency, service, script, table, provider path or state owner without first checking whether an existing component already owns that responsibility.
- For non-trivial work, define a short implementation plan and dependency order before editing.
- Large features should be decomposed into independently testable steps while preserving one explicit end-to-end integration path.

## 3. Product completeness and integration

For changes that affect the public product, verify the complete path that the user depends on. Where applicable trace:

`source/provider -> ingestion/job -> D1/persistence -> API/service -> frontend mapping/state -> rendered UI`

A healthy backend does not prove the feature works in the site, and a rendered placeholder does not prove real data reaches the UI.

Before declaring a user-facing feature complete, verify the applicable subset of:

- source data exists or a deliberate unavailable/empty state is defined;
- persisted schema and values match consumer expectations;
- API/service serialization preserves the field, units and nullability;
- frontend parsing/mapping does not silently drop, rename, rescale or invalidate it;
- loading, stale, empty and error states are intentional;
- desktop/mobile rendering shows the feature in the intended location;
- a realistic integration/smoke test exercises the actual user path.

When a feature disappears despite backend data being healthy, treat that as an end-to-end regression and add coverage at the boundary that failed.

## 4. Quotas and provider calls

- Atomically reserve budget immediately before every provider call whenever more than one process, timer, or workflow can share the quota. A separate non-atomic check is not sufficient for shared budgets.
- Single-consumer limits must still be checked immediately before every provider call.
- Limits must apply across the intended scope, including restarts and multiple processes.
- Persist budget state when the requirement spans more than one process lifetime.
- Provider-consuming scheduled jobs must have explicit budgets or a documented reserved-budget policy.
- Tests must not make real paid/provider calls.
- Preserve existing pacing, throttling and circuit breakers unless the change explicitly replaces them.

## 5. Persistent workflow state

- Progress must survive crash, restart and schedule boundaries.
- Separate workflows should have separate checkpoints unless shared state is intentionally part of the design.
- Daily or weekly cycle resets must never erase unrelated workflow state.
- Mark durable success only after the durable write succeeds.
- Do not modify production D1 to make a test or rollout appear complete.

## 6. Timers and background execution

- Verify actual scheduling and catch-up behavior, including `Persistent=true`.
- Do not rely on `After=` alone to establish priority between independently triggered timers.
- Shared provider consumers must have an explicit ordering or defer/skip policy.
- Validate systemd units and shell installers when they change.

## 7. Idempotency and retries

- Re-running a completed operation must be safe.
- A partial run must make monotonic progress unless an explicit reset begins a new cycle.
- Retry paths must not silently reset quota, progress or ownership state.
- Failure after a partial durable write must leave a recoverable state.

## 8. Time and freshness

- Production code with freshness, TTL, expiry or schedule logic should accept an explicit clock/time input when practical.
- Tests must not depend on hard-coded dates that eventually expire relative to wall-clock time.
- Test UTC day rollover, week rollover and relevant boundary conditions.

## 9. Last-known-good data

- Do not erase a previously valid user-visible value solely because a refresh failed, unless the old value is now semantically invalid.
- Never fabricate data to fill a gap.
- Preserve explicit invalidation states such as scale/schema mismatches.

## 10. Mandatory tests when applicable

Add regression coverage for the relevant subset of:

- run -> restart -> run again;
- two runs in the same UTC day;
- concurrent consumers of one shared quota;
- day/week rollover;
- partial -> resume;
- provider throttle/error;
- quota exhausted before or during an item;
- persistent catch-up ordering;
- stale last-known-good behavior;
- idempotent retry;
- persistence/API contract mismatch;
- API/frontend contract mismatch;
- expected user-visible value missing from the rendered page.

## 11. Review convergence

The goal is to find classes of defects before opening or updating the PR, not one finding per review cycle.

- Before the first review, perform a self-review against the acceptance criteria, this file, the relevant architecture contracts, and the complete diff.
- Fix related findings as one batch, including equivalent occurrences in adjacent code, tests, docs and configuration.
- After a review finding, search for the same bug pattern across the touched subsystem instead of fixing only the reported line.
- Run narrow validation while iterating, then one subsystem/full validation after the batch is complete.
- Do not restart broad review loops after every small patch. Request one final broad review only after the known findings are fixed and validation is green.
- A final broad review should inspect the whole diff for new regressions introduced by the fixes.

## 12. Final diff review

Before commit, explicitly review the final diff for:

- acceptance criteria and end-to-end product completeness;
- disconnected source/persistence/API/UI layers;
- quota accounting and concurrency safety;
- restart safety;
- retry safety;
- daily/weekly boundary behavior;
- persistent-state ownership;
- timer ordering and catch-up;
- D1 integrity;
- production privilege/systemd impact;
- secret exposure.

P0/P1 findings and any issue that can corrupt production state, unexpectedly exhaust provider quota, stop production services, escalate privileges, or leave a promised user-facing feature silently disconnected are merge blockers.

Passing existing tests alone is not sufficient evidence of correctness for stateful, scheduled or multi-layer user-facing workflows.
