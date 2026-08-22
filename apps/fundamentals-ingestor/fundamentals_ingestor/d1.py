"""Small Cloudflare D1 HTTP writer."""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any

from .edgar import AnnualFundamental
from .finnhub import MarketData
from .metrics import AccountingInputs, CalculatedMetrics

ENDPOINT = "https://api.cloudflare.com/client/v4/accounts/{account_id}/d1/database/{database_id}/query"


def _value(value: float | str | None) -> float | str | None:
    return value


SNAPSHOT_COLUMNS = (
    "symbol", "market_cap", "pe_ttm", "revenue_ttm", "operating_income_ttm", "pretax_income_ttm",
    "income_tax_ttm", "operating_cash_flow_ttm", "capex_ttm", "free_cash_flow_ttm", "cash",
    "short_term_investments", "total_debt", "shareholders_equity", "roic_pct", "fcf_margin_pct",
    "debt_to_equity", "accounting_as_of", "market_as_of", "accounting_source", "market_source",
    "accounting_filing_accession", "accounting_refresh_status", "net_income_ttm", "diluted_eps_ttm",
    "depreciation_amortization_ttm", "shares_outstanding", "updated_at",
)


def snapshot_values(
    symbol: str,
    market: MarketData,
    accounting: AccountingInputs,
    calculated: CalculatedMetrics,
    updated_at: str,
    accounting_filing_accession: str | None = None,
) -> list[Any]:
    return [
        symbol,
        _value(market.market_cap),
        _value(market.pe_ttm),
        _value(accounting.revenue_ttm),
        _value(accounting.operating_income_ttm),
        _value(accounting.pretax_income_ttm),
        _value(accounting.income_tax_ttm),
        _value(accounting.operating_cash_flow_ttm),
        _value(accounting.capex_ttm),
        _value(calculated.free_cash_flow_ttm),
        _value(accounting.cash),
        _value(accounting.short_term_investments),
        _value(accounting.total_debt),
        _value(accounting.shareholders_equity),
        _value(calculated.roic_pct),
        _value(calculated.fcf_margin_pct),
        _value(calculated.debt_to_equity),
        _value(accounting.accounting_as_of),
        _value(market.market_as_of),
        "edgartools",
        "finnhub",
        _value(accounting_filing_accession),
        _value(accounting.extraction_status),
        _value(accounting.net_income_ttm),
        _value(accounting.diluted_eps_ttm),
        _value(accounting.depreciation_amortization_ttm),
        _value(accounting.shares_outstanding),
        updated_at,
    ]


ANNUAL_COLUMNS = (
    "symbol", "fiscal_year", "revenue", "operating_income", "pretax_income", "income_tax",
    "net_income", "diluted_eps", "operating_cash_flow", "capex", "free_cash_flow",
    "depreciation_amortization", "cash", "total_debt", "shareholders_equity",
    "shares_outstanding", "as_of", "source",
)


def annual_values(symbol: str, row: AnnualFundamental) -> list[Any]:
    return [
        symbol, row.fiscal_year, row.revenue, row.operating_income, row.pretax_income,
        row.income_tax, row.net_income, row.diluted_eps, row.operating_cash_flow,
        row.capex, row.free_cash_flow, row.depreciation_amortization, row.cash,
        row.total_debt, row.shareholders_equity, row.shares_outstanding, row.as_of, row.source,
    ]


