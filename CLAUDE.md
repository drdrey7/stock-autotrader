@AGENTS.md

# Claude Code project instructions

Claude Code must follow the repository contract imported above.

## Working mode

- For any non-trivial change, inspect the relevant code and write a short implementation plan before editing.
- Do not blindly implement the user's proposed technical solution. Preserve the product intent, but if the proposed architecture is fragile, unsafe, duplicates an existing path, or conflicts with repository contracts, choose the safer maintainable architecture and explain the reason briefly.
- The user is not expected to make low-level engineering decisions. Resolve implementation details from the repository, tests, architecture contracts and production constraints. Ask only when a genuine product/business requirement is ambiguous and cannot be inferred safely.
- Decompose large work into testable vertical steps, but keep one coherent feature goal and integration path. Do not leave intermediate layers disconnected.
- Before declaring a user-facing feature complete, prove the full path from source/ingestion through persistence/API to the rendered UI when those layers are involved.
- Run the relevant tests, lint/type checks and integration/smoke validation before reporting completion.
- Self-review the complete diff once the implementation and validations are complete, then fix findings as a batch before requesting another broad review.
