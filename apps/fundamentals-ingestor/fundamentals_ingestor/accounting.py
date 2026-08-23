"""Safe accounting fallback around the EdgarTools statement adapter."""

from __future__ import annotations

from typing import Any

from . import edgar as provider
from .metrics import AccountingInputs

FOREIGN_FORMS = {"20-F", "20-F/A", "6-K", "6-K/A"}
OPERATING_INCOME_FACT_CONCEPTS = ("us-gaap:OperatingIncomeLoss",)
INCOME_TAX_FACT_CONCEPTS = ("us-gaap:IncomeTaxExpenseBenefit",)
OPERATING_CASH_FLOW_FACT_CONCEPTS = (
    "us-gaap:NetCashProvidedByUsedInOperatingActivities",
    "us-gaap:NetCashProvidedByUsedInOperatingActivitiesContinuingOperations",
)


class AccountingUnsupportedError(RuntimeError):
    """The provider cannot expose a safe current-period accounting basis."""


def _unsupported_or_incomplete(filing: provider.FilingMetadata | None) -> None:
    form = filing.form if filing else None
    if form in FOREIGN_FORMS:
        raise AccountingUnsupportedError("accounting_current_basis_unsupported")
    raise RuntimeError("accounting_statement_incomplete")


def _balance_inputs(
    company: Any,
    balance: Any,
    filing: provider.FilingMetadata | None,
) -> tuple[
    float | None,
    float | None,
    float | None,
    float | None,
    float | None,
    float | None,
    float | None,
    float | None,
]:
    balance_rows = provider._rows(balance)
    if not balance_rows:
        _unsupported_or_incomplete(filing)

    balance_period = provider._first_period(balance)
    balance_period_name = balance_period if isinstance(balance_period, str) else None
    balance_ref = provider._period_ref(balance)

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

    shareholders_equity = provider._balance_value(
        balance_rows,
        ("StockholdersEquity",),
        ("Stockholders' Equity Attributable to Parent", "Total Stockholders' Equity"),
        balance_period_name,
    )
    current_assets = provider._balance_value(
        balance_rows,
        provider.CURRENT_ASSETS_CONCEPTS,
        provider.CURRENT_ASSETS_LABELS,
        balance_period_name,
    )
    current_liabilities = provider._balance_value(
        balance_rows,
        provider.CURRENT_LIABILITIES_CONCEPTS,
        provider.CURRENT_LIABILITIES_LABELS,
        balance_period_name,
    )

    if fact_rows is None:
        fact_rows = provider._fact_rows(company)
    filed_as_of = (filing.filed_date or filing.period_of_report) if filing else None
    shares = provider._share_fact_value(
        fact_rows + provider._share_fact_rows(company),
        provider.SHARES_FACT_CONCEPTS,
        filed_as_of,
    )
    return (
        cash,
        short_term_investments,
        total_debt,
        shareholders_equity,
        shares,
        current_assets,
        current_liabilities,
        balance_ref,
    )


def _fetch_normalized_facts_fallback(
    symbol: str,
    identity: str,
    filing: provider.FilingMetadata | None,
) -> AccountingInputs:
    """Use EdgarTools' duration-aware TTM facts, never sums of statement columns."""
    if filing and filing.form in FOREIGN_FORMS:
        raise AccountingUnsupportedError("accounting_current_basis_unsupported")

    from edgar import Company, set_identity

    set_identity(identity)
    company = Company(symbol)

    # Quarterly statement values can be discrete or year-to-date depending on
    # the issuer/presentation. Use the statement only as a period anchor. Flow
    # values below come exclusively from EdgarTools' duration-aware get_ttm().
    period_anchor = company.income_statement(period="quarterly", periods=1)
    if not provider._rows(period_anchor) or provider._period_ref(period_anchor) is None:
        _unsupported_or_incomplete(filing)

    annual_balance = company.balance_sheet(period="annual", periods=1)
    balance = (
        annual_balance
        if provider.periods_compatible(period_anchor, annual_balance)
        else company.balance_sheet(period="quarterly", periods=1)
    )
    if not provider.periods_compatible(period_anchor, balance):
        _unsupported_or_incomplete(filing)

    (
        cash,
        short_term_investments,
        total_debt,
        shareholders_equity,
        shares,
        current_assets,
        current_liabilities,
        _balance_ref,
    ) = _balance_inputs(company, balance, filing)

    revenue = provider._fact_ttm_value(company, provider.INCOME_FACT_CONCEPTS["revenue_ttm"])
    operating_income = provider._fact_ttm_value(company, OPERATING_INCOME_FACT_CONCEPTS)
    pretax_income = provider._fact_ttm_value(company, provider.INCOME_FACT_CONCEPTS["pretax_income_ttm"])
    income_tax = provider._fact_ttm_value(company, INCOME_TAX_FACT_CONCEPTS)
    net_income = provider._fact_ttm_value(company, provider.NET_INCOME_FACT_CONCEPTS)
    diluted_eps = provider._fact_ttm_value(company, provider.EPS_FACT_CONCEPTS)
    depreciation = provider._fact_ttm_value(company, provider.D_AND_A_FACT_CONCEPTS)
    operating_cash_flow = provider._fact_ttm_value(company, OPERATING_CASH_FLOW_FACT_CONCEPTS)
    capex = provider._fact_ttm_value(company, provider.CAPEX_FACT_CONCEPTS)
    if capex is not None:
        capex = abs(capex)
    free_cash_flow = operating_cash_flow - capex if operating_cash_flow is not None and capex is not None else None

    # A fallback with no duration-aware flow evidence is not a successful
    # extraction. Individual metrics may still be legitimately nullable.
    if all(
        value is None
        for value in (
            revenue,
            operating_income,
            pretax_income,
            income_tax,
            net_income,
            operating_cash_flow,
            capex,
        )
    ):
        _unsupported_or_incomplete(filing)

    return AccountingInputs(
        revenue_ttm=revenue,
        operating_income_ttm=operating_income,
        pretax_income_ttm=pretax_income,
        income_tax_ttm=income_tax,
        operating_cash_flow_ttm=operating_cash_flow,
        capex_ttm=capex,
        free_cash_flow_ttm=free_cash_flow,
        cash=cash,
        short_term_investments=short_term_investments,
        total_debt=total_debt,
        shareholders_equity=shareholders_equity,
        net_income_ttm=net_income,
        diluted_eps_ttm=diluted_eps,
        depreciation_amortization_ttm=depreciation,
        shares_outstanding=shares,
        current_assets=current_assets,
        current_liabilities=current_liabilities,
        accounting_as_of=filing.period_of_report if filing else provider._filing_as_of(company, annual=False),
        periods_compatible=True,
    )


def fetch_accounting_inputs(
    symbol: str,
    identity: str,
    filing: provider.FilingMetadata | None = None,
) -> AccountingInputs:
    """Use native statements first, then a normalized-facts fail-closed fallback."""
    try:
        return provider.fetch_accounting_inputs(symbol, identity, filing)
    except RuntimeError as exc:
        if str(exc) != "accounting_statement_incomplete":
            raise
    return _fetch_normalized_facts_fallback(symbol, identity, filing)
