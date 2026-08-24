# Pull request engineering checklist

Use the relevant items for changes that affect runtime, persistence, providers or infrastructure.

- [ ] Real-world invariants are stated and tested where applicable.
- [ ] Retry/restart behavior was considered.
- [ ] Daily/weekly/time-boundary behavior was considered.
- [ ] Provider calls are bounded immediately before each call.
- [ ] Persistent progress cannot be erased by an unrelated cycle reset.
- [ ] Partial runs resume safely and idempotently.
- [ ] Last-known-good data is preserved unless semantically invalid.
- [ ] No test makes real paid/provider calls.
- [ ] D1 integrity and data ownership were reviewed.
- [ ] systemd/timer catch-up and privilege impact were reviewed when applicable.
- [ ] Final diff was checked for secret exposure and production-data writes.

See `.github/AI_ENGINEERING_RULES.md` for the full contract.
