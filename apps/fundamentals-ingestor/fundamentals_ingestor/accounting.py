"""Safe accounting fallback around the EdgarTools statement adapter."""

from __future__ import annotations

from typing import Any

from . import edgar as provider
from .metrics import AccountingInputs

FOREIGN_FORMS = {"20-F", "20-F/A", "6-K", "6-K/A"}


class AccountingUnsupportedError(RuntimeError):
    """The provider cannot expose a safe current-period accounting basis."""


def _period_ref_from_column(value: Any) -> tuple[int, str] | None:
    if not isinstance(value, str):
        return None
    parts = value.upper().split()
    if len(parts) != 2 or parts[0] not in {"Q1", "Q2", "Q3", "Q4"}:
        return None
    try:
        return int(parts[1]), parts[0]
    except ValueError:
        return None


def _quarter_index(ref: tuple[int, str]) -> int:
    return ref[0] * 4 + int(ref[1][1]) - 1


def _quarterly_window(rows: list[dict[str, Any]]) -> list[str] | None:
    columns: dict[tuple[int, str], str] = {}
    for row in rows:
        for column in provider._period_columns(row):
            ref = _period_ref_from_column(column)
            if ref is not None:
                columns.setdefault(ref, column)
    if len(columns) < 4:
        return None
    refs = sorted(columns, key=_quarter_index, reverse=True)[:4]
    indexes = [_quarter_index(ref) for ref in refs]
    if indexes != list(range(indexes[0], indexes[0] - 4, -1)):
        return None
    return [columns[ref] for ref in refs]


def _sum_find(rows: list[dict[str, Any]], labels: tuple[str, ...], periods: list[str]) -> float | None:
    wanted = {label.casefold() for label in labels}
    for row in rows:
        label = row.get("label")
        if not isinstance(label, str) or label.casefold() not in wanted:
            continue
        values = [provider._finite(row.get(period)) for period in periods]
        if any(value is None for value in values):
            return None
        return sum(value for value in values if value is not None)
    return None


def _unsupported_or_incomplete(filing: provider.FilingMetadata | None) -> None:
    form = filing.form if filing else None
    if form in FOREIGN_FORMS:
        raise AccountingUnsupportedError("accounting_quarterly_basis_unsupported")
    raise RuntimeError("accounting_statement_incomplete")


