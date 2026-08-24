# Background job contracts

Background jobs are production workflows, not ordinary request handlers. Correctness must be defined across process restarts, partial runs, provider throttling, timer catch-up and calendar boundaries.

## Scheduling

- Each provider-consuming workflow must have an explicit schedule and request budget.
- When jobs share a provider quota, their priority must be encoded by schedule or an explicit defer/skip policy. `After=` alone is not a quota-priority mechanism for independently triggered timers.
- `Persistent=true` catch-up behavior must be considered when ordering jobs after downtime.
- Jobs with unrelated responsibilities should not share progress cursors solely because they are in the same application.

## Checkpoints

A checkpoint must answer:

- what work is complete;
- what work remains;
- which cycle/day the budget belongs to, when relevant;
- whether a restart can resume without repeating expensive provider work.

Partial progress should be monotonic. A new daily/weekly cycle may reset only the state that belongs to that cycle.

## Provider budgets

- Check the available budget immediately before every provider call.
- A `per UTC day` limit must be persisted if more than one process invocation can occur that day.
- Explicit CLI limits may reduce a hard safety cap but must never bypass it.
- Tests use mocks/fakes and must not consume real provider quota.

## Failure behavior

- Retryable provider failures must not corrupt durable progress.
- Successful durable writes are marked complete only after the write succeeds.
- A failed refresh should preserve last-known-good user-visible data where it remains semantically valid.
- Repeated execution must be idempotent or explicitly guarded against duplication.

## Required regression scenarios

When applicable, test:

1. partial run -> restart -> resume;
2. two invocations in the same UTC day;
3. day/week rollover;
4. provider throttle/error;
5. quota exhaustion before the next provider call;
6. persistent timer catch-up;
7. last-known-good behavior after refresh failure.
