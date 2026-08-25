# AI agent repository instructions

All AI coding agents working in this repository must read and follow `.github/AI_ENGINEERING_RULES.md` before modifying runtime, persistence, provider, scheduling, authentication, deployment, CI code, or user-facing product behavior.

## Engineering authority

The user defines product intent, not necessarily the implementation. Do not blindly follow a proposed technical solution when repository evidence shows a safer, simpler, more reliable or more maintainable architecture.

- Preserve the requested outcome, but challenge implementation details that would create fragility, duplication, unsafe state, hidden coupling, or avoidable operational cost.
- Prefer the architecture that best fits the final behavior, even when the initial implementation is slightly larger.
- The user is not expected to choose low-level frameworks, storage patterns, concurrency controls, deployment mechanics, or integration details. Resolve those decisions from the repository and its constraints.
- Ask the user only when a genuine product/business requirement is ambiguous and cannot be inferred safely. Do not push routine engineering decisions back to the user.
- If a request would break an existing invariant or architecture contract, explain the conflict briefly and implement the closest safe design that preserves the intent.

## Required workflow

1. Read the relevant application README, architecture contracts, existing implementation paths and tests before editing code.
2. Write the acceptance criteria and identify the real-world invariants that must remain true across retries, restarts, time boundaries, partial runs, concurrency, scheduled execution and the complete user-visible flow.
3. For non-trivial work, make a short plan before editing. Decompose large changes into testable steps with explicit boundaries and dependencies.
4. Prefer architecture that preserves the acceptance criteria and invariants over the smallest initial patch.
5. Add or update tests that prove the applicable invariants and failure modes.
6. For a feature spanning multiple layers, verify every required boundary: source/ingestion -> persistence -> API/service -> frontend state -> rendered UI. Do not treat one healthy layer as proof that the feature works end to end.
7. Run the narrowest relevant validation while iterating, then the subsystem/full validation required by CI once the fix batch is complete.
8. Before requesting review, inspect the complete diff against the acceptance criteria, `.github/AI_ENGINEERING_RULES.md`, and the relevant architecture contracts.
9. When a reviewer finds a bug, search the touched subsystem for equivalent occurrences and fix that class of defect as one batch rather than patching only the reported line.
10. Do not restart broad review loops after every small fix. Request one final broad review only after known findings are fixed and validation is green.
11. Review the final diff for quota accounting, concurrency, persistence, idempotency, time boundaries, privilege changes, secret exposure, production-data safety and disconnected product layers before committing.

## Definition of done for user-facing features

A feature is not complete merely because code exists or unit tests pass.

When applicable, completion requires evidence that:

- the expected source data exists or a defined empty/unavailable state is handled;
- persistence writes and reads the expected shape;
- the API/service exposes the expected value;
- frontend mapping does not silently drop, rename or invalidate it;
- loading, empty, stale and error states are intentional;
- the value/component is actually rendered in the intended desktop/mobile UI;
- a realistic integration or smoke test exercises the path that a user will use.

Passing existing tests alone is not sufficient evidence of correctness for stateful, scheduled or multi-layer user-facing workflows.
