# AI engineering rules

These rules are mandatory for AI-generated changes that affect persistent state, provider APIs, quotas, retries, timers, background jobs, authentication, deployment, or production infrastructure.

## 1. Define invariants before implementation

Write down the real-world property, not only the local function behavior. Examples:

- A limit described as `per day` must survive process restarts and multiple invocations in the same UTC day.
- Partial work must resume from the first unfinished item after restart.
- A weekly reset must not erase unrelated workflow progress.
- Re-running an idempotent task must not duplicate or corrupt D1 state.

## 2. Quotas and provider calls

- Check hard limits immediately before every provider call.
- Limits must apply across the intended scope, including restarts and multiple processes.
- Persist budget state when the requirement spans more than one process lifetime.
- Provider-consuming scheduled jobs must have explicit budgets or a documented reserved-budget policy.
- Tests must not make real paid/provider calls.
- Preserve existing pacing, throttling and circuit breakers unless the change explicitly replaces them.

## 3. Persistent workflow state

- Progress must survive crash, restart and schedule boundaries.
- Separate workflows should have separate checkpoints unless shared state is intentionally part of the design.
- Daily or weekly cycle resets must never erase unrelated workflow state.
- Mark durable success only after the durable write succeeds.
- Do not modify production D1 to make a test or rollout appear complete.

## 4. Timers and background execution

- Verify actual scheduling and catch-up behavior, including `Persistent=true`.
- Do not rely on `After=` alone to establish priority between independently triggered timers.
- Shared provider consumers must have an explicit ordering or defer/skip policy.
- Validate systemd units and shell installers when they change.

## 5. Idempotency and retries

- Re-running a completed operation must be safe.
- A partial run must make monotonic progress unless an explicit reset begins a new cycle.
- Retry paths must not silently reset quota, progress or ownership state.
- Failure after a partial durable write must leave a recoverable state.

## 6. Time and freshness

- Production code with freshness, TTL, expiry or schedule logic should accept an explicit clock/time input when practical.
- Tests must not depend on hard-coded dates that eventually expire relative to wall-clock time.
- Test UTC day rollover, week rollover and relevant boundary conditions.

## 7. Last-known-good data

- Do not erase a previously valid user-visible value solely because a refresh failed, unless the old value is now semantically invalid.
- Never fabricate data to fill a gap.
- Preserve explicit invalidation states such as scale/schema mismatches.

## 8. Mandatory tests when applicable

Add regression coverage for the relevant subset of:

- run -> restart -> run again;
- two runs in the same UTC day;
- day/week rollover;
- partial -> resume;
- provider throttle/error;
- quota exhausted before or during an item;
- persistent catch-up ordering;
- stale last-known-good behavior;
- idempotent retry.

## 9. Final diff review

Before commit, explicitly review the final diff for:

- quota accounting;
- restart safety;
- retry safety;
- daily/weekly boundary behavior;
- persistent-state ownership;
- timer ordering and catch-up;
- D1 integrity;
- production privilege/systemd impact;
- secret exposure.

P0/P1 findings and any issue that can corrupt production state, exhaust provider quota unexpectedly, stop production services, or escalate privileges are merge blockers.

Passing existing tests alone is not sufficient evidence of correctness for stateful or scheduled workflows.