def _fetch_quarterly_fallback(
    symbol: str,
    identity: str,
    filing: provider.FilingMetadata | None,
) -> AccountingInputs:
    from edgar import Company, set_identity

    set_identity(identity)
    company = Company(symbol)
    income = company.income_statement(period="quarterly", periods=4)
    cashflow = company.cash_flow_statement(period="quarterly", periods=4)
    income_rows = provider._rows(income)
    cash_rows = provider._rows(cashflow)
    income_periods = _quarterly_window(income_rows)
    cash_periods = _quarterly_window(cash_rows)
    if not income_rows or not cash_rows or income_periods is None or cash_periods is None:
        _unsupported_or_incomplete(filing)

    income_refs = [_period_ref_from_column(period) for period in income_periods]
    cash_refs = [_period_ref_from_column(period) for period in cash_periods]
    if income_refs != cash_refs:
        _unsupported_or_incomplete(filing)

    annual_balance = company.balance_sheet(period="annual", periods=1)
    balance = (
        annual_balance
        if provider.periods_compatible(income, annual_balance)
        else company.balance_sheet(period="quarterly", periods=1)
    )
    balance_rows = provider._rows(balance)
    if not balance_rows:
        _unsupported_or_incomplete(filing)

    compatible = provider.periods_compatible(income, balance)
    balance_period = provider._first_period(balance)
    balance_period_name = balance_period if isinstance(balance_period, str) else None
    balance_ref = provider._period_ref(balance)
    annual_balance_selected = bool(balance_ref and balance_ref[1] == "FY")

    capex = _sum_find(cash_rows, provider.CAPEX_LABELS, cash_periods)
    if capex is None:
        capex = provider._fact_ttm_value(company, provider.CAPEX_FACT_CONCEPTS)
    if capex is not None:
        capex = abs(capex)

    total_debt = provider._balance_value(
        balance_rows,
        ("Debt", "LongTermDebt"),
        ("Total Debt", "Debt"),
        balance_period_name,
    )
    if total_debt is None:
        current = provider._balance_value(
            balance_rows,
            ("LongTermDebtCurrent", "DebtCurrent"),
            ("Long-term Debt, Current Maturities",),
            balance_period_name,
        )
        noncurrent = provider._balance_value(
            balance_rows,
            ("LongTermDebtNoncurrent", "LongTermDebt"),
            ("Long-term Debt, Excluding Current Maturities",),
            balance_period_name,
        )
        if current is not None and noncurrent is not None:
            total_debt = current + noncurrent

    fact_rows: list[dict[str, Any]] | None = None
    if total_debt is None:
        fact_rows = provider._fact_rows(company)
        current = provider._fact_value(fact_rows, provider.DEBT_CURRENT_FACT_CONCEPTS, balance_ref)
        noncurrent = provider._fact_value(fact_rows, provider.DEBT_NONCURRENT_FACT_CONCEPTS, balance_ref)
        if current is not None and noncurrent is not None:
            total_debt = current + noncurrent

    cash = provider._balance_value(
        balance_rows,
        ("CashAndCashEquivalentsAtCarryingValue",),
        ("Cash and Cash Equivalents",),
        balance_period_name,
    )
    short_term_investments = provider._balance_value(
        balance_rows,
        ("ShortTermInvestments",),
        ("Short-term Investments",),
        balance_period_name,
    )
    if short_term_investments is None:
        if fact_rows is None:
            fact_rows = provider._fact_rows(company)
        short_term_investments = provider._fact_value(
            fact_rows,
            (provider.MARKETABLE_SECURITIES_CURRENT_CONCEPT,),
            balance_ref,
        )
        if short_term_investments is None:
            marketable_debt = provider._fact_value(
                fact_rows,
                (provider.SHORT_TERM_INVESTMENT_FACT_CONCEPTS[0],),
                balance_ref,
            )
            marketable_equity = provider._fact_value(
                fact_rows,
                (provider.SHORT_TERM_INVESTMENT_FACT_CONCEPTS[1],),
                balance_ref,
            )
            if marketable_debt is not None and marketable_equity is not None:
                short_term_investments = marketable_debt + marketable_equity

    revenue = _sum_find(income_rows, provider.INCOME_LABELS["revenue_ttm"], income_periods)
    if revenue is None:
        revenue = provider._fact_ttm_value(company, provider.INCOME_FACT_CONCEPTS["revenue_ttm"])
    pretax_income = _sum_find(income_rows, provider.INCOME_LABELS["pretax_income_ttm"], income_periods)
    if pretax_income is None:
        pretax_income = provider._fact_ttm_value(company, provider.INCOME_FACT_CONCEPTS["pretax_income_ttm"])

    net_income = _sum_find(
        income_rows,
        ("Net Income", "Net Income (Loss)", "Net Income Attributable to Parent"),
        income_periods,
    )
    if net_income is None:
        net_income = provider._fact_ttm_value(company, provider.NET_INCOME_FACT_CONCEPTS)
    diluted_eps = provider._fact_ttm_value(company, provider.EPS_FACT_CONCEPTS)
    depreciation = _sum_find(
        cash_rows,
        ("Depreciation, Depletion and Amortization", "Depreciation and Amortization", "Depreciation"),
        cash_periods,
    )
    if depreciation is None:
        depreciation = provider._fact_ttm_value(company, provider.D_AND_A_FACT_CONCEPTS)

    if fact_rows is None:
        fact_rows = provider._fact_rows(company)
    filed_as_of = None
    if filing:
        filed_as_of = filing.filed_date or filing.period_of_report
    shares = provider._share_fact_value(
        fact_rows + provider._share_fact_rows(company),
        provider.SHARES_FACT_CONCEPTS,
        filed_as_of,
    )
    operating_cash_flow = _sum_find(cash_rows, provider.OCF_LABELS, cash_periods)
    free_cash_flow = operating_cash_flow - capex if operating_cash_flow is not None and capex is not None else None

    return AccountingInputs(
        revenue_ttm=revenue,
        operating_income_ttm=_sum_find(
            income_rows,
            provider.INCOME_LABELS["operating_income_ttm"],
            income_periods,
        ),
        pretax_income_ttm=pretax_income,
        income_tax_ttm=_sum_find(
            income_rows,
            provider.INCOME_LABELS["income_tax_ttm"],
            income_periods,
        ),
        operating_cash_flow_ttm=operating_cash_flow,
        capex_ttm=capex,
        free_cash_flow_ttm=free_cash_flow,
        cash=cash,
        short_term_investments=short_term_investments,
        total_debt=total_debt,
        shareholders_equity=provider._balance_value(
            balance_rows,
            ("StockholdersEquity",),
            ("Stockholders' Equity Attributable to Parent", "Total Stockholders' Equity"),
            balance_period_name,
        ),
        net_income_ttm=net_income,
        diluted_eps_ttm=diluted_eps,
        depreciation_amortization_ttm=depreciation,
        shares_outstanding=shares,
        current_assets=provider._balance_value(
            balance_rows,
            provider.CURRENT_ASSETS_CONCEPTS,
            provider.CURRENT_ASSETS_LABELS,
            balance_period_name,
        ),
        current_liabilities=provider._balance_value(
            balance_rows,
            provider.CURRENT_LIABILITIES_CONCEPTS,
            provider.CURRENT_LIABILITIES_LABELS,
            balance_period_name,
        ),
        accounting_as_of=(
            filing.period_of_report
            if filing
            else provider._filing_as_of(company, annual=annual_balance_selected)
        ),
        periods_compatible=compatible,
    )


def fetch_accounting_inputs(
    symbol: str,
    identity: str,
    filing: provider.FilingMetadata | None = None,
) -> AccountingInputs:
    """Use native TTM first, then a fail-closed four-quarter fallback."""
    try:
        return provider.fetch_accounting_inputs(symbol, identity, filing)
    except RuntimeError as exc:
        if str(exc) != "accounting_statement_incomplete":
            raise
    return _fetch_quarterly_fallback(symbol, identity, filing)
