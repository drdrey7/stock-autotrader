"""Tests for split-only cumulative adjustment (history ingestor)."""

from __future__ import annotations

import unittest
from fractions import Fraction

from history_ingestor.parser import SplitEvent, WeeklyBar
from history_ingestor.splits import adjust_series, cumulative_split_factor


def bar(symbol, week_end_date, close, open_=100.0, high=101.0, low=99.0, volume=1000):
    return WeeklyBar(
        symbol=symbol, week_end_date=week_end_date,
        open=open_, high=high, low=low, close=close, volume=volume,
    )


def split(symbol, date_key, ratio):
    return SplitEvent(symbol=symbol, effective_date=date_key, ratio=Fraction(ratio))


class CumulativeFactorTests(unittest.TestCase):
    def test_no_splits_factor_one(self):
        self.assertEqual(cumulative_split_factor("2026-08-14", []), Fraction(1, 1))

    def test_split_after_week_applies(self):
        # 4:1 split on 2024-06-10: a 2024-06-03 week is BEFORE it -> factor 4.
        splits = [split("NVDA", "2024-06-10", "4/1")]
        self.assertEqual(cumulative_split_factor("2024-06-03", splits), Fraction(4, 1))
        # The split week itself (2024-06-10) is NOT adjusted (close is post-split).
        self.assertEqual(cumulative_split_factor("2024-06-10", splits), Fraction(1, 1))
        # Weeks after the split are NOT adjusted.
        self.assertEqual(cumulative_split_factor("2024-06-17", splits), Fraction(1, 1))

    def test_split_inside_week_does_not_adjust_that_week(self):
        # Split effective Tuesday 2024-06-11; the weekly bucket ending Friday
        # 2024-06-14 already reflects the split -> factor 1.
        splits = [split("NVDA", "2024-06-11", "4/1")]
        self.assertEqual(cumulative_split_factor("2024-06-14", splits), Fraction(1, 1))
        self.assertEqual(cumulative_split_factor("2024-06-07", splits), Fraction(4, 1))

    def test_sequential_splits_multiply(self):
        # NVDA-style: 4:1 (2021-07-20) then 10:1 (2024-06-10).
        splits = [split("NVDA", "2021-07-20", "4/1"), split("NVDA", "2024-06-10", "10/1")]
        self.assertEqual(cumulative_split_factor("2021-07-13", splits), Fraction(40, 1))
        self.assertEqual(cumulative_split_factor("2021-07-27", splits), Fraction(10, 1))
        self.assertEqual(cumulative_split_factor("2024-06-17", splits), Fraction(1, 1))

    def test_three_sequential_splits(self):
        splits = [
            split("X", "2000-06-27", "2/1"),
            split("X", "2007-09-11", "3/2"),
            split("X", "2024-06-10", "10/1"),
        ]
        self.assertEqual(cumulative_split_factor("2000-06-20", splits), Fraction(30, 1))
        self.assertEqual(cumulative_split_factor("2007-09-04", splits), Fraction(15, 1))
        self.assertEqual(cumulative_split_factor("2024-06-03", splits), Fraction(10, 1))
        self.assertEqual(cumulative_split_factor("2024-06-17", splits), Fraction(1, 1))

    def test_reverse_split_grows_old_prices(self):
        # 1:2 reverse split (ratio 0.5): old prices double on the current scale.
        splits = [split("X", "2024-05-01", "1/2")]
        self.assertEqual(cumulative_split_factor("2024-04-24", splits), Fraction(1, 2))
        self.assertEqual(cumulative_split_factor("2024-05-01", splits), Fraction(1, 1))

    def test_reverse_after_forward(self):
        splits = [split("X", "2020-01-01", "2/1"), split("X", "2024-05-01", "1/2")]
        self.assertEqual(cumulative_split_factor("2019-12-25", splits), Fraction(1, 1))
        self.assertEqual(cumulative_split_factor("2020-01-08", splits), Fraction(1, 2))
        self.assertEqual(cumulative_split_factor("2024-05-08", splits), Fraction(1, 1))


