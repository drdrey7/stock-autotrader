import sys
import types
import unittest
from unittest.mock import patch

from fundamentals_ingestor.edgar import (
    FilingLookupError,
    _annual_period_count,
    _annual_years,
    _balance_value,
    _fact_ttm_value,
    _fact_value,
    _find,
    _latest_instant_fact,
    _rows,
    _share_fact_value,
    fetch_accounting_inputs,
    fetch_latest_filing_metadata,
    periods_compatible,
)
from fundamentals_ingestor.finnhub import FinnhubClient, FinnhubError, normalize_metric


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


class FakeFacts:
    def __init__(self, rows, ttm_value=None, ttm_values=None):
        self.rows = rows
        self.ttm_value = ttm_value
        self.ttm_values = ttm_values or {}

    def to_dataframe(self):
        return FakeFrame(self.rows)

    def get_ttm(self, concept):
        return types.SimpleNamespace(value=self.ttm_values.get(concept, self.ttm_value))


class FakeHttpResponse:
    status = 200

    def __init__(self, payload):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return None

    def read(self):
        import json
        return json.dumps(self.payload).encode("utf-8")


class NormalizationTests(unittest.TestCase):
    def test_annual_period_count_uses_unique_provider_filing_periods(self):
        class Column:
            def to_pylist(self):
                return ["2026-06-30", "2026-06-30", "2025-06-30", "2024-06-30"]

        class Data:
            def __getitem__(self, key):
                self.asserted_key = key
                return Column()

        class Filings:
            data = Data()

            def filter(self, **kwargs):
                return self

        self.assertEqual(_annual_period_count(Filings()), 3)

    def test_annual_periods_accept_tuple_form(self):
        self.assertEqual(_annual_years(FakeStatement([], [(2026, "FY"), (2025, "FY"), "FY 2024"])), [2026, 2025, 2024])

    def test_finnhub_direct_fields_and_timestamp(self):
        value = normalize_metric({"metric": {"marketCapitalization": 123.4, "peTTM": 21.5, "beta": 1.2, "epsTTM": 5.5, "dividendYieldTTM": 0.4}}, "2023-11-14T22:13:20Z")
        self.assertEqual(value.market_cap, 123_400_000)
        self.assertEqual(value.pe_ttm, 21.5)
        self.assertEqual(value.beta, 1.2)
        self.assertEqual(value.eps_ttm, 5.5)
        self.assertEqual(value.dividend_yield, 0.4)
        self.assertEqual(value.checked_at, "2023-11-14T22:13:20Z")

    def test_finnhub_invalid_fields_fail_closed(self):
        value = normalize_metric({"metric": {"marketCapitalization": "n/a", "peTTM": "n/a"}})
        self.assertIsNone(value.market_cap)
        self.assertIsNone(value.pe_ttm)

    def test_finnhub_metric_request_uses_metric_all_and_no_quote_freshness(self):
        requests = []

        def opener(request, timeout):
            requests.append(request)
            return FakeHttpResponse({"metric": {"marketCapitalization": 123.4, "peTTM": 21.5}})

        result = FinnhubClient("test-key", opener=opener, min_interval_seconds=0).fetch("MSFT")
        from urllib.parse import parse_qs, urlparse
        metric_query = parse_qs(urlparse(requests[0].full_url).query)
        self.assertEqual(metric_query, {"symbol": ["MSFT"], "token": ["test-key"], "metric": ["all"]})
        self.assertEqual(result.market_cap, 123_400_000)
        self.assertEqual(result.pe_ttm, 21.5)
        self.assertIsNotNone(result.checked_at)

    def test_finnhub_http_200_invalid_metric_payload_is_provider_failure(self):
        invalid_payloads = [
            {"error": "rate limit"},
            {"symbol": "MSFT"},
            {"metric": {}},
            {"metric": {"epsTTM": 1.0}},
            {"metric": {"peTTM": None}},
        ]
        for payload in invalid_payloads:
            with self.subTest(payload=payload):
                def opener(request, timeout, payload=payload):
                    if "/quote?" in request.full_url:
                        return FakeHttpResponse({"t": 1_700_000_000})
                    return FakeHttpResponse(payload)

                with self.assertRaises(FinnhubError):
                    FinnhubClient("test-key", opener=opener, min_interval_seconds=0).fetch("MSFT")

    def test_edgartools_statement_rows_use_normalized_labels(self):
        rows = _rows(FakeStatement([{"label": "Total Revenue", "Q4 2026": 100}], ["Q4 2026"]))
        self.assertEqual(_find(rows, ("Total Revenue",), "Q4 2026"), 100)

    def test_missing_requested_period_does_not_borrow_another_period(self):
        rows = _rows(FakeStatement([{"label": "Total Revenue", "FY 2023": 100}], ["FY 2023"]))
        self.assertIsNone(_find(rows, ("Total Revenue",), "FY 2022"))

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
            form = "10-Q/A"
            filing_date = "2026-08-01"

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
        self.assertEqual(result.form, "10-Q/A")
        self.assertEqual(result.filed_date, "2026-08-01")
        self.assertEqual(calls[0]["amendments"], True)
        self.assertEqual(
            calls[0]["form"],
            ["10-K", "10-K/A", "10-Q", "10-Q/A", "20-F", "20-F/A", "6-K", "6-K/A"],
        )

    def test_edgartools_facts_normalize_nvidia_security_labels(self):
        rows = [
            {"concept": "us-gaap:MarketableSecuritiesCurrent", "numeric_value": 22_855, "period_type": "instant", "fiscal_year": 2027, "fiscal_period": "Q3", "period_end": "2026-06-27"},
            {"concept": "us-gaap:DebtSecuritiesCurrent", "numeric_value": 37_098, "period_type": "instant", "fiscal_year": 2027, "fiscal_period": "Q1", "period_end": "2026-04-26"},
            {"concept": "us-gaap:EquitySecuritiesFvNi", "numeric_value": 30_237, "period_type": "instant", "fiscal_year": 2027, "fiscal_period": "Q1", "period_end": "2026-04-26"},
        ]
        self.assertEqual(_fact_value(rows, ("us-gaap:MarketableSecuritiesCurrent",), (2027, "Q3")), 22_855)
        self.assertEqual(_fact_value(rows, ("us-gaap:DebtSecuritiesCurrent",), (2027, "Q1")), 37_098)
        self.assertEqual(_fact_value(rows, ("us-gaap:EquitySecuritiesFvNi",), (2027, "Q1")), 30_237)
        self.assertEqual(_fact_ttm_value(types.SimpleNamespace(facts=FakeFacts([], 6_572)), ("us-gaap:PaymentsToAcquireProductiveAssets",)), 6_572)

    def test_latest_share_fact_uses_normalized_concept_and_filing_as_of(self):
        rows = [
            {"concept": "dei:EntityCommonStockSharesOutstanding", "numeric_value": 101, "period_type": "instant", "period_end": "2026-06-30"},
            {"concept": "us-gaap:CommonStockSharesOutstanding", "numeric_value": 102, "period_type": "instant", "period_end": "2026-07-31"},
        ]
        self.assertEqual(_latest_instant_fact(rows, ("dei:EntityCommonStockSharesOutstanding", "us-gaap:CommonStockSharesOutstanding"), "2026-07-01"), 101)

    def test_share_fact_can_use_filing_cover_date_after_period_of_report(self):
        rows = [{
            "concept": "dei:EntityCommonStockSharesOutstanding",
            "numeric_value": 102,
            "period_type": "instant",
            "period_end": "2026-07-31",
        }]
        self.assertEqual(_share_fact_value(rows, ("dei:EntityCommonStockSharesOutstanding",), "2026-08-01"), 102)

    def test_share_facts_sum_distinct_same_date_classes_without_double_counting(self):
        rows = [
            {"concept": "dei:EntityCommonStockSharesOutstanding", "numeric_value": 100, "period_type": "instant", "period_end": "2026-06-30", "dim_dei_StatementClassOfStockAxis": "goog:ClassA"},
            {"concept": "dei:EntityCommonStockSharesOutstanding", "numeric_value": 50, "period_type": "instant", "period_end": "2026-06-30", "dim_dei_StatementClassOfStockAxis": "goog:ClassC"},
            {"concept": "dei:EntityCommonStockSharesOutstanding", "numeric_value": 100, "period_type": "instant", "period_end": "2026-06-30", "dim_dei_StatementClassOfStockAxis": "goog:ClassA"},
        ]
        self.assertEqual(_share_fact_value(rows, ("dei:EntityCommonStockSharesOutstanding",), "2026-06-30"), 150)

    def test_share_facts_prefer_consolidated_total_over_dimensional_classes(self):
        rows = [
            {"concept": "us-gaap:CommonStockSharesOutstanding", "numeric_value": 150, "period_type": "instant", "period_end": "2026-06-30"},
            {"concept": "dei:EntityCommonStockSharesOutstanding", "numeric_value": 100, "period_type": "instant", "period_end": "2026-06-30", "dim_dei_StatementClassOfStockAxis": "goog:ClassA"},
            {"concept": "dei:EntityCommonStockSharesOutstanding", "numeric_value": 50, "period_type": "instant", "period_end": "2026-06-30", "dim_dei_StatementClassOfStockAxis": "goog:ClassC"},
        ]
        self.assertEqual(_share_fact_value(rows, ("dei:EntityCommonStockSharesOutstanding", "us-gaap:CommonStockSharesOutstanding"), "2026-06-30"), 150)

    def test_filing_lookup_failure_is_not_reported_as_no_filing(self):
        class Company:
            def __init__(self, symbol):
                self.symbol = symbol

            def get_filings(self, **kwargs):
                raise TimeoutError("temporary provider failure")

        fake_edgar = types.SimpleNamespace(Company=Company, set_identity=lambda identity: None)
        with patch.dict(sys.modules, {"edgar": fake_edgar}), self.assertRaises(FilingLookupError):
            fetch_latest_filing_metadata("MSFT", "Validation Operator validation@example.invalid")

    def test_accounting_inputs_use_edgartools_fact_fallbacks(self):
        class Company:
            def __init__(self, symbol):
                self.facts = FakeFacts([
                    {"concept": "us-gaap:DebtSecuritiesCurrent", "numeric_value": 37_098, "period_type": "instant", "fiscal_year": 2027, "fiscal_period": "Q1", "period_end": "2026-04-26"},
                    {"concept": "us-gaap:EquitySecuritiesFvNi", "numeric_value": 30_237, "period_type": "instant", "fiscal_year": 2027, "fiscal_period": "Q1", "period_end": "2026-04-26"},
                ], 6_572)

            def income_statement(self, **kwargs):
                return FakeStatement([
                    {"label": "Total Revenue", "Q1 2027": 253_491},
                    {"label": "Operating Income", "Q1 2027": 162_285},
                    {"label": "Income Before Tax", "Q1 2027": 189_443},
                    {"label": "Income Tax Expense", "Q1 2027": 29_830},
                ], [(2027, "Q1")])

            def cash_flow_statement(self, **kwargs):
                return FakeStatement([{"label": "Net Cash Provided by (Used in) Operating Activities", "Q1 2027": 125_648}], [(2027, "Q1")])

            def balance_sheet(self, **kwargs):
                return FakeStatement([
                    {"concept": "CashAndCashEquivalentsAtCarryingValue", "label": "Cash and Cash Equivalents", "Q1 2027": 13_237},
                    {"concept": "LongTermDebtCurrent", "label": "Long-term Debt, Current Maturities", "Q1 2027": 1_000},
                    {"concept": "LongTermDebtNoncurrent", "label": "Long-term Debt, Excluding Current Maturities", "Q1 2027": 7_470},
                    {"concept": "StockholdersEquity", "label": "Stockholders' Equity Attributable to Parent", "Q1 2027": 195_474},
                ], [(2027, "Q1")])

        fake_edgar = types.SimpleNamespace(Company=Company, set_identity=lambda identity: None)
        filing = types.SimpleNamespace(period_of_report="2026-04-26")
        with patch.dict(sys.modules, {"edgar": fake_edgar}):
            result = fetch_accounting_inputs("NVDA", "Validation Operator validation@example.invalid", filing)

        self.assertEqual(result.capex_ttm, 6_572)
        self.assertEqual(result.short_term_investments, 67_335)

    def test_accounting_inputs_use_canonical_income_and_debt_facts_when_labels_are_absent(self):
        class Company:
            def __init__(self, symbol):
                self.facts = FakeFacts([
                    {"concept": "us-gaap:DebtCurrent", "numeric_value": 20, "period_type": "instant", "fiscal_year": 2027, "fiscal_period": "Q1", "period_end": "2026-04-26"},
                    {"concept": "us-gaap:LongTermDebtNoncurrent", "numeric_value": 80, "period_type": "instant", "fiscal_year": 2027, "fiscal_period": "Q1", "period_end": "2026-04-26"},
                ], ttm_values={
                    "us-gaap:Revenues": 1_000,
                    "us-gaap:IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments": 200,
                })

            def income_statement(self, **kwargs):
                return FakeStatement([{"label": "Operating Income", "Q1 2027": 300}, {"label": "Income Tax Expense", "Q1 2027": 40}], [(2027, "Q1")])

            def cash_flow_statement(self, **kwargs):
                return FakeStatement([{"label": "Net Cash Provided by (Used in) Operating Activities", "Q1 2027": 400}], [(2027, "Q1")])

            def balance_sheet(self, **kwargs):
                return FakeStatement([
                    {"concept": "CashAndCashEquivalentsAtCarryingValue", "label": "Cash and Cash Equivalents", "Q1 2027": 100},
                    {"concept": "StockholdersEquity", "label": "Total Stockholders' Equity", "Q1 2027": 500},
                ], [(2027, "Q1")])

        fake_edgar = types.SimpleNamespace(Company=Company, set_identity=lambda identity: None)
        filing = types.SimpleNamespace(period_of_report="2026-04-26")
        with patch.dict(sys.modules, {"edgar": fake_edgar}):
            result = fetch_accounting_inputs("AMZN", "Validation Operator validation@example.invalid", filing)

        self.assertEqual(result.revenue_ttm, 1_000)
        self.assertEqual(result.pretax_income_ttm, 200)
        self.assertEqual(result.total_debt, 100)

    def test_empty_statement_response_is_incomplete(self):
        class Company:
            def __init__(self, symbol):
                self.symbol = symbol

            def income_statement(self, **kwargs):
                return FakeStatement([], [(2027, "Q1")])

            def cash_flow_statement(self, **kwargs):
                return FakeStatement([], [(2027, "Q1")])

            def balance_sheet(self, **kwargs):
                return FakeStatement([], [(2027, "Q1")])

        fake_edgar = types.SimpleNamespace(Company=Company, set_identity=lambda identity: None)
        filing = types.SimpleNamespace(period_of_report="2026-04-26")
        with patch.dict(sys.modules, {"edgar": fake_edgar}), self.assertRaisesRegex(
            RuntimeError, "accounting_statement_incomplete",
        ):
            fetch_accounting_inputs("MSFT", "Validation Operator validation@example.invalid", filing)
