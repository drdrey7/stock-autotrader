"""Health check job — the first observable runtime job."""
from __future__ import annotations

from ..state import StateStore


def health_job(store: StateStore) -> None:
    run_id = store.start_job("health_check")
    try:
        store.record_event("INFO", "health", "health check ok")
        store.finish_job(run_id, "ok")
    except Exception as exc:  # pragma: no cover - defensive
        store.finish_job(run_id, "error", str(exc))
