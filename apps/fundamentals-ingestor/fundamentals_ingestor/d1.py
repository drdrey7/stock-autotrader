"""Small Cloudflare D1 HTTP writer."""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any

from .edgar import AnnualFundamental
from .finnhub import MarketData
from .metrics import AccountingInputs

ENDPOINT = "https://api.cloudflare.com/client/v4/accounts/{account_id}/d1/database/{database_id}/query"


def _value(value: float | str | None) -> float | str | None:
    return value


SNAPSHOT_COLUMNS = (
    "symbol", "market_cap", "pe_ttm", "beta", "eps_ttm", "dividend_yield",
    "revenue_ttm", "operating_income_ttm", "pretax_income_ttm", "income_tax_ttm",
    "net_income_ttm", "diluted_eps_ttm", "depreciation_amortization_ttm",
    "operating_cash_flow_ttm", "capex_ttm", "free_cash_flow_ttm", "cash",
    "short_term_investments", "total_debt", "shareholders_equity", "shares_outstanding",
    "current_assets", "current_liabilities", "accounting_as_of", "accounting_filing_accession",
    "accounting_filing_form", "accounting_refresh_status", "accounting_periods_compatible", "accounting_source",
    "market_checked_at", "market_source", "updated_at",
)


def snapshot_values(
    symbol: str,
    market: MarketData | None,
    accounting: AccountingInputs,
    updated_at: str,
    accounting_filing_accession: str | None = None,
    accounting_filing_form: str | None = None,
) -> list[Any]:
    return [
        symbol,
        _value(market.market_cap if market else None),
        _value(market.pe_ttm if market else None),
        _value(market.beta if market else None),
        _value(market.eps_ttm if market else None),
        _value(market.dividend_yield if market else None),
        _value(accounting.revenue_ttm),
        _value(accounting.operating_income_ttm),
        _value(accounting.pretax_income_ttm),
        _value(accounting.income_tax_ttm),
        _value(accounting.net_income_ttm),
        _value(accounting.diluted_eps_ttm),
        _value(accounting.depreciation_amortization_ttm),
        _value(accounting.operating_cash_flow_ttm),
        _value(accounting.capex_ttm),
        _value(accounting.free_cash_flow_ttm),
        _value(accounting.cash),
        _value(accounting.short_term_investments),
        _value(accounting.total_debt),
        _value(accounting.shareholders_equity),
        _value(accounting.shares_outstanding),
        _value(accounting.current_assets),
        _value(accounting.current_liabilities),
        _value(accounting.accounting_as_of),
        _value(accounting_filing_accession),
        _value(accounting_filing_form),
        _value(accounting.extraction_status),
        1 if accounting.periods_compatible else 0,
        "edgartools",
        _value(market.checked_at if market else None),
        "finnhub",
        updated_at,
    ]


ANNUAL_COLUMNS = (
    "symbol", "fiscal_year", "revenue", "operating_income", "pretax_income", "income_tax",
    "net_income", "diluted_eps", "operating_cash_flow", "capex", "free_cash_flow",
    "depreciation_amortization", "cash", "total_debt", "shareholders_equity",
    "shares_outstanding", "current_assets", "current_liabilities", "as_of", "source",
)


