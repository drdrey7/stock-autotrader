"""Internal state: SQLite-backed runtime ledger.

Keeps the engine's own state (job runs, runtime events, last outcomes)
local to the VPS. Not a replacement for D1 — D1 is the public read model.
"""
from __future__ import annotations

import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path

_SCHEMA = """
CREATE TABLE IF NOT EXISTS runtime_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  level TEXT NOT NULL,
  source TEXT NOT NULL,
  message TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runtime_events_ts ON runtime_events(ts);

CREATE TABLE IF NOT EXISTS job_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_name TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  detail TEXT,
  UNIQUE(job_name, started_at)
);
"""


class StateStore:
    """Thin SQLite wrapper for the runtime ledger."""

    def __init__(self, db_path: Path | str):
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        # Scheduler jobs run on APScheduler worker threads -> same-thread binding
        # would crash every job. Single-process runtime makes this safe.
        self._conn = sqlite3.connect(self.db_path, check_same_thread=False)
        self._lock = threading.RLock()
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA busy_timeout=5000")
        self._conn.executescript(_SCHEMA)
        self._conn.commit()

    @contextmanager
    def tx(self):
        with self._lock:
            try:
                yield self._conn
                self._conn.commit()
            except Exception:
                self._conn.rollback()
                raise

    def record_event(self, level: str, source: str, message: str) -> None:
        import datetime as _dt

        ts = _dt.datetime.now(_dt.timezone.utc).isoformat()
        with self.tx() as conn:
            conn.execute(
                "INSERT INTO runtime_events (ts, level, source, message) VALUES (?, ?, ?, ?)",
                (ts, level, source, message),
            )

    def start_job(self, job_name: str) -> int:
        import datetime as _dt

        ts = _dt.datetime.now(_dt.timezone.utc).isoformat()
        with self.tx() as conn:
            cur = conn.execute(
                "INSERT INTO job_runs (job_name, started_at) VALUES (?, ?)",
                (job_name, ts),
            )
            return int(cur.lastrowid or 0)

    def finish_job(self, run_id: int, status: str, detail: str | None = None) -> None:
        import datetime as _dt

        ts = _dt.datetime.now(_dt.timezone.utc).isoformat()
        with self.tx() as conn:
            conn.execute(
                "UPDATE job_runs SET finished_at = ?, status = ?, detail = ? WHERE id = ?",
                (ts, status, detail, run_id),
            )

    def last_job_status(self, job_name: str) -> dict | None:
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM job_runs WHERE job_name = ? ORDER BY id DESC LIMIT 1",
                (job_name,),
            ).fetchone()
        return dict(row) if row else None

    def last_finished_job_status(self, job_name: str) -> dict | None:
        """Most recent completed run; the in-flight run is skipped."""
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM job_runs WHERE job_name = ? AND finished_at IS NOT NULL ORDER BY id DESC LIMIT 1",
                (job_name,),
            ).fetchone()
        return dict(row) if row else None

    def recent_events(self, limit: int = 20) -> list[dict]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM runtime_events ORDER BY id DESC LIMIT ?",
                (limit,),
            ).fetchall()
        return [dict(r) for r in rows]

    def close(self) -> None:
        with self._lock:
            self._conn.close()
