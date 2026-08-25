# Pull request engineering checklist

Use the relevant items for changes that affect runtime, persistence, providers, infrastructure or user-facing product behavior.

- [ ] Acceptance criteria and real-world invariants were defined before implementation.
- [ ] Existing architecture/ownership paths were checked before adding a new dependency, service, script, table or provider path.
- [ ] Non-trivial work was planned and decomposed into testable steps without leaving layers disconnected.
- [ ] User-facing changes were traced end to end where applicable: source/ingestion -> persistence -> API/service -> frontend mapping/state -> rendered UI.
- [ ] Loading, empty, stale and error states are intentional for changed user-facing data.
- [ ] A realistic integration/smoke test proves the actual user path when the feature spans multiple layers.
- [ ] Retry/restart behavior was considered and tested where applicable.
- [ ] Daily/weekly/time-boundary behavior was considered and tested where applicable.
- [ ] Shared provider quotas use atomic reservation immediately before each call; single-consumer hard limits are checked immediately before each call.
- [ ] Persistent progress cannot be erased by an unrelated cycle reset.
- [ ] Partial runs resume safely and idempotently.
- [ ] Last-known-good data is preserved unless semantically invalid.
- [ ] No test makes real paid/provider calls.
- [ ] D1 integrity and canonical data ownership were reviewed.
- [ ] systemd/timer catch-up, concurrency and privilege impact were reviewed when applicable.
- [ ] Reviewer findings were checked for equivalent occurrences across the touched subsystem, not only the reported line.
- [ ] Known findings were fixed as a batch and relevant validation is green before the final broad review.
- [ ] Final full diff was checked for regressions, disconnected product layers, secret exposure and production-data writes.

See `.github/AI_ENGINEERING_RULES.md` for the full contract.
