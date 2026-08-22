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
INCOME_FACT_CONCEPTS = {
    "revenue_ttm": ("us-gaap:Revenues", "us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax"),
    "pretax_income_ttm": (
        "us-gaap:IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments",
        "us-gaap:IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest",
    ),
}
NET_INCOME_FACT_CONCEPTS = ("us-gaap:NetIncomeLoss", "us-gaap:ProfitLoss")
EPS_FACT_CONCEPTS = ("us-gaap:EarningsPerShareDiluted",)
D_AND_A_FACT_CONCEPTS = (
    "us-gaap:DepreciationDepletionAndAmortization",
    "us-gaap:Depreciation",
    "us-gaap:DepreciationDepletionAndAmortizationPropertyPlantAndEquipment",
)
SHARES_FACT_CONCEPTS = (
    "dei:EntityCommonStockSharesOutstanding",
    "us-gaap:CommonStockSharesOutstanding",
)
OCF_LABELS = ("Net Cash Provided by (Used in) Operating Activities", "Operating Cash Flow")
CAPEX_LABELS = ("Payments to Acquire Property, Plant, and Equipment", "Capital Expenditures")
CAPEX_FACT_CONCEPTS = ("us-gaap:PaymentsToAcquireProductiveAssets",)
SHORT_TERM_INVESTMENT_FACT_CONCEPTS = (
    "us-gaap:DebtSecuritiesCurrent",
    "us-gaap:EquitySecuritiesFvNi",
)
DEBT_CURRENT_FACT_CONCEPTS = ("us-gaap:DebtCurrent", "us-gaap:LongTermDebtCurrent")
DEBT_NONCURRENT_FACT_CONCEPTS = ("us-gaap:LongTermDebtNoncurrent", "us-gaap:LongTermDebt")
MARKETABLE_SECURITIES_CURRENT_CONCEPT = "us-gaap:MarketableSecuritiesCurrent"
RELEVANT_FILING_FORMS = [
    "10-K", "10-K/A", "10-Q", "10-Q/A", "20-F", "20-F/A", "6-K", "6-K/A",
]


@dataclass(frozen=True)
class FilingMetadata:
    accession: str | None
    period_of_report: str | None
    form: str | None = None


@dataclass(frozen=True)
class AnnualFundamental:
    fiscal_year: int
    revenue: float | None
    operating_income: float | None
    pretax_income: float | None
    income_tax: float | None
    net_income: float | None
    diluted_eps: float | None
    operating_cash_flow: float | None
    capex: float | None
    free_cash_flow: float | None
    depreciation_amortization: float | None
    cash: float | None
    total_debt: float | None
    shareholders_equity: float | None
    shares_outstanding: float | None
    as_of: str | None
    source: str = "edgartools"


class FilingLookupError(RuntimeError):
    """The filing provider could not answer the refresh-detection lookup."""


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


def _fact_rows(company: Any) -> list[dict[str, Any]]:
    try:
        facts = getattr(company, "facts", None)
    except Exception:
        return []
    if facts is None or not hasattr(facts, "to_dataframe"):
        return []
    frame = facts.to_dataframe()
    if hasattr(frame, "to_dict"):
        return list(frame.to_dict(orient="records"))
    return []


def _fact_value(rows: list[dict[str, Any]], concepts: tuple[str, ...], period_ref: tuple[int, str] | None) -> float | None:
    if not period_ref:
        return None
    wanted = {concept.casefold() for concept in concepts}
    matches = [
        row for row in rows
        if isinstance(row.get("concept"), str)
        and row["concept"].casefold() in wanted
        and row.get("period_type") == "instant"
        and row.get("fiscal_year") == period_ref[0]
        and row.get("fiscal_period") == period_ref[1]
    ]
    matches.sort(key=lambda row: str(row.get("period_end") or ""))
    for row in reversed(matches):
        value = _finite(row.get("numeric_value", row.get("value")))
        if value is not None:
            return value
    return None


def _fact_ttm_value(company: Any, concepts: tuple[str, ...]) -> float | None:
    try:
        facts = getattr(company, "facts", None)
    except Exception:
        return None
    if facts is None or not hasattr(facts, "get_ttm"):
        return None
    for concept in concepts:
        try:
            metric = facts.get_ttm(concept)
        except Exception:
            continue
        value = _finite(getattr(metric, "value", None))
        if value is not None:
            return value
    return None


def _latest_instant_fact(
    rows: list[dict[str, Any]],
    concepts: tuple[str, ...],
    as_of: str | None = None,
) -> float | None:
    wanted = {concept.casefold() for concept in concepts}
    candidates: list[tuple[str, float]] = []
    for row in rows:
        if row.get("period_type") != "instant":
            continue
        concept = row.get("concept")
        if not isinstance(concept, str) or concept.casefold() not in wanted:
            continue
        period_end = row.get("period_end")
        if isinstance(period_end, date):
            period_end = period_end.isoformat()
        if not isinstance(period_end, str):
            continue
        period_end = period_end[:10]
        if as_of and period_end > as_of[:10]:
            continue
        value = _finite(row.get("numeric_value", row.get("value")))
        if value is not None:
            candidates.append((period_end, value))
    return max(candidates, key=lambda item: item[0])[1] if candidates else None


