import sys
import types
import unittest
from unittest.mock import patch

from fundamentals_ingestor.edgar import _balance_value, _find, _rows, fetch_latest_filing_metadata, periods_compatible
from fundamentals_ingestor.finnhub import normalize_metric, normalize_quote


class FakeFrame:
    def __init__(self, rows):
        self.rows = rows

    def reset_index(self):
        return self

    def to_dict(self, orient="records"):
        return self.rows


class FakeStatement:
    def __init__(self, rows, periods):
        self.frame = FakeFrame(rows)
        self.periods = periods

    def to_dataframe(self):
        return self.frame


class NormalizationTests(unittest.TestCase):
    def test_finnhub_direct_fields_and_timestamp(self):
        self.assertEqual(normalize_quote({"t": 1_700_000_000}), "2023-11-14T22:13:20Z")
        value = normalize_metric({"metric": {"marketCapitalization": 123.4, "peTTM": 21.5}}, "2023-11-14T22:13:20Z")
        self.assertEqual(value.market_cap, 123_400_000)
        self.assertEqual(value.pe_ttm, 21.5)

    def test_finnhub_invalid_fields_fail_closed(self):
        value = normalize_metric({"metric": {"marketCapitalization": -1, "peTTM": "n/a"}})
        self.assertIsNone(value.market_cap)
        self.assertIsNone(value.pe_ttm)

    def test_edgartools_statement_rows_use_normalized_labels(self):
        rows = _rows(FakeStatement([{"label": "Total Revenue", "Q4 2026": 100}], ["Q4 2026"]))
        self.assertEqual(_find(rows, ("Total Revenue",), "Q4 2026"), 100)

    def test_period_compatibility_is_strict(self):
        self.assertTrue(periods_compatible(FakeStatement([], [(2026, "Q4")]), FakeStatement([], ["FY 2026"])))
        self.assertFalse(periods_compatible(FakeStatement([], [(2026, "Q4")]), FakeStatement([], ["Q3 2026"])))

    def test_edgartools_balance_inputs_use_only_required_concepts(self):
        rows = _rows(FakeStatement([
            {"concept": "CashAndCashEquivalentsAtCarryingValue", "label": "Cash and Cash Equivalents", "FY 2026": 120},
            {"concept": "ShortTermInvestments", "label": "Short-term Investments", "FY 2026": 30},
            {"concept": "LongTermDebtCurrent", "label": "Current debt", "FY 2026": 10},
            {"concept": "LongTermDebtNoncurrent", "label": "Long-term debt", "FY 2026": 90},
            {"concept": "StockholdersEquity", "label": "Total Stockholders' Equity", "FY 2026": 400},
            {"concept": "Goodwill", "label": "Goodwill", "FY 2026": 999},
        ], ["FY 2026"]))
        self.assertEqual(_balance_value(rows, ("CashAndCashEquivalentsAtCarryingValue",), (), "FY 2026"), 120)
        self.assertEqual(_balance_value(rows, ("ShortTermInvestments",), (), "FY 2026"), 30)
        self.assertEqual(_balance_value(rows, ("LongTermDebtCurrent",), (), "FY 2026"), 10)
        self.assertEqual(_balance_value(rows, ("LongTermDebtNoncurrent",), (), "FY 2026"), 90)
        self.assertEqual(_balance_value(rows, ("StockholdersEquity",), (), "FY 2026"), 400)

    def test_latest_filing_detection_includes_relevant_amendments(self):
        calls = []

        class Filing:
            accession_number = "0000000000-26-000002"
            period_of_report = "2026-06-30"

        class Filings:
            def latest(self):
                return Filing()

        class Company:
            def __init__(self, symbol):
                self.symbol = symbol

            def get_filings(self, **kwargs):
                calls.append(kwargs)
                return Filings()

        fake_edgar = types.SimpleNamespace(Company=Company, set_identity=lambda identity: None)
        with patch.dict(sys.modules, {"edgar": fake_edgar}):
            result = fetch_latest_filing_metadata("MSFT", "Validation Operator validation@example.invalid")

        self.assertEqual(result.accession, "0000000000-26-000002")
        self.assertEqual(calls[0]["amendments"], True)
        self.assertEqual(
            calls[0]["form"],
            ["10-K", "10-K/A", "10-Q", "10-Q/A", "20-F", "20-F/A", "6-K", "6-K/A"],
        )
