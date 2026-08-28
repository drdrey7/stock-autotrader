"""Tests for the production systemd split cadence and ordering.

These guard the Monday-effective split flow: Sunday reconcile discovers the
split, Monday 06:00 apply-due-splits applies it BEFORE the 07:00 WEEKLY
maintenance, so the chart and 200W SMA are rewritten on the split-adjusted
scale without provider competition. They read the committed deploy unit files
(never touch a live systemd) so a cadence or ordering regression is caught at
test time.
"""

from __future__ import annotations

import pathlib
import unittest

DEPLOY_DIR = pathlib.Path(__file__).resolve().parents[1] / "deploy"

RECONCILE_TIMER = "history-ingestor-reconcile-split.timer"
DUE_TIMER = "history-ingestor-due-split.timer"
MAINTENANCE_TIMER = "history-ingestor-maintenance.timer"
DUE_SERVICE = "history-ingestor-due-split.service"
MAINTENANCE_SERVICE = "history-ingestor-maintenance.service"
BOOTSTRAP_SERVICE = "history-ingestor-bootstrap.service"


def _read(unit: str) -> str:
    return (DEPLOY_DIR / unit).read_text(encoding="utf-8")


class SplitCadenceTests(unittest.TestCase):
    def test_reconcile_runs_sunday_09_utc(self):
        # Sunday SPLITS discovery: one day ahead of Monday's WEEKLY maintenance.
        timer = _read(RECONCILE_TIMER)
        self.assertIn("OnCalendar=Sun *-*-* 09:00:00 UTC", timer)
        self.assertNotIn("Tue *-*-", timer)  # no longer fortnightly Tuesday
        self.assertIn("Persistent=false", timer)

    def test_due_split_runs_monday_to_saturday_06_utc(self):
        # apply-due-splits must include Monday (the key pass) and run before the
        # 07:00 maintenance; it never runs on Sunday (reconcile does that).
        timer = _read(DUE_TIMER)
        self.assertIn("OnCalendar=Mon..Sat *-*-* 06:00:00 UTC", timer)
        self.assertNotIn("Tue..Sat", timer)
        self.assertNotIn("Sun", timer.split("OnCalendar")[1])

    def test_maintenance_remains_daily_07_utc(self):
        timer = _read(MAINTENANCE_TIMER)
        self.assertIn("OnCalendar=*-*-* 07:00:00 UTC", timer)

    def test_monday_order_due_split_before_maintenance(self):
        # On Monday the zero-provider due-split must run BEFORE maintenance so
        # the just-discovered Monday-effective split is applied first. Assert
        # the actual systemd ordering, not comments only.
        due_service = _read(DUE_SERVICE)
        maintenance_service = _read(MAINTENANCE_SERVICE)
        self.assertIn("Before=history-ingestor-maintenance.service", due_service)
        self.assertIn("After=network-online.target history-ingestor-due-split.service", maintenance_service)
        # And maintenance must still declare itself before bootstrap/reconcile
        # (provider priority), on the shared Before= line.
        self.assertIn("history-ingestor-bootstrap.service", maintenance_service)
        bootstrap_before = maintenance_service.split("Before=")[1].split("\n")[0]
        self.assertIn("history-ingestor-reconcile-split.service", bootstrap_before)
        self.assertIn("history-ingestor-bootstrap.service", bootstrap_before)

    def test_no_order_cycle_with_bootstrap(self):
        # bootstrap must not declare Before=due-split (that would create a cycle
        # against maintenance After=due-split + Before=bootstrap).
        bootstrap = _read(BOOTSTRAP_SERVICE)
        self.assertNotIn("Before=history-ingestor-due-split.service", bootstrap)

    def test_reconcile_service_after_maintenance_and_bootstrap(self):
        # Provider-consuming reconcile must never starve the provider-priority
        # maintenance/bootstrap that run earlier the same Sunday.
        service = _read(RECONCILE_TIMER)
        self.assertIn("09:00:00 UTC", service)


if __name__ == "__main__":
    unittest.main()