def _instant_fact_for_year(rows: list[dict[str, Any]], concepts: tuple[str, ...], year: int) -> float | None:
    wanted = {concept.casefold() for concept in concepts}
    candidates: list[tuple[str, float]] = []
    for row in rows:
        if row.get("period_type") != "instant" or row.get("fiscal_year") != year:
            continue
        concept = row.get("concept")
        if not isinstance(concept, str) or concept.casefold() not in wanted:
            continue
        period_end = row.get("period_end")
        if not isinstance(period_end, str):
            continue
        value = _finite(row.get("numeric_value", row.get("value")))
        if value is not None:
            candidates.append((period_end[:10], value))
    return max(candidates, key=lambda item: item[0])[1] if candidates else None


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
    except Exception as exc:
        raise FilingLookupError("filing_lookup_failed") from exc
    if filing is None:
        return FilingMetadata(None, None, None)
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
    form = getattr(filing, "form", None)
    form = form.strip() if isinstance(form, str) and form.strip() else None
    return FilingMetadata(accession, period, form)


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
    if capex is None:
        capex = _fact_ttm_value(company, CAPEX_FACT_CONCEPTS)
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
    fact_rows: list[dict[str, Any]] | None = None
    if total_debt is None:
        fact_rows = _fact_rows(company)
        current = _fact_value(fact_rows, DEBT_CURRENT_FACT_CONCEPTS, balance_ref)
        noncurrent = _fact_value(fact_rows, DEBT_NONCURRENT_FACT_CONCEPTS, balance_ref)
        if current is not None and noncurrent is not None:
            total_debt = current + noncurrent

    cash = _balance_value(balance_rows, ("CashAndCashEquivalentsAtCarryingValue",), ("Cash and Cash Equivalents",), balance_period_name)
    short_term_investments = _balance_value(balance_rows, ("ShortTermInvestments",), ("Short-term Investments",), balance_period_name)
    if short_term_investments is None:
        if fact_rows is None:
            fact_rows = _fact_rows(company)
        short_term_investments = _fact_value(fact_rows, (MARKETABLE_SECURITIES_CURRENT_CONCEPT,), balance_ref)
        if short_term_investments is None:
            marketable_debt = _fact_value(fact_rows, (SHORT_TERM_INVESTMENT_FACT_CONCEPTS[0],), balance_ref)
            marketable_equity = _fact_value(fact_rows, (SHORT_TERM_INVESTMENT_FACT_CONCEPTS[1],), balance_ref)
            if marketable_debt is not None and marketable_equity is not None:
                short_term_investments = marketable_debt + marketable_equity

    revenue = _find(income_rows, INCOME_LABELS["revenue_ttm"], income_period if isinstance(income_period, str) else None)
    if revenue is None:
        revenue = _fact_ttm_value(company, INCOME_FACT_CONCEPTS["revenue_ttm"])
    pretax_income = _find(income_rows, INCOME_LABELS["pretax_income_ttm"], income_period if isinstance(income_period, str) else None)
    if pretax_income is None:
        pretax_income = _fact_ttm_value(company, INCOME_FACT_CONCEPTS["pretax_income_ttm"])

    net_income = _find(
        income_rows,
        ("Net Income", "Net Income (Loss)", "Net Income Attributable to Parent"),
        income_period if isinstance(income_period, str) else None,
    )
    if net_income is None:
        net_income = _fact_ttm_value(company, NET_INCOME_FACT_CONCEPTS)
    diluted_eps = _fact_ttm_value(company, EPS_FACT_CONCEPTS)
    if diluted_eps is None:
        diluted_eps = _find(
            income_rows,
            ("Earnings Per Share, Diluted", "Earnings Per Share (Derived)", "Diluted Earnings Per Share"),
            income_period if isinstance(income_period, str) else None,
        )
    depreciation = _find(
        cash_rows,
        ("Depreciation, Depletion and Amortization", "Depreciation and Amortization", "Depreciation"),
        income_period if isinstance(income_period, str) else None,
    )
    if depreciation is None:
        depreciation = _fact_ttm_value(company, D_AND_A_FACT_CONCEPTS)
    if fact_rows is None:
        fact_rows = _fact_rows(company)
    foreign_filing = filing is not None and getattr(filing, "form", None) in {"20-F", "20-F/A", "6-K", "6-K/A"}
    shares = None if foreign_filing else _latest_instant_fact(
        fact_rows,
        SHARES_FACT_CONCEPTS,
        filing.period_of_report if filing else None,
    )

    return AccountingInputs(
        revenue_ttm=revenue,
        operating_income_ttm=_find(income_rows, INCOME_LABELS["operating_income_ttm"], income_period if isinstance(income_period, str) else None),
        pretax_income_ttm=pretax_income,
        income_tax_ttm=_find(income_rows, INCOME_LABELS["income_tax_ttm"], income_period if isinstance(income_period, str) else None),
        operating_cash_flow_ttm=_find(cash_rows, OCF_LABELS, income_period if isinstance(income_period, str) else None),
        capex_ttm=capex,
        cash=cash,
        short_term_investments=short_term_investments,
        total_debt=total_debt,
        shareholders_equity=_balance_value(balance_rows, ("StockholdersEquity",), ("Stockholders' Equity Attributable to Parent", "Total Stockholders' Equity"), balance_period_name),
        net_income_ttm=net_income,
        diluted_eps_ttm=diluted_eps,
        depreciation_amortization_ttm=depreciation,
        shares_outstanding=shares,
        accounting_as_of=filing.period_of_report if filing else _filing_as_of(company, annual=annual_balance),
        periods_compatible=compatible,
    )


