# Data ownership

This document defines the ownership rule for persistent and derived data. It is intentionally about responsibilities, not every column in every table.

| Domain | Canonical writer | Primary readers | Rule |
| --- | --- | --- | --- |
| Weekly price history and 200W technical metrics | `apps/history-ingestor` | Worker/API, Screener, Stock Detail | History ingestion owns provider fetches and derived technical state. UI code must not manufacture missing history. |
| Fundamentals snapshots | `apps/fundamentals-ingestor` | Worker/API, Stock Detail | The fundamentals ingestor owns provider refreshes. Failed refreshes preserve last-known-good data unless the stored value is semantically invalid. |
| Current quotes | `apps/quote-ingestor` | Worker/API, public UI | `apps/quote-ingestor` owns provider quote updates; readers do not write quote state. |
| AI analysis runs, checkpoints and results | `apps/ai-analysis-runner` plus the AI Analysis Worker/API endpoints that enqueue and transition runs | AI Analysis UI/API | The runner owns execution/result writes; the Worker/API owns request/enqueue state. Each transition must be durable and retry-safe. Credits/results must not be fabricated to make a run appear complete. |
| Intrinsic values and support levels | No canonical writer is implemented yet | Screener, Stock Detail | Writes are not allowed until an explicit ingestion job or admin entry point is implemented and named here. Consumers must not manufacture, infer, or silently replace these values. |

## Ownership rules

1. A table should have one clearly identified canonical writer for each class of record.
2. Readers may derive presentation state but must not silently repair canonical data.
3. A refresh failure must not erase a previously valid value unless a semantic invalidation rule requires it.
4. Workflow checkpoints belong to the workflow that advances them. Unrelated daily/weekly resets must not clear them.
5. Production D1 must never be edited merely to satisfy a test, checkpoint, rollout percentage, or review expectation.
6. New persistent domains must document their writer, readers, freshness semantics and invalidation behavior in this file before production writes are introduced.
7. If a domain has no canonical writer yet, state that explicitly; do not use a placeholder role description that could hide multiple writers.
