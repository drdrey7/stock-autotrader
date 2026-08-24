# AI agent repository instructions

All AI coding agents working in this repository must read and follow `.github/AI_ENGINEERING_RULES.md` before modifying runtime, persistence, provider, scheduling, authentication, deployment, or CI code.

## Required workflow

1. Read the relevant application README and tests before editing code.
2. Identify the real-world invariants that must remain true across retries, restarts, time boundaries, partial runs, and concurrent or scheduled execution.
3. Prefer architecture that preserves those invariants over the smallest initial patch.
4. Add or update tests that prove the invariants when applicable.
5. Run the narrowest relevant validation first, then the subsystem and full validation required by CI.
6. Review the final diff for quota accounting, persistence, idempotency, time boundaries, privilege changes, and production-data safety before committing.

Passing existing tests alone is not sufficient evidence of correctness for stateful or scheduled workflows.
