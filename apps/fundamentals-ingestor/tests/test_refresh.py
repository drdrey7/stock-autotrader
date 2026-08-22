import unittest
from pathlib import Path
from unittest.mock import patch

from fundamentals_ingestor.config import Settings
from fundamentals_ingestor.d1 import SNAPSHOT_COLUMNS
from fundamentals_ingestor.edgar import FilingLookupError, FilingMetadata
from fundamentals_ingestor.finnhub import FinnhubError, MarketData
from fundamentals_ingestor.main import run
from fundamentals_ingestor.metrics import AccountingInputs


def existing_snapshot():
    return {
        "symbol": "MSFT",
        "market_cap": 100.0,
        "pe_ttm": 20.0,
        "revenue_ttm": 100.0,
        "operating_income_ttm": 20.0,
        "pretax_income_ttm": 20.0,
        "income_tax_ttm": 4.0,
        "operating_cash_flow_ttm": 30.0,
        "capex_ttm": 5.0,
        "free_cash_flow_ttm": 25.0,
        "cash": 10.0,
        "short_term_investments": 5.0,
        "total_debt": 20.0,
        "shareholders_equity": 50.0,
        "roic_pct": 20.0,
        "fcf_margin_pct": 25.0,
        "debt_to_equity": 0.4,
        "accounting_as_of": "2026-06-30",
        "market_as_of": "2026-08-21T20:00:00Z",
        "accounting_source": "edgartools",
        "market_source": "finnhub",
        "accounting_filing_accession": "0000000000-26-000001",
        "updated_at": "old",
    }


class FakeFinnhub:
    def __init__(self, *args, **kwargs):
        pass

    def fetch(self, symbol):
        return MarketData(100.0, 20.0, "2026-08-21T20:00:00Z")


class FakeD1:
    def __init__(self, *args, **kwargs):
        self.writes = []

    def get_snapshot(self, symbol):
        return existing_snapshot()

    def upsert(self, values):
        self.writes.append(values)