class D1Client:
    def __init__(self, api_token: str, account_id: str, database_id: str, timeout_seconds: float = 30.0) -> None:
        self._token = api_token
        self._url = ENDPOINT.format(account_id=account_id, database_id=database_id)
        self._timeout = timeout_seconds

    def _query(self, sql: str, params: list[Any] | None = None) -> list[dict[str, Any]]:
        body = json.dumps({"sql": sql, "params": params or []}).encode("utf-8")
        request = urllib.request.Request(
            self._url,
            data=body,
            headers={"Authorization": f"Bearer {self._token}", "Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=self._timeout) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            raise RuntimeError("d1_request_failed") from exc
        if not payload.get("success"):
            raise RuntimeError("d1_query_failed")
        result = payload.get("result")
        if not isinstance(result, list) or not result or not isinstance(result[0], dict):
            return []
        rows = result[0].get("results")
        return rows if isinstance(rows, list) else []

    def get_snapshot(self, symbol: str) -> dict[str, Any] | None:
        rows = self._query(
            "SELECT " + ", ".join(SNAPSHOT_COLUMNS) + " FROM stock_fundamentals_snapshot WHERE symbol = ? LIMIT 1",
            [symbol],
        )
        return rows[0] if rows and isinstance(rows[0], dict) else None

    def get_latest_quote(self, symbol: str) -> tuple[float, str] | None:
        rows = self._query(
            "SELECT price, provider_timestamp FROM latest_quotes WHERE symbol = ? LIMIT 1",
            [symbol],
        )
        if not rows or not isinstance(rows[0], dict):
            return None
        price, timestamp = rows[0].get("price"), rows[0].get("provider_timestamp")
        if not isinstance(price, (int, float)) or isinstance(price, bool) or price <= 0:
            return None
        if not isinstance(timestamp, str) or not timestamp.strip():
            return None
        return float(price), timestamp

    def upsert(self, values: list[Any]) -> None:
        placeholders = ", ".join("?" for _ in values)
        sql = f"""
        INSERT INTO stock_fundamentals_snapshot (
          symbol, market_cap, pe_ttm, revenue_ttm, operating_income_ttm,
          pretax_income_ttm, income_tax_ttm, operating_cash_flow_ttm, capex_ttm,
          free_cash_flow_ttm, cash, short_term_investments, total_debt,
          shareholders_equity, roic_pct, fcf_margin_pct, debt_to_equity,
          accounting_as_of, market_as_of, accounting_source, market_source,
          accounting_filing_accession, accounting_refresh_status, net_income_ttm,
          diluted_eps_ttm, depreciation_amortization_ttm, shares_outstanding, updated_at
        ) VALUES ({placeholders})
        ON CONFLICT(symbol) DO UPDATE SET
          market_cap=excluded.market_cap, pe_ttm=excluded.pe_ttm,
          revenue_ttm=excluded.revenue_ttm, operating_income_ttm=excluded.operating_income_ttm,
          pretax_income_ttm=excluded.pretax_income_ttm, income_tax_ttm=excluded.income_tax_ttm,
          operating_cash_flow_ttm=excluded.operating_cash_flow_ttm, capex_ttm=excluded.capex_ttm,
          free_cash_flow_ttm=excluded.free_cash_flow_ttm, cash=excluded.cash,
          short_term_investments=excluded.short_term_investments, total_debt=excluded.total_debt,
          shareholders_equity=excluded.shareholders_equity, roic_pct=excluded.roic_pct,
          fcf_margin_pct=excluded.fcf_margin_pct, debt_to_equity=excluded.debt_to_equity,
          accounting_as_of=excluded.accounting_as_of, market_as_of=excluded.market_as_of,
          accounting_source=excluded.accounting_source, market_source=excluded.market_source,
          accounting_filing_accession=excluded.accounting_filing_accession,
          accounting_refresh_status=excluded.accounting_refresh_status,
          net_income_ttm=excluded.net_income_ttm, diluted_eps_ttm=excluded.diluted_eps_ttm,
          depreciation_amortization_ttm=excluded.depreciation_amortization_ttm,
          shares_outstanding=excluded.shares_outstanding,
          updated_at=excluded.updated_at
        """.strip()
        try:
            self._query(sql, values)
        except RuntimeError as exc:
            if str(exc) == "d1_query_failed":
                raise RuntimeError("d1_write_failed") from exc
            raise

    def upsert_annual(self, rows: list[tuple[str, AnnualFundamental]]) -> None:
        if not rows:
            return
        values = [annual_values(symbol, row) for symbol, row in rows]
        placeholders = ", ".join("(" + ", ".join("?" for _ in ANNUAL_COLUMNS) + ")" for _ in values)
        sql = f"""
        INSERT INTO stock_fundamentals_annual ({", ".join(ANNUAL_COLUMNS)})
        VALUES {placeholders}
        ON CONFLICT(symbol, fiscal_year) DO UPDATE SET
          revenue=excluded.revenue, operating_income=excluded.operating_income,
          pretax_income=excluded.pretax_income, income_tax=excluded.income_tax,
          net_income=excluded.net_income, diluted_eps=excluded.diluted_eps,
          operating_cash_flow=excluded.operating_cash_flow, capex=excluded.capex,
          free_cash_flow=excluded.free_cash_flow,
          depreciation_amortization=excluded.depreciation_amortization, cash=excluded.cash,
          total_debt=excluded.total_debt, shareholders_equity=excluded.shareholders_equity,
          shares_outstanding=excluded.shares_outstanding, as_of=excluded.as_of,
          source=excluded.source
        """.strip()
        self._query(sql, [item for row in values for item in row])
