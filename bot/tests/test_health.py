import tempfile
import unittest
from datetime import UTC, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

from bot.config import Settings
from bot.health import _health_interval_seconds, _missed_health_check, health_report
from bot.state import StateStore


class HealthReportTests(unittest.TestCase):
    def test_stale_success_degrades_report(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = StateStore(Path(tmp) / "state.db")
            run_id = store.start_job("health_check")
            store.finish_job(run_id, "ok")
            old = (datetime.now(UTC) - timedelta(minutes=20)).isoformat()
            with store.tx() as conn:
                conn.execute("UPDATE job_runs SET finished_at = ? WHERE id = ?", (old, run_id))
            report = health_report(Settings(bot_env="dev"), store)
            self.assertEqual(report["status"], "degraded")
            self.assertFalse(report["db_writable"])
            store.close()

    def test_wildcard_health_cron_has_short_expiry(self):
        settings = Settings(bot_env="dev", health_check_cron="* * * * *")
        self.assertEqual(_health_interval_seconds(settings), 120)

    def test_missed_weekday_health_degrades(self):
        """missed-fire detection, not fixed-interval heuristic (57fc9c5 block)."""
        settings = Settings(
            bot_env="dev", health_check_cron="0 9 * * mon-fri", timezone="America/New_York"
        )
        last_success = datetime(2026, 8, 11, 9, 0, 0, tzinfo=ZoneInfo("America/New_York"))
        now = datetime(2026, 8, 13, 10, 0, 0, tzinfo=ZoneInfo("America/New_York"))
        try:
            # Monkey-patch datetime.now for the missed check logic
            import bot.health as health_mod
            orig = health_mod.datetime
            class FakeDateTime(datetime):
                @classmethod
                def now(cls, tz=None):
                    if tz is not None and str(tz) == "America/New_York":
                        return now
                    return orig.now(tz)
            health_mod.datetime = FakeDateTime
            self.assertTrue(_missed_health_check(settings, last_success))
        finally:
            import bot.health as health_mod
            health_mod.datetime = datetime

    def test_frequent_schedule_healthy(self):
        settings = Settings(bot_env="dev", health_check_cron="*/5 * * * *", timezone="America/New_York")
        now = datetime(2026, 8, 11, 9, 12, 0, tzinfo=ZoneInfo("America/New_York"))
        recent = now - timedelta(minutes=2)
        self.assertFalse(_missed_health_check(settings, recent, now=now),
                         "2 min ago should still be healthy for */5 cadence")


if __name__ == "__main__":
    unittest.main()
