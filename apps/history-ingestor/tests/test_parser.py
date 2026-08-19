"""Tests for strict WEEKLY/SPLITS payload parsing (history ingestor)."""

from __future__ import annotations

import unittest
from fractions import Fraction

from history_ingestor.parser import (
    InvalidKeyError,
    PayloadError,
    ProviderMessageError,
    QuotaMessageError,
    ThrottleMessageError,
    parse_splits_payload,
    parse_weekly_payload,
)


def weekly_payload(symbol="NVDA", rows=None):
    """Build a realistic TIME_SERIES_WEEKLY payload (newest-first like AV)."""
    series = {}
    default_rows = [
        ("2026-08-14", "120.0", "122.0", "119.0", "121.0", "100000"),
        ("2026-08-07", "118.0", "119.5", "117.0", "118.5", "95000"),
        ("2026-07-31", "116.0", "117.0", "115.0", "116.2", "88000"),
    ]
    for date_key, o, h, low, c, v in rows if rows is not None else default_rows:
        series[date_key] = {
            "1. open": o, "2. high": h, "3. low": low, "4. close": c, "5. volume": v,
        }
    return {
        "Meta Data": {
            "1. Information": "Weekly Prices (open, high, low, close) and Volumes",
            "2. Symbol": symbol,
            "3. Last Refreshed": "2026-08-18",
            "4. Time Zone": "US/Eastern",
        },
        "Weekly Time Series": series,
    }


def splits_payload(symbol="NVDA", splits=None):
    return {"symbol": symbol, "data": splits or []}


class WeeklyParseTests(unittest.TestCase):
    def test_valid_payload_ascending(self):
        bars = parse_weekly_payload("NVDA", weekly_payload())
        self.assertEqual([bar.week_end_date for bar in bars], ["2026-07-31", "2026-08-07", "2026-08-14"])
        self.assertEqual(bars[0].close, 116.2)
        self.assertEqual(bars[-1].volume, 100000)
        self.assertEqual(bars[-1].symbol, "NVDA")

    def test_newest_first_input_is_sorted(self):
        bars = parse_weekly_payload("NVDA", weekly_payload())
        self.assertEqual(bars[-1].week_end_date, "2026-08-14")

    def test_rejects_provider_note(self):
        with self.assertRaises(QuotaMessageError):
            parse_weekly_payload("NVDA", {"Note": "Thank you for using Alpha Vantage!"})

    def test_rejects_provider_information(self):
        with self.assertRaises(ThrottleMessageError):
            parse_weekly_payload("NVDA", {"Information": "Please spread out your requests"})

    def test_rejects_provider_error_message(self):
        with self.assertRaises(ProviderMessageError):
            parse_weekly_payload("NVDA", {"Error Message": "Invalid API call"})

    def test_rejects_invalid_apikey_message(self):
        with self.assertRaises(InvalidKeyError):
            parse_weekly_payload("NVDA", {"Error Message": "the parameter apikey is invalid or missing"})

    def test_rejects_malformed_json_garbage(self):
        with self.assertRaises(PayloadError):
            parse_weekly_payload("NVDA", {"Weekly Time Series": {"not-a-date": {"1. open": "1"}}})

    def test_rejects_nan_and_zero_and_negative(self):
        bad = weekly_payload()
        bad["Weekly Time Series"]["2026-08-14"]["4. close"] = "NaN"
        with self.assertRaises(PayloadError):
            parse_weekly_payload("NVDA", bad)
        bad = weekly_payload()
        bad["Weekly Time Series"]["2026-08-14"]["4. close"] = "0"
        with self.assertRaises(PayloadError):
            parse_weekly_payload("NVDA", bad)
        bad = weekly_payload()
        bad["Weekly Time Series"]["2026-08-14"]["5. volume"] = "-5"
        with self.assertRaises(PayloadError):
            parse_weekly_payload("NVDA", bad)

    def test_rejects_impossible_ohlc(self):
        bad = weekly_payload()
        bad["Weekly Time Series"]["2026-08-14"]["2. high"] = "100.0"  # below close
        with self.assertRaises(PayloadError):
            parse_weekly_payload("NVDA", bad)

    def test_rejects_duplicate_dates(self):
        bad = weekly_payload()
        bad["Weekly Time Series"]["2026-08-14-dup"] = bad["Weekly Time Series"]["2026-08-14"]
        with self.assertRaises(PayloadError):
            parse_weekly_payload("NVDA", bad)

    def test_empty_series_rejected(self):
        with self.assertRaises(PayloadError):
            parse_weekly_payload("NVDA", {"Meta Data": {}, "Weekly Time Series": {}})

    def test_missing_series_rejected(self):
        with self.assertRaises(PayloadError):
            parse_weekly_payload("NVDA", {"Meta Data": {}})


