import tempfile
import unittest
from pathlib import Path
from unittest import mock

from bot.alerts import send_alert
from bot.config import Settings


class AlertsTests(unittest.TestCase):
    def test_send_alert_success(self):
        s = Settings(bot_env="dev", telegram_bot_token="t", telegram_chat_id="c")
        with mock.patch("bot.alerts.requests.post") as post:
            post.return_value.__enter__ = mock.Mock(return_value=post.return_value)
            post.return_value.__exit__ = mock.Mock(return_value=False)
            post.return_value.raise_for_status = mock.Mock()
            self.assertTrue(send_alert(s, "hi"))
        post.assert_called_once()
        args, kwargs = post.call_args
        self.assertEqual(kwargs["json"]["chat_id"], "c")
        self.assertEqual(kwargs["json"]["text"], "hi")

    def test_send_alert_skipped_without_config(self):
        s = Settings(bot_env="dev", telegram_bot_token="", telegram_chat_id="")
        self.assertFalse(send_alert(s, "hi"))

    def test_send_alert_failure(self):
        import requests

        s = Settings(bot_env="dev", telegram_bot_token="t", telegram_chat_id="c")
        with mock.patch("bot.alerts.requests.post", side_effect=requests.ConnectionError("boom")):
            self.assertFalse(send_alert(s, "hi"))

    def test_alert_error_log_never_contains_token(self):
        """The raw requests exception embeds the token in the URL on connection
        failures — the log must only contain the exception type (PR #4 B3)."""
        import io
        import logging

        import requests

        token = "SECRET_TOKEN_1234567890"
        s = Settings(bot_env="dev", telegram_bot_token=token, telegram_chat_id="c")
        exc = requests.ConnectionError(
            f"HTTPSConnectionPool(host='api.telegram.org', port=443): Max retries "
            f"exceeded with url: /bot{token}/sendMessage"
        )
        stream = io.StringIO()
        handler = logging.StreamHandler(stream)
        logger = logging.getLogger("bot.alerts")
        logger.addHandler(handler)
        logger.setLevel(logging.ERROR)
        try:
            with mock.patch("bot.alerts.requests.post", side_effect=exc):
                send_alert(s, "hi")
        finally:
            logger.removeHandler(handler)
        self.assertNotIn(token, stream.getvalue())
        self.assertIn("ConnectionError", stream.getvalue())


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
