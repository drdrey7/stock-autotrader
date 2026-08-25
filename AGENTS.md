# AI agent repository instructions

All AI coding agents working in this repository must read and follow `.github/AI_ENGINEERING_RULES.md` before modifying runtime, persistence, provider, scheduling, authentication, deployment, or CI code.

## Required workflow

1. Read the relevant application README, architecture contracts and tests before editing code.
2. Write the acceptance criteria and identify the real-world invariants that must remain true across retries, restarts, time boundaries, partial runs, concurrency and scheduled execution.
3. Prefer architecture that preserves those invariants over the smallest initial patch.
4. Add or update tests that prove the applicable invariants.
5. Run the narrowest relevant validation while iterating, then the subsystem/full validation required by CI once the fix batch is complete.
6. Before requesting review, inspect the complete diff against the acceptance criteria, `.github/AI_ENGINEERING_RULES.md`, and the relevant architecture contracts.
7. When a reviewer finds a bug, search the touched subsystem for equivalent occurrences and fix that class of defect as one batch rather than patching only the reported line.
8. Do not restart broad review loops after every small fix. Request one final broad review only after known findings are fixed and validation is green.
9. Review the final diff for quota accounting, concurrency, persistence, idempotency, time boundaries, privilege changes, secret exposure and production-data safety before committing.

Passing existing tests alone is not sufficient evidence of correctness for stateful or scheduled workflows.