class AdjustSeriesTests(unittest.TestCase):
    def test_example_400_before_4_for_1_becomes_100(self):
        bars = [
            bar("X", "2024-06-03", 400.0),   # before split
            bar("X", "2024-06-10", 100.0),   # split week (post-split close)
            bar("X", "2024-06-17", 102.0),   # after split
        ]
        splits = [split("X", "2024-06-10", "4/1")]
        adjusted = adjust_series(bars, splits)
        self.assertEqual(adjusted[0][1], Fraction(4, 1))
        self.assertAlmostEqual(adjusted[0][2], 100.0, places=6)
        self.assertEqual(adjusted[1][1], Fraction(1, 1))
        self.assertAlmostEqual(adjusted[1][2], 100.0, places=6)
        self.assertAlmostEqual(adjusted[2][2], 102.0, places=6)

    def test_sequential_split_adjustment(self):
        bars = [
            bar("X", "2021-07-13", 800.0),
            bar("X", "2024-06-03", 1200.0),
            bar("X", "2024-06-17", 121.0),
        ]
        splits = [split("X", "2021-07-20", "4/1"), split("X", "2024-06-10", "10/1")]
        adjusted = adjust_series(bars, splits)
        self.assertAlmostEqual(adjusted[0][2], 20.0, places=6)    # 800 / 40
        self.assertAlmostEqual(adjusted[1][2], 120.0, places=6)   # 1200 / 10
        self.assertAlmostEqual(adjusted[2][2], 121.0, places=6)   # unchanged

    def test_reverse_split(self):
        bars = [bar("X", "2024-04-24", 50.0), bar("X", "2024-05-01", 100.0)]
        splits = [split("X", "2024-05-01", "1/2")]
        adjusted = adjust_series(bars, splits)
        self.assertAlmostEqual(adjusted[0][2], 100.0, places=6)   # 50 / 0.5
        self.assertAlmostEqual(adjusted[1][2], 100.0, places=6)

    def test_fractional_split(self):
        bars = [bar("X", "2007-09-04", 90.0), bar("X", "2007-09-18", 60.0)]
        splits = [split("X", "2007-09-11", "3/2")]
        adjusted = adjust_series(bars, splits)
        self.assertAlmostEqual(adjusted[0][2], 60.0, places=6)   # 90 / 1.5
        self.assertAlmostEqual(adjusted[1][2], 60.0, places=6)

    def test_factor_float_projection(self):
        from history_ingestor.splits import split_factor_float
        self.assertEqual(split_factor_float(Fraction(4, 1)), 4.0)
        self.assertEqual(split_factor_float(Fraction(1, 2)), 0.5)

    def test_nvda_style_10_for_1_full_ohlc(self):
        # Legacy-style NVDA: a historical pre-split week at raw 1000 with a
        # 10:1 split (NVIDIA 2024-06-10) must render as 100 on the current
        # scale for every OHLC field — open/high/low/close all divided by 10.
        bars = [
            bar("NVDA", "2024-06-03", 1000.0, open_=980.0, high=1050.0, low=960.0),
            bar("NVDA", "2024-06-10", 120.0, open_=118.0, high=121.0, low=117.0),
            bar("NVDA", "2024-06-17", 122.0, open_=120.0, high=124.0, low=119.0),
        ]
        splits = [split("NVDA", "2024-06-10", "10/1")]
        compiled = adjust_series(bars, splits)
        # Pre-split week: factor 10, every raw /10 -> ~98/105/96/100.
        self.assertEqual(compiled[0][1], Fraction(10, 1))
        self.assertAlmostEqual(compiled[0][0].open / float(compiled[0][1]), 98.0, places=6)
        self.assertAlmostEqual(compiled[0][0].high / float(compiled[0][1]), 105.0, places=6)
        self.assertAlmostEqual(compiled[0][0].low / float(compiled[0][1]), 96.0, places=6)
        self.assertAlmostEqual(compiled[0][2], 100.0, places=6)   # 1000 / 10
        # Split week + after: factor 1, unchanged on the new scale.
        self.assertEqual(compiled[1][1], Fraction(1, 1))
        self.assertAlmostEqual(compiled[1][2], 120.0, places=6)
        self.assertAlmostEqual(compiled[2][2], 122.0, places=6)


class FutureSplitTests(unittest.TestCase):
    """P2-1: future-dated splits must NOT be applied before effective date."""

    def test_future_split_not_applied_before_effective(self):
        # Split effective 2024-06-10; as_of 2024-06-09 -> factor 1 (not applied)
        splits = [split("NVDA", "2024-06-10", "10/1")]
        self.assertEqual(
            cumulative_split_factor("2024-06-03", splits, as_of_date="2024-06-09"),
            Fraction(1, 1),
        )

    def test_split_applied_on_effective_date(self):
        # Split effective 2024-06-10; as_of 2024-06-10 -> factor 10 (applied)
        splits = [split("NVDA", "2024-06-10", "10/1")]
        self.assertEqual(
            cumulative_split_factor("2024-06-03", splits, as_of_date="2024-06-10"),
            Fraction(10, 1),
        )

    def test_adjust_series_with_future_split(self):
        bars = [
            bar("X", "2024-06-03", 400.0),
            bar("X", "2024-06-10", 100.0),
            bar("X", "2024-06-17", 102.0),
        ]
        splits = [split("X", "2024-06-10", "4/1")]
        # Before effective date: no adjustment
        adjusted = adjust_series(bars, splits, as_of_date="2024-06-09")
        self.assertAlmostEqual(adjusted[0][2], 400.0, places=6)  # unchanged
        # On/after effective date: adjustment applies
        adjusted = adjust_series(bars, splits, as_of_date="2024-06-10")
        self.assertAlmostEqual(adjusted[0][2], 100.0, places=6)  # 400 / 4

    def test_multiple_future_splits_deterministic(self):
        # NVDA-style: 10:1 (2024-06-10) and a future 4:1 (2025-01-15)
        splits = [
            split("NVDA", "2024-06-10", "10/1"),
            split("NVDA", "2025-01-15", "4/1"),
        ]
        # Before any split
        self.assertEqual(
            cumulative_split_factor("2024-06-03", splits, as_of_date="2024-06-09"),
            Fraction(1, 1),
        )
        # After first split, before second
        self.assertEqual(
            cumulative_split_factor("2024-06-03", splits, as_of_date="2024-06-10"),
            Fraction(10, 1),
        )
        # After both splits
        self.assertEqual(
            cumulative_split_factor("2024-06-03", splits, as_of_date="2025-01-15"),
            Fraction(40, 1),
        )


if __name__ == "__main__":
    unittest.main()
