import unittest
from pathlib import Path
from types import SimpleNamespace
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
        "accounting_refresh_status": "ok",
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

    def get_latest_quote(self, symbol, accounting_as_of=None):
        return None

    def upsert(self, values):
        self.writes.append(values)


class RefreshTests(unittest.TestCase):
    def settings(self):
        return Settings("key", "token", "account", "database", "identity", Path("unused"))

    def test_same_accession_reuses_snapshot_without_statement_refresh(self):
        d1_instance = FakeD1()
        with (
            patch("fundamentals_ingestor.main.load_universe", return_value=["MSFT"]),
            patch("fundamentals_ingestor.main.FinnhubClient", FakeFinnhub),
            patch("fundamentals_ingestor.main.D1Client", return_value=d1_instance),
            patch("fundamentals_ingestor.main.fetch_latest_filing_metadata", return_value=FilingMetadata("0000000000-26-000001", "2026-06-30")),
            patch("fundamentals_ingestor.main.fetch_accounting_inputs", side_effect=AssertionError("statement refresh must be skipped")),
        ):
            result = run(self.settings())
        self.assertEqual(result, {"complete": 1, "partial": 0, "missing": 0, "failed": 0, "written": 1})
        self.assertEqual(len(d1_instance.writes), 1)
        self.assertNotEqual(d1_instance.writes[0][SNAPSHOT_COLUMNS.index("updated_at")], "old")

    def test_new_accession_refreshes_statements(self):
        d1_instance = FakeD1()
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
            patch("fundamentals_ingestor.main.D1Client", return_value=d1_instance),
            patch("fundamentals_ingestor.main.fetch_latest_filing_metadata", return_value=FilingMetadata("new-accession", "2026-06-30")),
            patch("fundamentals_ingestor.main.fetch_accounting_inputs", return_value=refreshed) as fetch,
        ):
            result = run(self.settings())
        fetch.assert_called_once()
        self.assertEqual(result["written"], 1)
        self.assertIsNone(d1_instance.writes[0][SNAPSHOT_COLUMNS.index("market_cap")])

    def test_same_accession_retries_incomplete_snapshot(self):
        partial = existing_snapshot()
        partial["capex_ttm"] = None
        partial["free_cash_flow_ttm"] = None
        partial["fcf_margin_pct"] = None
        partial["accounting_refresh_status"] = "incomplete"

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
            patch("fundamentals_ingestor.main.fetch_latest_filing_metadata", return_value=FilingMetadata("0000000000-26-000001", "2026-06-30")),
        ):
            result = run(self.settings())
        self.assertEqual(result, {"complete": 1, "partial": 0, "missing": 0, "failed": 0, "written": 1})
        self.assertEqual(len(d1_instance.writes), 1)

    def test_finnhub_reference_failure_does_not_block_quote_edgar_or_annual_refresh(self):
        class FailingFinnhub:
            def __init__(self, *args, **kwargs):
                pass

            def fetch(self, symbol):
                raise FinnhubError("finnhub_http_429")

        class QuoteD1(FakeD1):
            def __init__(self, *args, **kwargs):
                super().__init__(*args, **kwargs)
                self.quote_reads = 0
                self.annual_writes = 0

            def get_latest_quote(self, symbol, accounting_as_of=None):
                self.quote_reads += 1
                return SimpleNamespace(price=20.0, timestamp="2026-08-22T20:00:00Z", basis_compatible=True)

            def upsert_annual(self, rows):
                self.annual_writes += 1

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
            diluted_eps_ttm=5,
            shares_outstanding=10,
            accounting_as_of="2026-06-30",
            periods_compatible=True,
        )
        d1_instance = QuoteD1()
        with (
            patch("fundamentals_ingestor.main.load_universe", return_value=["MSFT"]),
            patch("fundamentals_ingestor.main.FinnhubClient", FailingFinnhub),
            patch("fundamentals_ingestor.main.D1Client", return_value=d1_instance),
            patch("fundamentals_ingestor.main.fetch_latest_filing_metadata", return_value=FilingMetadata("new-accession", "2026-06-30")),
            patch("fundamentals_ingestor.main.fetch_accounting_inputs", return_value=refreshed),
            patch("fundamentals_ingestor.main.fetch_annual_fundamentals", return_value=[object()]) as annual_fetch,
        ):
            result = run(self.settings())
        annual_fetch.assert_called_once()
        self.assertEqual(d1_instance.quote_reads, 1)
        self.assertEqual(d1_instance.annual_writes, 1)
        self.assertEqual(result["failed"], 0)
        self.assertEqual(d1_instance.writes[0][SNAPSHOT_COLUMNS.index("market_cap")], 200.0)

    def test_market_refresh_is_persisted_when_new_accounting_refresh_fails(self):
        d1_instance = FakeD1()
        with (
            patch("fundamentals_ingestor.main.load_universe", return_value=["MSFT"]),
            patch("fundamentals_ingestor.main.FinnhubClient", FakeFinnhub),
            patch("fundamentals_ingestor.main.D1Client", return_value=d1_instance),
            patch("fundamentals_ingestor.main.fetch_latest_filing_metadata", return_value=FilingMetadata("new-accession", "2026-08-21")),
            patch("fundamentals_ingestor.main.fetch_accounting_inputs", side_effect=RuntimeError("temporary EdgarTools failure")),
        ):
            result = run(self.settings())
        self.assertEqual(result["written"], 1)
        self.assertEqual(result["failed"], 1)
        values = d1_instance.writes[0]
        self.assertEqual(values[SNAPSHOT_COLUMNS.index("market_cap")], 100.0)
        self.assertEqual(values[SNAPSHOT_COLUMNS.index("accounting_filing_accession")], "0000000000-26-000001")

    def test_successful_partial_extraction_is_reused_for_same_accession(self):
        partial = existing_snapshot()
        partial["total_debt"] = None
        partial["accounting_refresh_status"] = "ok"

        class PartialD1(FakeD1):
            def get_snapshot(self, symbol):
                return partial

        with (
            patch("fundamentals_ingestor.main.load_universe", return_value=["MSFT"]),
            patch("fundamentals_ingestor.main.FinnhubClient", FakeFinnhub),
            patch("fundamentals_ingestor.main.D1Client", PartialD1),
            patch("fundamentals_ingestor.main.fetch_latest_filing_metadata", return_value=FilingMetadata("0000000000-26-000001", "2026-06-30")),
            patch("fundamentals_ingestor.main.fetch_accounting_inputs", side_effect=AssertionError("successful partial extraction must be reusable")),
        ):
            result = run(self.settings())
        self.assertEqual(result["failed"], 0)
