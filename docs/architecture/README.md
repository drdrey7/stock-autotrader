# Architecture guide

This directory records cross-cutting architectural contracts that must remain stable as the repository grows.

## Documents

- `DATA_OWNERSHIP.md` — canonical ownership of persisted data and derived values.
- `BACKGROUND_JOBS.md` — scheduling, checkpoint, retry and catch-up rules for background workflows.
- `PROVIDER_BUDGETS.md` — provider quota scope, persistence, reservation and multi-process budget rules.

When a change introduces a new persistent table, background workflow, provider consumer or systemd timer, update the relevant document in the same PR.
