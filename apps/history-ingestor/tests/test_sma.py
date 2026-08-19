"""Tests for technical-metrics computation (history ingestor)."""

from __future__ import annotations

import unittest

from history_ingestor.parser import WeeklyBar
from history_ingestor.sma import compute_technical_metrics


def almost(assert_self, value, expected, places=6):
    """assertAlmostEqual that first asserts the value is not None."""
    assert_self.assertIsNotNone(value)
    assert_self.assertAlmostEqual(value, expected, places=places)


def bar(symbol, week_end_date, close):
    return WeeklyBar(
        symbol=symbol, week_end_date=week_end_date,
        open=close, high=close, low=close, close=close, volume=1000,
    )


def series(symbol, count, start_close=10.0, step=1.0):
    """``count`` ascending weekly closes: start_close, start_close+step, ..."""
    import datetime as dt
    # Anchor weeks on successive Fridays.
    base = dt.date(2026, 8, 14)
    rows = []
    for i in range(count):
        week = base - dt.timedelta(weeks=count - 1 - i)
        rows.append((bar(symbol, week.isoformat(), start_close + i * step), start_close + i * step))
    return rows


class MetricsTests(unittest.TestCase):
    def test_no_data(self):
        m = compute_technical_metrics("NBIS", [])
        self.assertEqual(m.status, "no_data")
        self.assertIsNone(m.anchor_week)
        self.assertEqual(m.completed_weeks_available, 0)
        self.assertIsNone(m.sum_199)
        self.assertIsNone(m.closed_sma_200w)

    def test_less_than_199_not_enough_history(self):
        rows = series("NBIS", 90)
        m = compute_technical_metrics("NBIS", rows)
        self.assertEqual(m.status, "not_enough_history")
        self.assertEqual(m.completed_weeks_available, 90)
        self.assertIsNone(m.sum_199)
        self.assertIsNone(m.anchor_close)
        self.assertIsNone(m.closed_sma_200w)

    def test_exactly_199_limited_but_live_basis_ok(self):
        rows = series("X", 199, start_close=100.0, step=1.0)
        m = compute_technical_metrics("X", rows)
        self.assertEqual(m.status, "limited")
        self.assertEqual(m.completed_weeks_available, 199)
        # sum_199 = 100..298 = 199 * (100 + 298) / 2 = 199 * 199 = 39601
        almost(self, m.sum_199, 39601.0)
        self.assertEqual(m.anchor_close, 298.0)
        self.assertIsNone(m.closed_sma_200w)

    def test_exactly_200_ok_with_closed_sma(self):
        rows = series("X", 200, start_close=100.0, step=1.0)
        m = compute_technical_metrics("X", rows)
        self.assertEqual(m.status, "ok")
        # 200-week closed SMA of 100..299 = (100+299)/2 = 199.5
        almost(self, m.closed_sma_200w, 199.5)
        # 199-week sum ending at anchor: 101..299 -> 199*(101+299)/2 = 39800
        almost(self, m.sum_199, 39800.0)
        self.assertEqual(m.anchor_close, 299.0)

    def test_anchor_week_is_last_row(self):
        rows = series("X", 201, start_close=10.0, step=1.0)
        m = compute_technical_metrics("X", rows)
        import datetime as dt
        self.assertEqual(m.anchor_week, (dt.date(2026, 8, 14)).isoformat())
        self.assertEqual(m.anchor_week_label, "2026-W33")
        self.assertEqual(m.completed_weeks_available, 201)

    def test_large_history_matches_known_sum(self):
        rows = series("NVDA", 1000, start_close=1.0, step=0.5)
        m = compute_technical_metrics("NVDA", rows)
        self.assertEqual(m.status, "ok")
        # last 199 closes: 401.5 .. 500.5 -> 199 * (401.5 + 500.5) / 2 = 199 * 451
        almost(self, m.sum_199, 199 * 451.0)
        # last 200 closes: 401.0 .. 500.5 -> 200 * 450.75
        almost(self, m.closed_sma_200w, 450.75)


if __name__ == "__main__":
    unittest.main()
