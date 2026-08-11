import tempfile
import unittest
from pathlib import Path

from bot.config import Settings
from bot.health import health_report
from bot.state import StateStore


class HealthReportTests(unittest.TestCase):
    def test_stale_success_degrades_report(self):
        from datetime import datetime, timedelta, timezone

        with tempfile.TemporaryDirectory() as tmp:
            store = StateStore(Path(tmp) / "state.db")
            run_id = store.start_job("health_check")
            store.finish_job(run_id, "ok")
            old = (datetime.now(timezone.utc) - timedelta(minutes=20)).isoformat()
            with store.tx() as conn:
                conn.execute("UPDATE job_runs SET finished_at = ? WHERE id = ?", (old, run_id))
            report = health_report(Settings(bot_env="dev"), store)
            self.assertEqual(report["status"], "degraded")
            self.assertFalse(report["db_writable"])
            store.close()


if __name__ == "__main__":
    unittest.main()