class RefreshTests(unittest.TestCase):
    def settings(self):
        return Settings("key", "token", "account", "database", "identity", Path("unused"))

    def test_same_accession_reuses_snapshot_without_statement_refresh(self):
        with (
            patch("fundamentals_ingestor.main.load_universe", return_value=["MSFT"]),
            patch("fundamentals_ingestor.main.FinnhubClient", FakeFinnhub),
            patch("fundamentals_ingestor.main.D1Client", FakeD1),
            patch("fundamentals_ingestor.main.fetch_latest_filing_metadata", return_value=FilingMetadata("0000000000-26-000001", "2026-06-30")),
            patch("fundamentals_ingestor.main.fetch_accounting_inputs", side_effect=AssertionError("statement refresh must be skipped")),
        ):
            result = run(self.settings())
        self.assertEqual(result, {"complete": 1, "partial": 0, "missing": 0, "failed": 0, "written": 1})

    def test_new_accession_refreshes_statements(self):
        refreshed = AccountingInputs(
            revenue_ttm=100,
            operating_income_ttm=20,
            pretax_income_ttm=20,
            income_tax_ttm=4,
            operating_cash_flow_ttm=30,
            capex_ttm=5,
            cash=10,
            short_term_investments=5,
            total_debt=20,
            shareholders_equity=50,
            accounting_as_of="2026-06-30",
            periods_compatible=True,
        )
        with (
            patch("fundamentals_ingestor.main.load_universe", return_value=["MSFT"]),
            patch("fundamentals_ingestor.main.FinnhubClient", FakeFinnhub),
            patch("fundamentals_ingestor.main.D1Client", FakeD1),
            patch("fundamentals_ingestor.main.fetch_latest_filing_metadata", return_value=FilingMetadata("new-accession", "2026-06-30")),
            patch("fundamentals_ingestor.main.fetch_accounting_inputs", return_value=refreshed) as fetch,
        ):
            result = run(self.settings())
        fetch.assert_called_once()
        self.assertEqual(result["written"], 1)

    def test_same_accession_retries_incomplete_snapshot(self):
        partial = existing_snapshot()
        partial["capex_ttm"] = None
        partial["free_cash_flow_ttm"] = None
        partial["fcf_margin_pct"] = None

        class PartialD1(FakeD1):
            def get_snapshot(self, symbol):
                return partial

        refreshed = AccountingInputs(
            revenue_ttm=100,
            operating_income_ttm=20,
            pretax_income_ttm=20,
            income_tax_ttm=4,
            operating_cash_flow_ttm=30,
            capex_ttm=5,
            cash=10,
            short_term_investments=5,
            total_debt=20,
            shareholders_equity=50,
            accounting_as_of="2026-06-30",
            periods_compatible=True,
        )
        with (
            patch("fundamentals_ingestor.main.load_universe", return_value=["MSFT"]),
            patch("fundamentals_ingestor.main.FinnhubClient", FakeFinnhub),
            patch("fundamentals_ingestor.main.D1Client", PartialD1),
            patch("fundamentals_ingestor.main.fetch_latest_filing_metadata", return_value=FilingMetadata("0000000000-26-000001", "2026-06-30")),
            patch("fundamentals_ingestor.main.fetch_accounting_inputs", return_value=refreshed) as fetch,
        ):
            result = run(self.settings())
        fetch.assert_called_once()
        self.assertEqual(result["written"], 1)

    def test_same_accession_reuses_valid_nullable_derived_metrics(self):
        nullable = existing_snapshot()
        nullable["roic_pct"] = None
        nullable["debt_to_equity"] = None

        class NullableD1(FakeD1):
            def get_snapshot(self, symbol):
                return nullable

        with (
            patch("fundamentals_ingestor.main.load_universe", return_value=["MSFT"]),
            patch("fundamentals_ingestor.main.FinnhubClient", FakeFinnhub),
            patch("fundamentals_ingestor.main.D1Client", NullableD1),
            patch("fundamentals_ingestor.main.fetch_latest_filing_metadata", return_value=FilingMetadata("0000000000-26-000001", "2026-06-30")),
            patch("fundamentals_ingestor.main.fetch_accounting_inputs", side_effect=AssertionError("valid nullable metrics must be reusable")),
        ):
            result = run(self.settings())
        self.assertEqual(result, {"complete": 0, "partial": 1, "missing": 0, "failed": 0, "written": 1})

    def test_lookup_failure_preserves_existing_filing_metadata(self):
        partial = existing_snapshot()
        partial["capex_ttm"] = None
        partial["free_cash_flow_ttm"] = None
        partial["fcf_margin_pct"] = None
        refreshed = AccountingInputs(
            revenue_ttm=100,
            operating_income_ttm=20,
            pretax_income_ttm=20,
            income_tax_ttm=4,
            operating_cash_flow_ttm=30,
            capex_ttm=5,
            cash=10,
            short_term_investments=5,
            total_debt=20,
            shareholders_equity=50,
            accounting_as_of="2026-06-30",
            periods_compatible=True,
        )

        class PartialD1(FakeD1):
            def get_snapshot(self, symbol):
                return partial

        d1_instance = PartialD1()
        with (
            patch("fundamentals_ingestor.main.load_universe", return_value=["MSFT"]),
            patch("fundamentals_ingestor.main.FinnhubClient", FakeFinnhub),
            patch("fundamentals_ingestor.main.D1Client", return_value=d1_instance),
            patch("fundamentals_ingestor.main.fetch_latest_filing_metadata", side_effect=FilingLookupError("temporary")),
            patch("fundamentals_ingestor.main.fetch_accounting_inputs", return_value=refreshed),
        ):
            result = run(self.settings())
        self.assertEqual(result["written"], 1)
        values = d1_instance.writes[0]
        self.assertEqual(values[SNAPSHOT_COLUMNS.index("accounting_filing_accession")], "0000000000-26-000001")

    def test_finnhub_provider_failure_never_overwrites_existing_snapshot(self):
        class FailingFinnhub:
            def __init__(self, *args, **kwargs):
                pass

            def fetch(self, symbol):
                raise FinnhubError("finnhub_invalid_metric_payload")

        d1_instance = FakeD1()
        with (
            patch("fundamentals_ingestor.main.load_universe", return_value=["MSFT"]),
            patch("fundamentals_ingestor.main.FinnhubClient", FailingFinnhub),
            patch("fundamentals_ingestor.main.D1Client", return_value=d1_instance),
        ):
            result = run(self.settings())
        self.assertEqual(result, {"complete": 0, "partial": 0, "missing": 0, "failed": 1, "written": 0})
        self.assertEqual(d1_instance.writes, [])
