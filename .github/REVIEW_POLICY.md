# Repository review policy

Review findings use the following priority contract:

- **P0/P1** are blockers. They must be resolved before merge and must not be
  converted into non-blocking follow-up Issues by automation.
- **P2/P3** may be intentionally deferred when the trade-off is understood and
  accepted. An accepted unresolved P2/P3 finding must be preserved as a GitHub
  Issue after the PR merges so it cannot be lost.

For AI-generated changes that affect persistence, quotas, provider APIs, retries,
timers, background jobs, authentication, deployment, or production infrastructure,
reviewers must also verify the invariants in `.github/AI_ENGINEERING_RULES.md`.
Passing the existing test suite alone is not sufficient evidence that a stateful
or scheduled workflow is safe to merge.

To mark a review thread for deferred follow-up, add a reply containing one
standalone marker on its own line:

```text
[deferred]
```

`[accepted]`, `Accepted: deferred`, and `Deferred: accepted` are also accepted
machine-readable forms. The original/root review comment must contain `P2` or
`P3`; a root comment containing any `P0` or `P1` is always excluded.

For useful follow-up Issues, include an `Impact: ...` line in the finding. The
workflow copies the complete finding, impact, PR number, stable review-thread
identifier and source comment link into the Issue. It deduplicates with a
marker based on the GitHub review-thread ID (and records the root comment ID).

`.github/workflows/deferred-review-issues.yml` runs on the trusted
`pull_request_target` event after a merged PR. It reads GitHub review data using
the API, does not check out the PR or run repository code, creates or reuses
Issues for accepted/deferred P2/P3 threads, and updates one merged-PR comment
with the follow-up Issue links. When no deferred findings exist, it creates no
Issue and posts no comment.
