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


if __name__ == "__main__":
    unittest.main()
