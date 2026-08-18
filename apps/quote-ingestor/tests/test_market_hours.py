"""Market-hours tests (America/New_York, DST-safe, mirroring the worker)."""

from __future__ import annotations

import datetime as dt
import unittest

from quote_ingestor.market_hours import in_flush_window, is_us_market_holiday


def utc(y: int, mo: int, d: int, h: int, mi: int) -> dt.datetime:
    return dt.datetime(y, mo, d, h, mi, tzinfo=dt.UTC)


class MarketHoursTest(unittest.TestCase):
    def test_regular_session_open(self) -> None:
        # 2026-08-18 (Tue) 14:00 UTC = 10:00 ET (EDT)
        self.assertTrue(in_flush_window(utc(2026, 8, 18, 14, 0)))
        # 17:55 UTC = 13:55 ET
        self.assertTrue(in_flush_window(utc(2026, 8, 18, 17, 55)))

    def test_session_open_close_boundaries(self) -> None:
        # 13:29 UTC = 09:29 ET -> closed (before open)
        self.assertFalse(in_flush_window(utc(2026, 8, 18, 13, 29)))
        # 13:30 UTC = 09:30 ET -> open
        self.assertTrue(in_flush_window(utc(2026, 8, 18, 13, 30)))
        # 19:59 UTC = 15:59 ET -> open
        self.assertTrue(in_flush_window(utc(2026, 8, 18, 19, 59)))
        # 20:00 UTC = 16:00 ET -> closed (close is exclusive)
        self.assertFalse(in_flush_window(utc(2026, 8, 18, 20, 0)))

    def test_weekend_closed(self) -> None:
        # Saturday 2026-08-15, Sunday 2026-08-16 at 10:00 ET
        self.assertFalse(in_flush_window(utc(2026, 8, 15, 14, 0)))
        self.assertFalse(in_flush_window(utc(2026, 8, 16, 14, 0)))

    def test_us_market_holiday_closed(self) -> None:
        # Observed Independence Day: Friday 2026-07-03 (EDT) — holiday.
        self.assertTrue(is_us_market_holiday(utc(2026, 7, 3, 14, 0)))
        self.assertFalse(in_flush_window(utc(2026, 7, 3, 14, 0)))
        # Memorial Day: Monday 2026-05-25
        self.assertFalse(in_flush_window(utc(2026, 5, 25, 14, 0)))
        # Christmas observed: Friday 2026-12-25
        self.assertFalse(in_flush_window(utc(2026, 12, 25, 14, 0)))

    def test_dst_safe_same_utc_hour_differs(self) -> None:
        # January (EST, UTC-5): 13:30 UTC = 08:30 ET -> closed.
        self.assertFalse(in_flush_window(utc(2026, 1, 12, 13, 30)))
        # July (EDT, UTC-4): 13:30 UTC = 09:30 ET -> open.
        self.assertTrue(in_flush_window(utc(2026, 7, 13, 13, 30)))
        # January: 14:30 UTC = 09:30 ET -> open; same UTC as July 10:30 ET.
        self.assertTrue(in_flush_window(utc(2026, 1, 12, 14, 30)))

    def test_naive_utc_input_handled(self) -> None:
        naive = dt.datetime(2026, 8, 18, 14, 0)  # assume UTC
        self.assertTrue(in_flush_window(naive))


if __name__ == "__main__":
    unittest.main()
