import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch

from fundamentals_ingestor.accounting import AccountingUnsupportedError, fetch_accounting_inputs
from fundamentals_ingestor.config import Settings
from fundamentals_ingestor.d1 import SNAPSHOT_COLUMNS
from fundamentals_ingestor.edgar import FilingMetadata
from fundamentals_ingestor.finnhub import MarketData
from fundamentals_ingestor.main import run


class FakeFrame:
    def __init__(self, rows):
        self.rows = rows

    def reset_index(self):
        return self

    def to_dict(self, orient="records"):
        return self.rows


class FakeStatement:
    def __init__(self, rows, periods):
        self.rows = rows
        self.periods = periods

    def to_dataframe(self):
        return FakeFrame(self.rows)


class FakeFacts:
    def __init__(self, ttm_values=None):
        self.ttm_values = ttm_values or {}

    def to_dataframe(self):
        return FakeFrame([])

    def get_ttm(self, concept):
        return types.SimpleNamespace(value=self.ttm_values.get(concept))


QUARTERS = ["Q2 2026", "Q1 2026", "Q4 2025", "Q3 2025"]
PERIODS = [(2026, "Q2"), (2026, "Q1"), (2025, "Q4"), (2025, "Q3")]


def row(label, values, concept=None):
    result = {"label": label}
    if concept is not None:
        result["concept"] = concept
    result.update(dict(zip(QUARTERS, values)))
    return result


class AccountingFallbackTests(unittest.TestCase):
    def test_empty_native_ttm_uses_four_contiguous_quarters(self):
        income_rows = [
            row("Total Revenue", [100, 90, 80, 70]),
            row("Operating Income", [20, 18, 17, 15]),
            row("Income Before Tax", [18, 16, 15, 13]),
            row("Income Tax Expense", [4, 3, 3, 2]),
            row("Net Income", [14, 13, 12, 11]),
        ]
        cash_rows = [
            row("Net Cash Provided by (Used in) Operating Activities", [50, 45, 40, 35]),
            row("Payments to Acquire Property, Plant, and Equipment", [-10, -9, -8, -7]),
            row("Depreciation and Amortization", [8, 7, 6, 5]),
        ]

        class Company:
            def __init__(self, symbol):
                self.facts = FakeFacts()

            def income_statement(self, period, periods=None):
                if period == "ttm":
                    return FakeStatement([], [(2026, "Q2")])
                self.assert_period = period
                return FakeStatement(income_rows, PERIODS)

            def cash_flow_statement(self, period, periods=None):
                if period == "ttm":
                    return FakeStatement([], [(2026, "Q2")])
                return FakeStatement(cash_rows, PERIODS)

            def balance_sheet(self, period, periods=None):
                if period == "annual":
                    return FakeStatement([
                        {"concept": "CashAndCashEquivalentsAtCarryingValue", "label": "Cash and Cash Equivalents", "FY 2025": 30},
                    ], [(2025, "FY")])
                return FakeStatement([
                    {"concept": "CashAndCashEquivalentsAtCarryingValue", "label": "Cash and Cash Equivalents", "Q2 2026": 40},
                    {"concept": "Debt", "label": "Total Debt", "Q2 2026": 50},
                    {"concept": "StockholdersEquity", "label": "Total Stockholders' Equity", "Q2 2026": 200},
                    {"concept": "AssetsCurrent", "label": "Current Assets", "Q2 2026": 150},
                    {"concept": "LiabilitiesCurrent", "label": "Current Liabilities", "Q2 2026": 75},
                ], [(2026, "Q2")])

        fake_edgar = types.SimpleNamespace(Company=Company, set_identity=lambda identity: None)
        filing = FilingMetadata("accession", "2026-06-30", "10-Q", "2026-07-30")
        with patch.dict(sys.modules, {"edgar": fake_edgar}):
            result = fetch_accounting_inputs("AMD", "Validation Operator validation@example.invalid", filing)

        self.assertEqual(result.revenue_ttm, 340)
        self.assertEqual(result.operating_income_ttm, 70)
        self.assertEqual(result.pretax_income_ttm, 62)
        self.assertEqual(result.income_tax_ttm, 12)
        self.assertEqual(result.net_income_ttm, 50)
        self.assertEqual(result.operating_cash_flow_ttm, 170)
        self.assertEqual(result.capex_ttm, 34)
        self.assertEqual(result.free_cash_flow_ttm, 136)
        self.assertEqual(result.depreciation_amortization_ttm, 26)
        self.assertEqual(result.cash, 40)
        self.assertEqual(result.total_debt, 50)
        self.assertEqual(result.shareholders_equity, 200)
        self.assertTrue(result.periods_compatible)

    def test_foreign_issuer_without_four_safe_quarters_is_unsupported(self):
        class Company:
            def __init__(self, symbol):
                self.facts = FakeFacts()

            def income_statement(self, period, periods=None):
                if period == "ttm":
                    return FakeStatement([], [(2026, "Q2")])
                return FakeStatement([row("Total Revenue", [100, 90, None, None])], PERIODS[:2])

            def cash_flow_statement(self, period, periods=None):
                if period == "ttm":
                    return FakeStatement([], [(2026, "Q2")])
                return FakeStatement([], PERIODS[:2])

            def balance_sheet(self, period, periods=None):
                return FakeStatement([], [(2026, "Q2")])

        fake_edgar = types.SimpleNamespace(Company=Company, set_identity=lambda identity: None)
        filing = FilingMetadata("accession", "2026-06-30", "6-K", "2026-07-30")
        with patch.dict(sys.modules, {"edgar": fake_edgar}), self.assertRaises(AccountingUnsupportedError):
            fetch_accounting_inputs("ASML", "Validation Operator validation@example.invalid", filing)


