"""Tests for NY calendar + ISO-week helpers (history ingestor)."""

from __future__ import annotations

import datetime as dt
import unittest

from history_ingestor.weeks import (
    completed_bars_filter,
    is_in_progress_week,
    iso_week_of,
    iso_week_of_instant,
    ny_date_of,
    week_label,
    week_label_of_date_key,
)


class IsoWeekTests(unittest.TestCase):
    def test_iso_week_of_known_dates(self):
        # 2026-01-01 is a Thursday -> ISO 2026-W01.
        self.assertEqual(iso_week_of(dt.date(2026, 1, 1)), (2026, 1))
        # 2026-08-14 Friday -> ISO 2026-W33.
        self.assertEqual(iso_week_of(dt.date(2026, 8, 14)), (2026, 33))
        # 2026-08-10 Monday -> same week 33.
        self.assertEqual(iso_week_of(dt.date(2026, 8, 10)), (2026, 33))
        # 2026-08-17 Monday -> week 34 (Monday starts a new ISO week).
        self.assertEqual(iso_week_of(dt.date(2026, 8, 17)), (2026, 34))

    def test_iso_week_across_year_boundary(self):
        # 2026-01-01 (Thu) is 2026-W01; 2025-12-29 (Mon) is also 2026-W01.
        self.assertEqual(iso_week_of(dt.date(2025, 12, 29)), (2026, 1))
        self.assertEqual(iso_week_of(dt.date(2026, 1, 1)), (2026, 1))
        # 2027-01-01 (Fri) belongs to 2026-W53.
        self.assertEqual(iso_week_of(dt.date(2027, 1, 1)), (2026, 53))

    def test_week_label_format(self):
        self.assertEqual(week_label(dt.date(2026, 8, 14)), "2026-W33")
        self.assertEqual(week_label_of_date_key("2026-08-14"), "2026-W33")


class NyDateTests(unittest.TestCase):
    def test_ny_date_of_utc_instant(self):
        # 2026-08-14 23:30 UTC = 19:30 NY same day (EDT, UTC-4).
        instant = dt.datetime(2026, 8, 14, 23, 30, tzinfo=dt.UTC)
        self.assertEqual(ny_date_of(instant), dt.date(2026, 8, 14))
        # 2026-08-15 02:00 UTC = 22:00 NY on Aug 14 (EDT).
        instant = dt.datetime(2026, 8, 15, 2, 0, tzinfo=dt.UTC)
        self.assertEqual(ny_date_of(instant), dt.date(2026, 8, 14))
        # Winter: 2026-01-15 05:00 UTC = 00:00 NY (EST, UTC-5).
        instant = dt.datetime(2026, 1, 15, 5, 0, tzinfo=dt.UTC)
        self.assertEqual(ny_date_of(instant), dt.date(2026, 1, 15))
        instant = dt.datetime(2026, 1, 15, 4, 59, tzinfo=dt.UTC)
        self.assertEqual(ny_date_of(instant), dt.date(2026, 1, 14))

    def test_iso_week_of_instant_uses_ny(self):
        # Sunday 2026-08-16 23:30 UTC = 19:30 NY Sunday -> still week 33.
        instant = dt.datetime(2026, 8, 16, 23, 30, tzinfo=dt.UTC)
        self.assertEqual(iso_week_of_instant(instant), (2026, 33))
        # Monday 2026-08-17 00:30 UTC = Sunday 20:30 NY -> still week 33.
        instant = dt.datetime(2026, 8, 17, 0, 30, tzinfo=dt.UTC)
        self.assertEqual(iso_week_of_instant(instant), (2026, 33))
        # Monday 2026-08-17 12:00 UTC = Monday 08:00 NY -> week 34.
        instant = dt.datetime(2026, 8, 17, 12, 0, tzinfo=dt.UTC)
        self.assertEqual(iso_week_of_instant(instant), (2026, 34))


class InProgressWeekTests(unittest.TestCase):
    def _now(self, y, m, d, h=12, minute=0):
        return dt.datetime(y, m, d, h, minute, tzinfo=dt.UTC)

    def test_friday_bucket_monday_morning_is_completed(self):
        # Friday 2026-08-14 bucket, fetch Monday 2026-08-17 13:00 UTC (09:00 NY).
        self.assertFalse(is_in_progress_week("2026-08-14", self._now(2026, 8, 17, 13)))

    def test_tuesday_in_progress_bucket_is_in_progress(self):
        # AV's latest bucket during the week (e.g. Tuesday 2026-08-18) must be
        # excluded while that week is still running (Wednesday fetch).
        self.assertTrue(is_in_progress_week("2026-08-18", self._now(2026, 8, 19, 12)))

    def test_saturday_fetch_still_excludes_own_week(self):
        # Saturday is in the same ISO week as the Friday that closed it; the
        # bucket is NOT stored until the following week — deterministic rule.
        self.assertTrue(is_in_progress_week("2026-08-14", self._now(2026, 8, 15, 12)))

    def test_next_week_monday_friday_bucket_becomes_completed(self):
        self.assertFalse(is_in_progress_week("2026-08-14", self._now(2026, 8, 17, 13)))
        # Sunday night NY (Monday 00:30 UTC) still counts as week 33.
        self.assertTrue(is_in_progress_week("2026-08-14", self._now(2026, 8, 17, 0, 30)))

    def test_holiday_week_bucket(self):
        # Good Friday week bucket is Thursday 2025-04-17 (ISO 2025-W16);
        # fetch on 2025-04-18 (Friday holiday, NY) — bucket week == current
        # week -> in progress.
        self.assertTrue(is_in_progress_week("2025-04-17", self._now(2025, 4, 18, 12)))
        # Fetch the following Monday 2025-04-21 -> completed.
        self.assertFalse(is_in_progress_week("2025-04-17", self._now(2025, 4, 21, 12)))

    def test_malformed_key_not_in_progress(self):
        self.assertFalse(is_in_progress_week("not-a-date", self._now(2026, 8, 19)))

    def test_completed_bars_filter(self):
        keys = ["2026-08-14", "2026-08-18", "2026-08-07"]
        completed, in_progress = completed_bars_filter(keys, self._now(2026, 8, 19, 12))
        self.assertEqual(sorted(completed), ["2026-08-07", "2026-08-14"])
        self.assertEqual(in_progress, ["2026-08-18"])


if __name__ == "__main__":
    unittest.main()
