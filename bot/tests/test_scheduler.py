import unittest

from apscheduler.triggers.cron import CronTrigger
from bot.config import Settings
from bot.scheduler import _cron, build_scheduler, next_runs
from bot.state import StateStore


class CronParsingTests(unittest.TestCase):
    def test_parses_a_five_field_cron_expression(self):
        trigger = _cron("30 7 * * mon-fri")
        self.assertIsInstance(trigger, CronTrigger)

    def test_rejects_a_field_count_other_than_five(self):
        with self.assertRaises(ValueError):
            _cron("30 7 * *")
        with self.assertRaises(ValueError):
            _cron("30 7 * * mon-fri *")

    def test_mon_fri_never_resolves_a_weekend_fire(self):
        # APScheduler day_of_week: 0=Monday..6=Sunday, so "mon-fri" (not the
        # numeric "1-5", which would mean Tue-Sat) must never fire on a
        # weekend — the same guard PR #4 B2 covers for the scheduler's own
        # cron fields via scheduler.py's _cron().
        from datetime import timedelta
        from zoneinfo import ZoneInfo

        trigger = _cron("30 7 * * mon-fri")
        now = __import__("datetime").datetime.now(ZoneInfo("America/New_York"))
        prev = None
        for _ in range(20):
            nxt = trigger.get_next_fire_time(prev, now)
            self.assertIsNotNone(nxt)
            self.assertLess(nxt.weekday(), 5, f"cron fired on weekend: {nxt}")
            prev = nxt
            now = nxt + timedelta(minutes=1)


class BuildSchedulerTests(unittest.TestCase):
    def test_registers_exactly_the_four_expected_jobs(self):
        settings = Settings()
        store = StateStore(":memory:")
        sched = build_scheduler(settings, store, blocking=False)
        try:
            job_ids = {job.id for job in sched.get_jobs()}
            self.assertEqual(
                job_ids,
                {"health_check", "pre_market_scan", "post_close_scan", "data_refresh"},
            )
        finally:
            # The scheduler was never started (matches cli.py's smoke command),
            # so shutdown() raises SchedulerNotRunningError; nothing to drain.
            try:
                sched.shutdown(wait=False)
            except Exception:
                pass
            store.close()

    def test_next_runs_reports_a_future_fire_time_for_every_job(self):
        settings = Settings()
        store = StateStore(":memory:")
        sched = build_scheduler(settings, store, blocking=False)
        try:
            runs = next_runs(sched)
            self.assertEqual(len(runs), 4)
            for run in runs:
                self.assertIsNotNone(run["next_run"], f"job {run['id']} has no next_run")
                self.assertIsNotNone(run["in"])
        finally:
            # The scheduler was never started (matches cli.py's smoke command),
            # so shutdown() raises SchedulerNotRunningError; nothing to drain.
            try:
                sched.shutdown(wait=False)
            except Exception:
                pass
            store.close()


if __name__ == "__main__":
    unittest.main()
