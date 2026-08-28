"""Static checks for the production cadence and installer inventory."""

from __future__ import annotations

import unittest
from pathlib import Path

DEPLOY = Path(__file__).resolve().parents[1] / "deploy"


def unit(name: str) -> str:
    return (DEPLOY / name).read_text(encoding="utf-8")


class SplitScheduleTests(unittest.TestCase):
    def test_sunday_full_universe_split_discovery(self):
        timer = unit("history-ingestor-reconcile-split.timer")
        service = unit("history-ingestor-reconcile-split.service")
        self.assertIn("OnCalendar=Sun *-*-* 09:00:00 UTC", timer)
        self.assertIn("Persistent=false", timer)
        self.assertIn("RECONCILE_SPLITS_MAX_REQUESTS=50", service)
        self.assertIn("reconcile-splits", service)

    def test_monday_due_split_precedes_weekly_maintenance(self):
        due_timer = unit("history-ingestor-due-split.timer")
        due_service = unit("history-ingestor-due-split.service")
        maintenance_timer = unit("history-ingestor-maintenance.timer")
        self.assertIn("OnCalendar=Mon..Sat *-*-* 06:00:00 UTC", due_timer)
        self.assertIn("RandomizedDelaySec=10m", due_timer)
        self.assertIn("OnCalendar=*-*-* 07:00:00 UTC", maintenance_timer)
        self.assertIn("Before=history-ingestor-maintenance.service", due_service)
        self.assertIn("apply-due-splits", due_service)
        # The zero-provider command still constructs the shared CLI Settings;
        # loading the secret file is configuration-only and does not authorize
        # or perform an Alpha Vantage request.
        self.assertIn("EnvironmentFile=/etc/stock-autotrader/alpha-vantage.env", due_service)

    def test_recovery_is_hourly_except_monday_maintenance_window(self):
        timer = unit("history-ingestor-split-recovery.timer")
        service = unit("history-ingestor-split-recovery.service")
        for hour in ("00", "01", "02", "03", "04", "05"):
            self.assertIn(f"OnCalendar=Tue..Sun *-*-* {hour}:30:00 UTC", timer)
            self.assertNotIn(f"OnCalendar=*-*-* {hour}:30:00 UTC", timer)
        self.assertIn("OnCalendar=*-*-* 23:30:00 UTC", timer)
        self.assertIn("OnCalendar=Tue..Sun *-*-* 06:30:00 UTC", timer)
        self.assertNotIn("OnCalendar=Mon *-*-* 06:30:00 UTC", timer)
        self.assertIn("OnCalendar=*-*-* 07:30:00 UTC", timer)
        self.assertIn("Persistent=false", timer)
        self.assertIn("SPLIT_RECOVERY_MAX_REQUESTS=2", service)
        self.assertIn("recover-split-mismatches", service)
        self.assertIn("/var/lib/history-ingestor/run.lock", service)

    def test_installer_contains_every_managed_unit_and_timer(self):
        installer = unit("install-history-ingestor-root.sh")
        expected = (
            "history-ingestor-bootstrap.service",
            "history-ingestor-bootstrap.timer",
            "history-ingestor-maintenance.service",
            "history-ingestor-maintenance.timer",
            "history-ingestor-reconcile-split.service",
            "history-ingestor-reconcile-split.timer",
            "history-ingestor-due-split.service",
            "history-ingestor-due-split.timer",
            "history-ingestor-split-recovery.service",
            "history-ingestor-split-recovery.timer",
        )
        for name in expected:
            self.assertIn(name, installer)
        self.assertIn("history-ingestor-bootstrap-maybe-disable.service", installer)

    def test_fresh_recovery_timer_is_activated_but_existing_states_are_preserved(self):
        installer = unit("install-history-ingestor-root.sh")
        self.assertIn("activate_fresh_recovery", installer)
        self.assertIn("restore_timer_states 1", installer)
        self.assertIn('"$prior_enablement" == "not-found"', installer)
        self.assertIn('desired_enablement=enabled', installer)


if __name__ == "__main__":
    unittest.main()
