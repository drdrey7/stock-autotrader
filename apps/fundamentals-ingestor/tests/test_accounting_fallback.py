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


class AccountingFallbackTests(unittest.TestCase):
    def test_empty_native_ttm_uses_duration_aware_facts_not_quarter_sums(self):
        ttm_values = {
            "us-gaap:Revenues": 340,
            "us-gaap:OperatingIncomeLoss": 70,
            "us-gaap:IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments": 62,
            "us-gaap:IncomeTaxExpenseBenefit": 12,
            "us-gaap:NetIncomeLoss": 50,
            "us-gaap:EarningsPerShareDiluted": 5,
            "us-gaap:DepreciationDepletionAndAmortization": 26,
            "us-gaap:NetCashProvidedByUsedInOperatingActivities": 170,
            "us-gaap:PaymentsToAcquireProductiveAssets": -34,
        }

        class Company:
            def __init__(self, symbol):
                self.facts = FakeFacts(ttm_values)

            def income_statement(self, period, periods=None):
                if period == "ttm":
                    return FakeStatement([], [(2026, "Q2")])
                # Deliberately cumulative-looking values. The fallback may use
                # this statement only as a period anchor, never sum the values.
                return FakeStatement([
                    {"label": "Total Revenue", "Q2 2026": 250, "Q1 2026": 100},
                    {"label": "Operating Income", "Q2 2026": 55, "Q1 2026": 20},
                ], [(2026, "Q2")])

            def cash_flow_statement(self, period, periods=None):
                return FakeStatement([], [(2026, "Q2")])

            def balance_sheet(self, period, periods=None):
                if period == "annual":
                    return FakeStatement([
                        {"concept": "CashAndCashEquivalentsAtCarryingValue", "label": "Cash and Cash Equivalents", "FY 2025": 30},
                    ], [(2025, "FY")])
                return FakeStatement([
                    {"concept": "CashAndCashEquivalentsAtCarryingValue", "label": "Cash and Cash Equivalents", "Q2 2026": 40},
                    {"concept": "Debt", "label": "Total Debt", "Q2 2026": 50},
                    {"concept": "StockholdersEquity", "label": "Total Stockholders' Equity", "Q2 2026": 200},
                    {"concept": "us-gaap:AssetsCurrent", "label": "Current Assets", "Q2 2026": 150},
                    {"concept": "us-gaap:LiabilitiesCurrent", "label": "Current Liabilities", "Q2 2026": 75},
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
        self.assertEqual(result.current_assets, 150)
        self.assertEqual(result.current_liabilities, 75)
        self.assertTrue(result.periods_compatible)

    def test_foreign_issuer_with_incomplete_native_ttm_is_unsupported(self):
        class Company:
            def __init__(self, symbol):
                self.facts = FakeFacts()

            def income_statement(self, period, periods=None):
                return FakeStatement([], [(2026, "Q2")])

            def cash_flow_statement(self, period, periods=None):
                return FakeStatement([], [(2026, "Q2")])

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
                side_effect=AccountingUnsupportedError("accounting_current_basis_unsupported"),
            ),
        ):
            counts = run(self.settings())

        self.assertEqual(counts["processed"], 1)
        self.assertEqual(counts["failed"], 0)
        self.assertEqual(counts["written"], 1)
        values = d1.writes[0]
        self.assertEqual(values[SNAPSHOT_COLUMNS.index("accounting_refresh_status")], "unsupported")
        self.assertEqual(values[SNAPSHOT_COLUMNS.index("accounting_filing_accession")], "accession")
        self.assertEqual(values[SNAPSHOT_COLUMNS.index("market_cap")], 100.0)

    def test_new_unsupported_accession_preserves_values_and_records_new_state(self):
        existing = {
            "symbol": "ASML",
            "market_cap": 90.0,
            "pe_ttm": 18.0,
            "beta": 1.0,
            "eps_ttm": 4.0,
            "dividend_yield": 0.4,
            "revenue_ttm": 123.0,
            "accounting_as_of": "2025-12-31",
            "accounting_filing_accession": "old-accession",
            "accounting_filing_form": "20-F",
            "accounting_refresh_status": "ok",
            "accounting_periods_compatible": 1,
            "market_checked_at": "old",
        }

        class D1:
            def __init__(self, *args, **kwargs):
                self.writes = []

            def get_snapshot(self, symbol):
                return existing

            def get_annual_years(self, symbol):
                return {2025}

            def upsert(self, values):
                self.writes.append(values)

        d1 = D1()
        with (
            patch("fundamentals_ingestor.main.load_universe", return_value=["ASML"]),
            patch("fundamentals_ingestor.main.FinnhubClient", FakeFinnhub),
            patch("fundamentals_ingestor.main.D1Client", return_value=d1),
            patch(
                "fundamentals_ingestor.main.fetch_latest_filing_metadata",
                return_value=FilingMetadata("new-accession", "2026-06-30", "6-K", "2026-07-30"),
            ),
            patch(
                "fundamentals_ingestor.main.fetch_accounting_inputs",
                side_effect=AccountingUnsupportedError("accounting_current_basis_unsupported"),
            ),
        ):
            counts = run(self.settings())

        self.assertEqual(counts["failed"], 0)
        values = d1.writes[0]
        self.assertEqual(values[SNAPSHOT_COLUMNS.index("revenue_ttm")], 123.0)
        self.assertEqual(values[SNAPSHOT_COLUMNS.index("accounting_as_of")], "2025-12-31")
        self.assertEqual(values[SNAPSHOT_COLUMNS.index("accounting_filing_accession")], "new-accession")
        self.assertEqual(values[SNAPSHOT_COLUMNS.index("accounting_filing_form")], "6-K")
        self.assertEqual(values[SNAPSHOT_COLUMNS.index("accounting_refresh_status")], "unsupported")

    def test_same_accession_reuses_unsupported_without_annual_history(self):
        existing = {
            "symbol": "ASML",
            "market_cap": 100.0,
            "pe_ttm": 20.0,
            "beta": 1.1,
            "eps_ttm": 5.0,
            "dividend_yield": 0.5,
            "accounting_as_of": "2025-12-31",
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
