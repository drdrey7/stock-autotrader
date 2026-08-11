import tempfile
import unittest
from pathlib import Path

from bot.config import Settings
from bot.health import health_report
from bot.state import StateStore


class HealthReportTests(unittest.TestCase):
    def test_failed_latest_health_degrades_report(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = StateStore(Path(tmp) / "state.db")
            run_id = store.start_job("health_check")
            store.finish_job(run_id, "error", "database probe failed")
            report = health_report(Settings(bot_env="dev"), store)
            self.assertEqual(report["status"], "degraded")
            self.assertFalse(report["db_writable"])
            self.assertEqual(report["last_health_check"]["status"], "error")
            store.close()


if __name__ == "__main__":
    unittest.main()