class SplitsParseTests(unittest.TestCase):
    def test_valid_splits_ascending(self):
        events = parse_splits_payload("NVDA", splits_payload("NVDA", [
            {"effective_date": "2021-07-20", "split_factor": "4.0000"},
            {"effective_date": "2024-06-10", "split_factor": "10.0000"},
        ]))
        self.assertEqual([e.effective_date for e in events], ["2021-07-20", "2024-06-10"])
        self.assertEqual(events[0].ratio, Fraction(4, 1))
        self.assertEqual(events[1].ratio, Fraction(10, 1))

    def test_reverse_split_factor(self):
        events = parse_splits_payload("X", splits_payload("X", [
            {"effective_date": "2024-05-01", "split_factor": "0.5000"},
        ]))
        self.assertEqual(events[0].ratio, Fraction(1, 2))

    def test_fractional_split_factor(self):
        events = parse_splits_payload("X", splits_payload("X", [
            {"effective_date": "2007-09-11", "split_factor": "1.5000"},
        ]))
        self.assertEqual(events[0].ratio, Fraction(3, 2))

    def test_no_splits_is_valid_empty(self):
        # An EXPLICIT data: [] is the provider's verified "no splits" history.
        self.assertEqual(parse_splits_payload("NBIS", splits_payload("NBIS", [])), [])

    def test_legacy_splits_key_empty_is_valid_empty(self):
        self.assertEqual(parse_splits_payload("NBIS", {"symbol": "NBIS", "splits": []}), [])

    def test_missing_data_array_is_rejected_not_zero_splits(self):
        # A payload with NO data/splits array at all is malformed — it must
        # NEVER be interpreted as "zero splits" (P0: NVDA regression).
        for payload in ({"symbol": "NBIS"}, {"symbol": "NBIS", "data": None},
                        {"symbol": "NBIS", "data": "garbage"}):
            with self.assertRaises(PayloadError):
                parse_splits_payload("NBIS", payload)

    def test_non_object_payload_rejected(self):
        for payload in ([], "not a dict", 42, None):
            with self.assertRaises(PayloadError):
                parse_splits_payload("NBIS", payload)

    def test_data_present_but_not_a_list_rejected(self):
        with self.assertRaises(PayloadError):
            parse_splits_payload("NBIS", {"symbol": "NBIS", "data": {"2024-06-10": "10.0000"}})

    def test_rejects_negative_or_zero_factor(self):
        for factor in ("0.0000", "-1.0000"):
            with self.assertRaises(PayloadError):
                parse_splits_payload("X", splits_payload("X", [
                    {"effective_date": "2024-05-01", "split_factor": factor},
                ]))

    def test_rejects_garbage_factor_and_date(self):
        with self.assertRaises(PayloadError):
            parse_splits_payload("X", splits_payload("X", [
                {"effective_date": "2024-05-01", "split_factor": "abc"},
            ]))
        with self.assertRaises(PayloadError):
            parse_splits_payload("X", splits_payload("X", [
                {"effective_date": "nope", "split_factor": "2.0000"},
            ]))

    def test_rejects_duplicate_split_dates(self):
        with self.assertRaises(PayloadError):
            parse_splits_payload("X", splits_payload("X", [
                {"effective_date": "2024-05-01", "split_factor": "2.0000"},
                {"effective_date": "2024-05-01", "split_factor": "2.0000"},
            ]))

    def test_rejects_provider_messages(self):
        with self.assertRaises(QuotaMessageError):
            parse_splits_payload("X", {"Note": "rate limit"})
        with self.assertRaises(InvalidKeyError):
            parse_splits_payload("X", {"Error Message": "the parameter apikey is invalid"})


if __name__ == "__main__":
    unittest.main()