def annual_values(symbol: str, row: AnnualFundamental) -> list[Any]:
    return [
        symbol, row.fiscal_year, row.revenue, row.operating_income, row.pretax_income,
        row.income_tax, row.net_income, row.diluted_eps, row.operating_cash_flow,
        row.capex, row.free_cash_flow, row.depreciation_amortization, row.cash,
        row.total_debt, row.shareholders_equity, row.shares_outstanding,
        row.current_assets, row.current_liabilities, row.as_of, row.source,
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

    def upsert(self, values: list[Any]) -> None:
        placeholders = ", ".join("?" for _ in values)
        sql = f"""
        INSERT INTO stock_fundamentals_snapshot (
          {", ".join(SNAPSHOT_COLUMNS)}
        ) VALUES ({placeholders})
        ON CONFLICT(symbol) DO UPDATE SET
          market_cap=excluded.market_cap, pe_ttm=excluded.pe_ttm,
          beta=excluded.beta, eps_ttm=excluded.eps_ttm, dividend_yield=excluded.dividend_yield,
          revenue_ttm=excluded.revenue_ttm, operating_income_ttm=excluded.operating_income_ttm,
          pretax_income_ttm=excluded.pretax_income_ttm, income_tax_ttm=excluded.income_tax_ttm,
          net_income_ttm=excluded.net_income_ttm, diluted_eps_ttm=excluded.diluted_eps_ttm,
          depreciation_amortization_ttm=excluded.depreciation_amortization_ttm,
          operating_cash_flow_ttm=excluded.operating_cash_flow_ttm, capex_ttm=excluded.capex_ttm,
          free_cash_flow_ttm=excluded.free_cash_flow_ttm, cash=excluded.cash,
          short_term_investments=excluded.short_term_investments, total_debt=excluded.total_debt,
          shareholders_equity=excluded.shareholders_equity, shares_outstanding=excluded.shares_outstanding,
          current_assets=excluded.current_assets, current_liabilities=excluded.current_liabilities,
          accounting_as_of=excluded.accounting_as_of,
          accounting_filing_accession=excluded.accounting_filing_accession,
          accounting_filing_form=excluded.accounting_filing_form,
          accounting_refresh_status=excluded.accounting_refresh_status,
          accounting_periods_compatible=excluded.accounting_periods_compatible,
          accounting_source=excluded.accounting_source, market_checked_at=excluded.market_checked_at,
          market_source=excluded.market_source,
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
        if len(rows) > 5 or len({symbol for symbol, _ in rows}) != 1:
            raise RuntimeError("annual_history_window_invalid")
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
          shares_outstanding=excluded.shares_outstanding,
          current_assets=excluded.current_assets, current_liabilities=excluded.current_liabilities,
          as_of=excluded.as_of,
          source=excluded.source
        """.strip()
        self._query(sql, [item for row in values for item in row])
        years = [row.fiscal_year for _, row in rows]
        year_placeholders = ", ".join("?" for _ in years)
        self._query(
            f"DELETE FROM stock_fundamentals_annual WHERE symbol = ? AND fiscal_year NOT IN ({year_placeholders})",
            [rows[0][0], *years],
        )

    def get_annual_years(self, symbol: str) -> set[int]:
        rows = self._query(
            "SELECT fiscal_year FROM stock_fundamentals_annual WHERE symbol = ? ORDER BY fiscal_year DESC",
            [symbol],
        )
        return {
            int(row["fiscal_year"])
            for row in rows
            if isinstance(row, dict) and isinstance(row.get("fiscal_year"), (int, float))
        }

    def upsert_fx_rates(
        self,
        rates: dict[tuple[str, str], float],
        rates_as_of: str | None,
        updated_at: str,
    ) -> None:
        """Idempotently persist base->counter FX rates for the Core Universe pairs.

        Rates are keyed by (base_currency, counter_currency). ``rate`` is the
        number of ``counter_currency`` units per ``base_currency`` unit (e.g.
        base=USD, counter=TWD, rate=31.85 means 31.85 TWD per 1 USD directly).
        A failed provider fetch must NOT clear stored rates, so this is only
        called with a freshly fetched set.
        """
        for (base, counter), rate in rates.items():
            if not isinstance(rate, (int, float)) or rate <= 0:
                continue
            self._query(
                """
                INSERT INTO fx_rates (base_currency, counter_currency, rate, as_of, updated_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(base_currency, counter_currency) DO UPDATE SET
                  rate=excluded.rate, as_of=COALESCE(excluded.as_of, fx_rates.as_of),
                  updated_at=excluded.updated_at
                """,
                [base, counter, rate, rates_as_of, updated_at],
            )

    def get_fx_rates(self) -> dict[tuple[str, str], float]:
        """Read last-known-good rates. Empty dict when none have ever been stored."""
        rows = self._query("SELECT base_currency, counter_currency, rate FROM fx_rates")
        rates: dict[tuple[str, str], float] = {}
        for row in rows:
            if not isinstance(row, dict):
                continue
            base = row.get("base_currency")
            counter = row.get("counter_currency")
            rate = row.get("rate")
            if isinstance(base, str) and isinstance(counter, str) and isinstance(rate, (int, float)) and rate > 0:
                rates[(base, counter)] = float(rate)
        return rates

    def get_fx_last_as_of(self) -> str | None:
        """Most recently persisted ``as_of`` source date, for LKG freshness logging."""
        rows = self._query("SELECT as_of FROM fx_rates ORDER BY updated_at DESC LIMIT 1")
        for row in rows:
            if isinstance(row, dict) and isinstance(row.get("as_of"), str) and row["as_of"]:
                return row["as_of"]
        return None
