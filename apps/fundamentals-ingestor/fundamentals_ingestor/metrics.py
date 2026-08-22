"""The five small, fail-closed Stock Detail calculations."""

from __future__ import annotations

import math
from dataclasses import dataclass


def _number(value: float | None) -> bool:
    return value is not None and math.isfinite(value)


@dataclass(frozen=True)
class AccountingInputs:
    revenue_ttm: float | None = None
    operating_income_ttm: float | None = None
    pretax_income_ttm: float | None = None
    income_tax_ttm: float | None = None
    operating_cash_flow_ttm: float | None = None
    capex_ttm: float | None = None
    cash: float | None = None
    short_term_investments: float | None = None
    total_debt: float | None = None
    shareholders_equity: float | None = None
    accounting_as_of: str | None = None
    periods_compatible: bool = False
    extraction_status: str = "ok"


def accounting_inputs_from_snapshot(row: dict[str, object]) -> AccountingInputs:
    def number(name: str) -> float | None:
        value = row.get(name)
        return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None

    return AccountingInputs(
        revenue_ttm=number("revenue_ttm"),
        operating_income_ttm=number("operating_income_ttm"),
        pretax_income_ttm=number("pretax_income_ttm"),
        income_tax_ttm=number("income_tax_ttm"),
        operating_cash_flow_ttm=number("operating_cash_flow_ttm"),
        capex_ttm=number("capex_ttm"),
        cash=number("cash"),
        short_term_investments=number("short_term_investments"),
        total_debt=number("total_debt"),
        shareholders_equity=number("shareholders_equity"),
        accounting_as_of=row.get("accounting_as_of") if isinstance(row.get("accounting_as_of"), str) else None,
        periods_compatible=False,
        extraction_status=row.get("accounting_refresh_status") if row.get("accounting_refresh_status") in {"ok", "unknown", "incomplete"} else "unknown",
    )


@dataclass(frozen=True)
class CalculatedMetrics:
    free_cash_flow_ttm: float | None
    roic_pct: float | None
    fcf_margin_pct: float | None
    debt_to_equity: float | None


def calculate_metrics(inputs: AccountingInputs) -> CalculatedMetrics:
    fcf = None
    if _number(inputs.operating_cash_flow_ttm) and _number(inputs.capex_ttm):
        fcf = inputs.operating_cash_flow_ttm - inputs.capex_ttm

    fcf_margin = None
    if fcf is not None and _number(inputs.revenue_ttm) and inputs.revenue_ttm > 0:
        fcf_margin = fcf / inputs.revenue_ttm * 100

    debt_to_equity = None
    if _number(inputs.total_debt) and _number(inputs.shareholders_equity) and inputs.shareholders_equity > 0:
        debt_to_equity = inputs.total_debt / inputs.shareholders_equity

    roic = None
    if inputs.periods_compatible and all(_number(value) for value in (
        inputs.operating_income_ttm,
        inputs.pretax_income_ttm,
        inputs.income_tax_ttm,
        inputs.total_debt,
        inputs.shareholders_equity,
        inputs.cash,
        inputs.short_term_investments,
    )) and inputs.pretax_income_ttm > 0:
        effective_tax_rate = inputs.income_tax_ttm / inputs.pretax_income_ttm
        invested_capital = (
            inputs.total_debt
            + inputs.shareholders_equity
            - inputs.cash
            - inputs.short_term_investments
        )
        if math.isfinite(effective_tax_rate) and math.isfinite(invested_capital) and invested_capital > 0:
            nopat = inputs.operating_income_ttm * (1 - effective_tax_rate)
            roic = nopat / invested_capital * 100 if math.isfinite(nopat) else None

    return CalculatedMetrics(fcf, roic, fcf_margin, debt_to_equity)