class FakeFinnhub:
    def __init__(self, *args, **kwargs):
        pass

    def fetch(self, symbol):
        return MarketData(100.0, 20.0, 1.1, 5.0, 0.5, "2026-08-23T10:00:00Z")


class UnsupportedRunTests(unittest.TestCase):
    def settings(self):
        return Settings("key", "token", "account", "database", "identity", Path("unused"))

    def test_new_unsupported_symbol_writes_market_only_snapshot_without_global_failure(self):
        class D1:
            def __init__(self, *args, **kwargs):
                self.writes = []

            def get_snapshot(self, symbol):
                return None

            def upsert(self, values):
                self.writes.append(values)

        d1 = D1()
        with (
            patch("fundamentals_ingestor.main.load_universe", return_value=["ASML"]),
            patch("fundamentals_ingestor.main.FinnhubClient", FakeFinnhub),
            patch("fundamentals_ingestor.main.D1Client", return_value=d1),
            patch(
                "fundamentals_ingestor.main.fetch_latest_filing_metadata",
                return_value=FilingMetadata("accession", "2026-06-30", "6-K", "2026-07-30"),
            ),
            patch(
                "fundamentals_ingestor.main.fetch_accounting_inputs",
                side_effect=AccountingUnsupportedError("accounting_quarterly_basis_unsupported"),
            ),
        ):
            counts = run(self.settings())

        self.assertEqual(counts["processed"], 1)
        self.assertEqual(counts["failed"], 0)
        self.assertEqual(counts["written"], 1)
        values = d1.writes[0]
        self.assertEqual(values[SNAPSHOT_COLUMNS.index("accounting_refresh_status")], "unsupported")
        self.assertEqual(values[SNAPSHOT_COLUMNS.index("market_cap")], 100.0)

    def test_same_accession_reuses_unsupported_without_annual_history(self):
        existing = {
            "symbol": "ASML",
            "market_cap": 100.0,
            "pe_ttm": 20.0,
            "beta": 1.1,
            "eps_ttm": 5.0,
            "dividend_yield": 0.5,
            "accounting_as_of": "2026-06-30",
            "accounting_filing_accession": "accession",
            "accounting_filing_form": "6-K",
            "accounting_refresh_status": "unsupported",
            "accounting_periods_compatible": 0,
            "market_checked_at": "old",
        }

        class D1:
            def __init__(self, *args, **kwargs):
                self.writes = []

            def get_snapshot(self, symbol):
                return existing

            def get_annual_years(self, symbol):
                return set()

            def upsert(self, values):
                self.writes.append(values)

        with (
            patch("fundamentals_ingestor.main.load_universe", return_value=["ASML"]),
            patch("fundamentals_ingestor.main.FinnhubClient", FakeFinnhub),
            patch("fundamentals_ingestor.main.D1Client", D1),
            patch(
                "fundamentals_ingestor.main.fetch_latest_filing_metadata",
                return_value=FilingMetadata("accession", "2026-06-30", "6-K", "2026-07-30"),
            ),
            patch(
                "fundamentals_ingestor.main.fetch_accounting_inputs",
                side_effect=AssertionError("unsupported same-accession snapshot should be reused"),
            ),
        ):
            counts = run(self.settings())

        self.assertEqual(counts["failed"], 0)
        self.assertEqual(counts["reused"], 1)


if __name__ == "__main__":
    unittest.main()
