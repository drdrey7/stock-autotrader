"""Market-hours tests (America/New_York, DST-safe, mirroring the worker)."""

from __future__ import annotations

import datetime as dt
import unittest

from quote_ingestor.market_hours import (
    accept_regular_trade,
    in_flush_window,
    is_us_market_holiday,
    market_phase,
    previous_trading_session_date,
    session_close_minutes,
    trading_session_date,
)


def utc(y: int, mo: int, d: int, h: int, mi: int, s: int = 0) -> dt.datetime:
    return dt.datetime(y, mo, d, h, mi, s, tzinfo=dt.UTC)


class MarketHoursTest(unittest.TestCase):
    def test_regular_session_open(self) -> None:
        # 2026-08-18 (Tue) 14:00 UTC = 10:00 ET (EDT)
        self.assertTrue(in_flush_window(utc(2026, 8, 18, 14, 0)))
        # 17:55 UTC = 13:55 ET
        self.assertTrue(in_flush_window(utc(2026, 8, 18, 17, 55)))

    def test_open_boundaries_and_close_grace(self) -> None:
        # 13:29 UTC = 09:29 ET -> closed (before open)
        self.assertFalse(in_flush_window(utc(2026, 8, 18, 13, 29)))
        # 13:30 UTC = 09:30 ET -> open
        self.assertTrue(in_flush_window(utc(2026, 8, 18, 13, 30)))
        # 19:59 UTC = 15:59 ET -> open
        self.assertTrue(in_flush_window(utc(2026, 8, 18, 19, 59)))
        # 20:00 UTC = 16:00 ET -> POST-CLOSE GRACE still allows flushes
        # (closing auction / last regular ticks land in a final flush).
        self.assertTrue(in_flush_window(utc(2026, 8, 18, 20, 0)))
        self.assertTrue(in_flush_window(utc(2026, 8, 18, 20, 4, 59)))
        # 20:05:00 ET+ = grace elapsed -> closed
        self.assertFalse(in_flush_window(utc(2026, 8, 18, 20, 5, 0)))
        self.assertFalse(in_flush_window(utc(2026, 8, 18, 21, 0)))

    def test_market_phase(self) -> None:
        self.assertEqual(market_phase(utc(2026, 8, 18, 12, 0)), "pre_open")
        self.assertEqual(market_phase(utc(2026, 8, 18, 14, 0)), "open")
        self.assertEqual(market_phase(utc(2026, 8, 18, 20, 0)), "grace")
        self.assertEqual(market_phase(utc(2026, 8, 18, 20, 6, 0)), "closed")
        self.assertEqual(market_phase(utc(2026, 8, 16, 14, 0)), "closed")  # Saturday

    def test_weekend_closed(self) -> None:
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

    def test_early_close_black_friday(self) -> None:
        # Black Friday 2026-11-27: session closes 13:00 ET (18:00 UTC).
        day = dt.date(2026, 11, 27)
        self.assertEqual(session_close_minutes(day), 13 * 60)
        # 12:59 ET (17:59 UTC) -> in session
        self.assertTrue(in_flush_window(utc(2026, 11, 27, 17, 59)))
        # 13:01 ET (18:01 UTC) -> within the grace window
        self.assertTrue(in_flush_window(utc(2026, 11, 27, 18, 1)))
        # 13:06 ET (18:06 UTC) -> closed
        self.assertFalse(in_flush_window(utc(2026, 11, 27, 18, 6)))

    def test_early_close_christmas_eve(self) -> None:
        # Christmas Eve 2026-12-24 (Thursday): early close 13:00 ET (18:00 UTC).
        self.assertEqual(session_close_minutes(dt.date(2026, 12, 24)), 13 * 60)
        self.assertFalse(in_flush_window(utc(2026, 12, 24, 18, 6)))
        self.assertTrue(in_flush_window(utc(2026, 12, 24, 18, 2)))

    def test_early_close_july_3_mirrors_worker(self) -> None:
        # 2029-07-04 is a Wednesday -> 2029-07-03 (Tue) is an early close.
        self.assertEqual(session_close_minutes(dt.date(2029, 7, 3)), 13 * 60)
        # 2026-07-04 is a Saturday -> July 3 is the observed holiday (no session).
        self.assertEqual(session_close_minutes(dt.date(2026, 7, 3)), 16 * 60)

    def test_normal_day_close_16_00(self) -> None:
        self.assertEqual(session_close_minutes(dt.date(2026, 8, 18)), 16 * 60)

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

    def test_trading_session_date_uses_new_york_calendar(self) -> None:
        self.assertEqual(
            trading_session_date(utc(2026, 8, 27, 14, 0)),
            dt.date(2026, 8, 27),
        )
        self.assertIsNone(trading_session_date(utc(2026, 8, 29, 14, 0)))

    def test_previous_trading_session_skips_weekend(self) -> None:
        self.assertEqual(previous_trading_session_date(dt.date(2026, 8, 31)), dt.date(2026, 8, 28))

    def test_previous_trading_session_skips_market_holiday(self) -> None:
        # Tuesday after US Labor Day 2026 rolls back to the prior Friday.
        self.assertEqual(previous_trading_session_date(dt.date(2026, 9, 8)), dt.date(2026, 9, 4))

    # ------------------------------------------------------------- (P2 #4)

    def test_accept_regular_trade_normal_day(self) -> None:
        # Trade at 15:59:59 ET received at 16:00:03 (still in grace) -> accept.
        self.assertTrue(accept_regular_trade(
            trade_ts=utc(2026, 8, 18, 19, 59, 59),
            now=utc(2026, 8, 18, 20, 0, 3),
        ))
        # Trade timestamp 16:01 ET -> after-hours, must NOT contaminate regular.
        self.assertFalse(accept_regular_trade(
            trade_ts=utc(2026, 8, 18, 20, 1, 0),
            now=utc(2026, 8, 18, 20, 2, 0),
        ))
        # Pre-open trade in a live session -> not regular.
        self.assertFalse(accept_regular_trade(
            trade_ts=utc(2026, 8, 18, 13, 0, 0),  # 09:00 ET
            now=utc(2026, 8, 18, 14, 0, 0),
        ))
        # Mid-session trade -> accepted.
        self.assertTrue(accept_regular_trade(
            trade_ts=utc(2026, 8, 18, 15, 0, 0),
            now=utc(2026, 8, 18, 15, 0, 5),
        ))
        # Arrival after the grace window elapsed -> intake closed even for a
        # timestamp that was technically regular (5-minute tolerance over).
        self.assertFalse(accept_regular_trade(
            trade_ts=utc(2026, 8, 18, 19, 50, 0),
            now=utc(2026, 8, 18, 20, 20, 0),
        ))

    def test_accept_regular_trade_early_close(self) -> None:
        # Black Friday: close is 13:00 ET. A trade at 12:59 ET -> accepted...
        self.assertTrue(accept_regular_trade(
            trade_ts=utc(2026, 11, 27, 17, 59, 59),
            now=utc(2026, 11, 27, 18, 3, 0),  # grace window (13:03 ET)
        ))
        # ...but a 13:30 ET after-hours tick -> rejected for the regular close.
        self.assertFalse(accept_regular_trade(
            trade_ts=utc(2026, 11, 27, 18, 30, 0),
            now=utc(2026, 11, 27, 19, 0, 0),
        ))
        # A 13:30 ET tick arriving BEFORE the close (skewed server) is still
        # outside the session bounds -> rejected.
        self.assertFalse(accept_regular_trade(
            trade_ts=utc(2026, 11, 27, 18, 30, 0),
            now=utc(2026, 11, 27, 17, 30, 0),  # 12:30 ET
        ))

    def test_accept_regular_trade_closed_market(self) -> None:
        self.assertFalse(accept_regular_trade(
            trade_ts=utc(2026, 8, 18, 19, 0, 0),
            now=utc(2026, 8, 18, 21, 0, 0),  # 17:00 ET: far outside
        ))
        self.assertFalse(accept_regular_trade(
            trade_ts=utc(2026, 8, 18, 15, 0, 0),
            now=utc(2026, 8, 16, 14, 0, 0),  # different day (Saturday)
        ))


if __name__ == "__main__":
    unittest.main()