def _statement_value(rows: list[dict[str, Any]], labels: tuple[str, ...], period: str) -> float | None:
    return _find(rows, labels, period)


def _annual_years(statement: Any) -> list[int]:
    years: list[int] = []
    for raw in getattr(statement, "periods", None) or []:
        if isinstance(raw, (tuple, list)) and len(raw) >= 2:
            year_value, period_value = raw[0], str(raw[1]).upper()
            year = int(year_value) if str(year_value).isdigit() and period_value == "FY" else None
        else:
            parts = str(raw).upper().split()
            year = int(parts[1]) if len(parts) == 2 and parts[0] == "FY" and parts[1].isdigit() else None
        if year is not None:
            try:
                year = int(year)
            except (TypeError, ValueError):
                continue
            if year not in years:
                years.append(year)
    return years[:5]


def fetch_annual_fundamentals(
    symbol: str,
    identity: str,
    filing: FilingMetadata | None = None,
) -> list[AnnualFundamental]:
    """Fetch the small annual input set needed by the next valuation PRs."""
    from edgar import Company, set_identity

    set_identity(identity)
    company = Company(symbol)
    income = company.income_statement(period="annual", periods=5)
    cashflow = company.cash_flow_statement(period="annual", periods=5)
    balance = company.balance_sheet(period="annual", periods=5)
    income_rows, cash_rows, balance_rows = _rows(income), _rows(cashflow), _rows(balance)
    facts = _fact_rows(company)
    foreign_filing = filing is not None and getattr(filing, "form", None) in {"20-F", "20-F/A", "6-K", "6-K/A"}
    rows: list[AnnualFundamental] = []
    for year in _annual_years(income):
        period = f"FY {year}"
        revenue = _statement_value(income_rows, INCOME_LABELS["revenue_ttm"], period)
        operating_income = _statement_value(income_rows, INCOME_LABELS["operating_income_ttm"], period)
        pretax = _statement_value(income_rows, INCOME_LABELS["pretax_income_ttm"], period)
        tax = _statement_value(income_rows, INCOME_LABELS["income_tax_ttm"], period)
        net_income = _statement_value(income_rows, ("Net Income", "Net Income (Loss)", "Net Income Attributable to Parent"), period)
        eps = _statement_value(income_rows, ("Earnings Per Share, Diluted", "Diluted Earnings Per Share"), period)
        ocf = _statement_value(cash_rows, OCF_LABELS, period)
        capex = _statement_value(cash_rows, CAPEX_LABELS, period)
        if capex is not None:
            capex = abs(capex)
        fcf = ocf - capex if ocf is not None and capex is not None else None
        depreciation = _statement_value(cash_rows, ("Depreciation, Depletion and Amortization", "Depreciation and Amortization", "Depreciation"), period)
        shares = None if foreign_filing else _instant_fact_for_year(facts, SHARES_FACT_CONCEPTS, year)
        total_debt = _balance_value(balance_rows, ("Debt", "LongTermDebt"), ("Total Debt", "Debt"), period)
        if total_debt is None:
            current_debt = _balance_value(balance_rows, DEBT_CURRENT_FACT_CONCEPTS, ("Long-term Debt, Current Maturities",), period)
            noncurrent_debt = _balance_value(balance_rows, DEBT_NONCURRENT_FACT_CONCEPTS, ("Long-term Debt, Excluding Current Maturities",), period)
            if current_debt is not None and noncurrent_debt is not None:
                total_debt = current_debt + noncurrent_debt
        rows.append(AnnualFundamental(
            fiscal_year=year,
            revenue=revenue,
            operating_income=operating_income,
            pretax_income=pretax,
            income_tax=tax,
            net_income=net_income,
            diluted_eps=eps,
            operating_cash_flow=ocf,
            capex=capex,
            free_cash_flow=fcf,
            depreciation_amortization=depreciation,
            cash=_balance_value(balance_rows, ("CashAndCashEquivalentsAtCarryingValue",), ("Cash and Cash Equivalents",), period),
            total_debt=total_debt,
            shareholders_equity=_balance_value(balance_rows, ("StockholdersEquity",), ("Stockholders' Equity Attributable to Parent", "Total Stockholders' Equity"), period),
            shares_outstanding=shares,
            as_of=period,
        ))
    return rows
