# Provider budget model

Provider quotas are production state. A request limit is only correct when its scope matches the provider contract and survives the process lifecycle that can consume it.

## Required model

For every provider consumer document:

- provider name;
- budget scope (per request, run, UTC day, billing period, etc.);
- hard limit;
- whether multiple processes or timers can consume the same budget;
- persistent counter/checkpoint when the scope outlives a process;
- priority/reserved-budget policy between competing workflows;
- throttle/circuit-breaker behavior.

## Safety rules

1. Atomically reserve budget immediately before every provider call when the quota can be shared by multiple processes, timers, or workflows. A separate non-atomic check is not sufficient.
2. For a provably single consumer, check the hard limit immediately before every provider call.
3. A CLI `--limit` may lower a hard cap but cannot raise or bypass it.
4. A run-scoped counter must not be used to implement a day-scoped guarantee.
5. Restarting a process must not reset a persisted daily budget.
6. Scheduled workflows sharing a provider must have deterministic priority or explicit deferral.
7. Tests must assert the provider mock was called no more than the allowed number of times, including a concurrent-consumer case when quotas are shared.
8. Dry-run commands must perform zero provider calls unless the command explicitly documents otherwise.

## Implementation contract

When more than one application needs the same semantics, prefer a small shared `ProviderBudget` abstraction over independent ad-hoc counters. The abstraction must separate budget policy from provider-specific HTTP behavior and provide an atomic or otherwise concurrency-safe reservation operation appropriate to the backing store. Reservation and recording semantics must make retries and provider failures explicit so capacity is never silently overspent.
