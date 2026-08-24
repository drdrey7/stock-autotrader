# Data ownership

This document defines the ownership rule for persistent and derived data. It is intentionally about responsibilities, not every column in every table.

| Domain | Canonical writer | Primary readers | Rule |
| --- | --- | --- | --- |
| Weekly price history and 200W technical metrics | `apps/history-ingestor` | Worker/API, Screener, Stock Detail | History ingestion owns provider fetches and derived technical state. UI code must not manufacture missing history. |
| Fundamentals snapshots | `apps/fundamentals-ingestor` | Worker/API, Stock Detail | The fundamentals ingestor owns provider refreshes. Failed refreshes preserve last-known-good data unless the stored value is semantically invalid. |
| Current quotes | quote ingestion path | Worker/API, public UI | Quote ingestion owns provider updates; readers do not write quote state. |
| AI analysis runs, checkpoints and results | AI Analysis Worker/runner flow | AI Analysis UI/API | State transitions must be durable and retry-safe. Credits/results must not be fabricated to make a run appear complete. |
| Intrinsic values and support levels | their explicit ingestion/admin method | Screener, Stock Detail | Method/source must remain explicit; consumers should not silently replace one method with another. |

## Ownership rules

1. A table should have one clearly identified canonical writer for each class of record.
2. Readers may derive presentation state but must not silently repair canonical data.
3. A refresh failure must not erase a previously valid value unless a semantic invalidation rule requires it.
4. Workflow checkpoints belong to the workflow that advances them. Unrelated daily/weekly resets must not clear them.
5. Production D1 must never be edited merely to satisfy a test, checkpoint, rollout percentage, or review expectation.
6. New persistent domains must document their writer, readers, freshness semantics and invalidation behavior in this file.
