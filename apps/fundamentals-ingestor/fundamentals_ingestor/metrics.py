"""Normalized accounting input records used by the D1 writer."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class AccountingInputs:
    revenue_ttm: float | None = None
    operating_income_ttm: float | None = None
    pretax_income_ttm: float | None = None
    income_tax_ttm: float | None = None
    operating_cash_flow_ttm: float | None = None
    capex_ttm: float | None = None
    free_cash_flow_ttm: float | None = None
    cash: float | None = None
    short_term_investments: float | None = None
    total_debt: float | None = None
    shareholders_equity: float | None = None
    net_income_ttm: float | None = None
    diluted_eps_ttm: float | None = None
    depreciation_amortization_ttm: float | None = None
    shares_outstanding: float | None = None
    current_assets: float | None = None
    current_liabilities: float | None = None
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
        free_cash_flow_ttm=number("free_cash_flow_ttm"),
        cash=number("cash"),
        short_term_investments=number("short_term_investments"),
        total_debt=number("total_debt"),
        shareholders_equity=number("shareholders_equity"),
        net_income_ttm=number("net_income_ttm"),
        diluted_eps_ttm=number("diluted_eps_ttm"),
        depreciation_amortization_ttm=number("depreciation_amortization_ttm"),
        shares_outstanding=number("shares_outstanding"),
        current_assets=number("current_assets"),
        current_liabilities=number("current_liabilities"),
        accounting_as_of=row.get("accounting_as_of") if isinstance(row.get("accounting_as_of"), str) else None,
        periods_compatible=row.get("accounting_periods_compatible") == 1,
        extraction_status=(
            row.get("accounting_refresh_status")
            if row.get("accounting_refresh_status") in {"ok", "unknown", "incomplete", "unsupported"}
            else "unknown"
        ),
    )
