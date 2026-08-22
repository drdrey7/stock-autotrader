"""EdgarTools adapter; no SEC/XBRL parsing is implemented here."""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import date
from typing import Any

from .metrics import AccountingInputs

INCOME_LABELS = {
    "revenue_ttm": ("Total Revenue", "Revenue", "Revenues"),
    "operating_income_ttm": ("Operating Income (Loss)", "Operating Income"),
    "pretax_income_ttm": (
        "Income (Loss) from Continuing Operations before Income Taxes, Noncontrolling Interest",
        "Income (Loss) Before Income Taxes",
        "Income Before Tax",
    ),
    "income_tax_ttm": ("Income Tax Expense (Benefit)", "Income Tax Expense"),
}
OCF_LABELS = ("Net Cash Provided by (Used in) Operating Activities", "Operating Cash Flow")
CAPEX_LABELS = ("Payments to Acquire Property, Plant, and Equipment", "Capital Expenditures")
RELEVANT_FILING_FORMS = [
    "10-K", "10-K/A", "10-Q", "10-Q/A", "20-F", "20-F/A", "6-K", "6-K/A",
]


@dataclass(frozen=True)
class FilingMetadata:
    accession: str | None
    period_of_report: str | None


def _finite(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _rows(statement: Any) -> list[dict[str, Any]]:
    if statement is None:
        return []
    frame = statement.to_dataframe()
    if hasattr(frame, "reset_index"):
        frame = frame.reset_index()
    if hasattr(frame, "to_dict"):
        return list(frame.to_dict(orient="records"))
    return []


def _period_columns(row: dict[str, Any]) -> list[str]:
    ignored = {"index", "label", "depth", "is_total", "is_abstract", "section", "confidence", "concept"}
    return [key for key in row if key not in ignored and isinstance(key, str)]


def _latest_value(row: dict[str, Any], preferred_period: str | None = None) -> float | None:
    keys = _period_columns(row)
    if preferred_period in row:
        return _finite(row[preferred_period])
    for key in keys:
        value = _finite(row[key])
        if value is not None:
            return value
    return None


def _find(rows: list[dict[str, Any]], labels: tuple[str, ...], preferred_period: str | None = None) -> float | None:
    wanted = {label.casefold() for label in labels}
    for row in rows:
        label = row.get("label")
        if isinstance(label, str) and label.casefold() in wanted:
            return _latest_value(row, preferred_period)
    return None


def _balance_value(rows: list[dict[str, Any]], concepts: tuple[str, ...], labels: tuple[str, ...], period: str | None) -> float | None:
    concept_set = {concept.casefold() for concept in concepts}
    label_set = {label.casefold() for label in labels}
    for row in rows:
        concept = row.get("concept")
        label = row.get("label")
        if (isinstance(concept, str) and concept.casefold() in concept_set) or (isinstance(label, str) and label.casefold() in label_set):
            return _latest_value(row, period)
    return None


def _period_ref(statement: Any) -> tuple[int, str] | None:
    periods = getattr(statement, "periods", None) or []
    raw = periods[0] if periods else None
    if isinstance(raw, tuple) and len(raw) == 2:
        try:
            return int(raw[0]), str(raw[1]).upper()
        except (TypeError, ValueError):
            return None
    if not isinstance(raw, str):
        return None
    parts = raw.upper().replace("FY ", "FY ").split()
    if len(parts) == 2 and parts[0] in {"FY", "Q1", "Q2", "Q3", "Q4"}:
        try:
            return int(parts[1]), parts[0]
        except ValueError:
            return None
    return None


def _first_period(statement: Any) -> Any:
    periods = getattr(statement, "periods", None) or []
    return periods[0] if periods else None


def periods_compatible(ttm_statement: Any, balance_statement: Any) -> bool:
    ttm = _period_ref(ttm_statement)
    balance = _period_ref(balance_statement)
    if not ttm or not balance or ttm[0] != balance[0]:
        return False
    if balance[1] == "FY":
        return ttm[1] == "Q4"
    return balance[1] == ttm[1]


def _filing_as_of(company: Any, annual: bool) -> str | None:
    forms = ["10-K", "10-K/A", "20-F", "20-F/A"] if annual else ["10-Q", "10-Q/A", "6-K", "6-K/A"]
    try:
        filing = company.get_filings(form=forms, amendments=True).latest()
        period = getattr(filing, "period_of_report", None)
        if isinstance(period, date):
            return period.isoformat()
        if isinstance(period, str) and len(period) >= 10:
            return period[:10]
    except Exception:
        return None
    return None


def fetch_latest_filing_metadata(symbol: str, identity: str) -> FilingMetadata:
    """Read only the latest relevant filing identity for refresh detection."""
    from edgar import Company, set_identity

    set_identity(identity)
    try:
        filing = Company(symbol).get_filings(
            form=RELEVANT_FILING_FORMS,
            amendments=True,
        ).latest()
    except Exception:
        return FilingMetadata(None, None)
    if filing is None:
        return FilingMetadata(None, None)
    accession = None
    for field in ("accession_number", "accession_no", "accession"):
        value = getattr(filing, field, None)
        if isinstance(value, str) and value.strip():
            accession = value.strip()
            break
    period = getattr(filing, "period_of_report", None)
    if isinstance(period, date):
        period = period.isoformat()
    elif isinstance(period, str) and len(period) >= 10:
        period = period[:10]
    else:
        period = None
    return FilingMetadata(accession, period)


def fetch_accounting_inputs(symbol: str, identity: str, filing: FilingMetadata | None = None) -> AccountingInputs:
    """Fetch only the statements needed by this PR through EdgarTools."""
    from edgar import Company, set_identity

    set_identity(identity)
    company = Company(symbol)
    income = company.income_statement(period="ttm")
    cashflow = company.cash_flow_statement(period="ttm")
    annual_balance = company.balance_sheet(period="annual", periods=1)
    balance = annual_balance if periods_compatible(income, annual_balance) else company.balance_sheet(period="quarterly", periods=1)
    compatible = periods_compatible(income, balance)
    income_rows = _rows(income)
    cash_rows = _rows(cashflow)
    balance_rows = _rows(balance)
    income_period = _first_period(income)
    balance_period = _first_period(balance)
    balance_period_name = balance_period if isinstance(balance_period, str) else None
    balance_ref = _period_ref(balance)
    annual_balance = bool(balance_ref and balance_ref[1] == "FY")

    capex = _find(cash_rows, CAPEX_LABELS, income_period if isinstance(income_period, str) else None)
    if capex is not None:
        capex = abs(capex)

    total_debt = _balance_value(
        balance_rows,
        ("Debt", "LongTermDebt"),
        ("Total Debt", "Debt"),
        balance_period_name,
    )
    if total_debt is None:
        current = _balance_value(balance_rows, ("LongTermDebtCurrent", "DebtCurrent"), ("Long-term Debt, Current Maturities",), balance_period_name)
        noncurrent = _balance_value(balance_rows, ("LongTermDebtNoncurrent", "LongTermDebt"), ("Long-term Debt, Excluding Current Maturities",), balance_period_name)
        if current is not None and noncurrent is not None:
            total_debt = current + noncurrent

    return AccountingInputs(
        revenue_ttm=_find(income_rows, INCOME_LABELS["revenue_ttm"], income_period if isinstance(income_period, str) else None),
        operating_income_ttm=_find(income_rows, INCOME_LABELS["operating_income_ttm"], income_period if isinstance(income_period, str) else None),
        pretax_income_ttm=_find(income_rows, INCOME_LABELS["pretax_income_ttm"], income_period if isinstance(income_period, str) else None),
        income_tax_ttm=_find(income_rows, INCOME_LABELS["income_tax_ttm"], income_period if isinstance(income_period, str) else None),
        operating_cash_flow_ttm=_find(cash_rows, OCF_LABELS, income_period if isinstance(income_period, str) else None),
        capex_ttm=capex,
        cash=_balance_value(balance_rows, ("CashAndCashEquivalentsAtCarryingValue",), ("Cash and Cash Equivalents",), balance_period_name),
        short_term_investments=_balance_value(balance_rows, ("ShortTermInvestments",), ("Short-term Investments",), balance_period_name),
        total_debt=total_debt,
        shareholders_equity=_balance_value(balance_rows, ("StockholdersEquity",), ("Stockholders' Equity Attributable to Parent", "Total Stockholders' Equity"), balance_period_name),
        accounting_as_of=filing.period_of_report if filing else _filing_as_of(company, annual=annual_balance),
        periods_compatible=compatible,
    )
