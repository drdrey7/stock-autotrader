import tempfile
import unittest
from pathlib import Path

from bot.alerts import format_alert, runtime_start_message
from bot.config import Settings
from bot.state import StateStore


class AlertsTests(unittest.TestCase):
    def test_format_alert_includes_env_and_text(self):
        s = Settings(bot_env="dev")
        msg = format_alert(s, "runtime started")
        self.assertIn("stock-autotrader", msg)
        self.assertIn("[dev]", msg)
        self.assertIn("runtime started", msg)

    def test_format_alert_never_contains_secrets(self):
        s = Settings(bot_env="production", ingest_secret="super-secret-value")
        msg = runtime_start_message(s)
        self.assertNotIn("super-secret-value", msg)
        self.assertNotIn("secret", msg.lower())

    def test_alert_prints_to_stdout_for_hermes_delivery(self):
        """Delivery contract: `python -m bot alert` prints the line to stdout;
        a Hermes cron (profile default) delivers it to Telegram."""
        import contextlib
        import io
        import os
        import tempfile as _tmp

        from bot import cli

        with _tmp.TemporaryDirectory() as tmp:
            old = os.environ.get("DATA_DIR")
            os.environ["DATA_DIR"] = str(Path(tmp) / "data")
            buf = io.StringIO()
            try:
                with contextlib.redirect_stdout(buf):
                    code = cli.main(["alert", "engine degraded"])
            finally:
                if old is None:
                    os.environ.pop("DATA_DIR", None)
                else:
                    os.environ["DATA_DIR"] = old
        self.assertEqual(code, 0)
        self.assertIn("engine degraded", buf.getvalue())


class SchedulerTests(unittest.TestCase):
    def test_build_registers_jobs(self):
        from bot.scheduler import build_scheduler, next_runs

        with tempfile.TemporaryDirectory() as tmp:
            from bot.state import StateStore

            store = StateStore(Path(tmp) / "state.db")
            sched = build_scheduler(Settings(bot_env="dev"), store, blocking=False)
            jobs = sched.get_jobs()
            ids = {j.id for j in jobs}
            self.assertIn("health_check", ids)
            self.assertIn("pre_market_scan", ids)
            self.assertIn("post_close_scan", ids)
            self.assertIn("data_refresh", ids)
            runs = next_runs(sched)
            self.assertEqual(len(runs), len(jobs))
            for r in runs:
                self.assertIn("next_run", r)
            try:
                sched.shutdown(wait=False)
            except Exception:
                pass
            store.close()

    def test_scheduler_uses_configured_timezone(self):
        from bot.scheduler import build_scheduler

        with tempfile.TemporaryDirectory() as tmp:
            store = StateStore(Path(tmp) / "state.db")
            settings = Settings(bot_env="dev", timezone="Europe/Zurich")
            sched = build_scheduler(settings, store, blocking=False)
            by_id = {job.id: job for job in sched.get_jobs()}
            for job_id in ("pre_market_scan", "post_close_scan", "data_refresh", "health_check"):
                self.assertEqual(str(by_id[job_id].trigger.timezone), "Europe/Zurich")
            try:
                sched.shutdown(wait=False)
            except Exception:
                pass
            store.close()

    def test_bad_cron_rejected(self):
        from bot.scheduler import _cron

        with self.assertRaises(ValueError):
            _cron("not-a-cron")

    def test_weekday_cron_never_fires_on_weekend(self):
        """APScheduler day_of_week: 0=Monday..6=Sunday. 'mon-fri' must never
        fire on Sat/Sun (numeric '1-5' would mean Tue-Sat — PR #4 B2)."""
        from datetime import timedelta
        from zoneinfo import ZoneInfo

        from bot.scheduler import _cron

        trigger = _cron("30 7 * * mon-fri")
        now = __import__("datetime").datetime.now(ZoneInfo("America/New_York"))
        tz = ZoneInfo("America/New_York")
        fires = []
        prev = None
        for _ in range(20):
            nxt = trigger.get_next_fire_time(prev, now)
            self.assertIsNotNone(nxt)
            assert nxt is not None
            fires.append(nxt)
            prev = nxt
            now = nxt + timedelta(minutes=1)
        for f in fires:
            self.assertLess(f.weekday(), 5, f"cron fired on weekend: {f}")


if __name__ == "__main__":
    unittest.main()
