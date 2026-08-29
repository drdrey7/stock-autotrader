"""Small, deterministic latest-reported-earnings context for TradingAgents."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any


def _value(row: Mapping[str, Any], key: str) -> Any:
    value = row.get(key)
    if value in (None, ""):
        return None
    return value[:240] if isinstance(value, str) else value


def _money(value: Any) -> str | None:
    if value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return str(value)
    absolute = abs(number)
    if absolute >= 1_000_000_000:
        return f"${number / 1_000_000_000:.3g}B"
    if absolute >= 1_000_000:
        return f"${number / 1_000_000:.3g}M"
    return f"${number:.6g}"


def _eps(value: Any) -> str | None:
    if value is None:
        return None
    try:
        return f"${float(value):.4g}"
    except (TypeError, ValueError):
        return str(value)


def latest_reported_row(rows: list[Mapping[str, Any]]) -> Mapping[str, Any] | None:
    """Select the newest actually reported event from already-filtered rows."""
    reported = [
        row for row in rows
        if str(row.get("status", "")).lower() == "reported" and row.get("reported") in (1, True, "1")
    ]
    return max(
        reported,
        key=lambda row: (
            str(row.get("reported_at") or row.get("scheduled_date") or ""),
            str(row.get("fiscal_period_end") or ""),
            str(row.get("updated_at") or ""),
        ),
    ) if reported else None


def format_latest_earnings(row: Mapping[str, Any] | None, symbol: str) -> str:
    """Format only validated fields; never merge GAAP and adjusted bases."""
    if row is None:
        return ""
    lines = [
        "AUTHORITATIVE LATEST EARNINGS",
        f"Symbol: {symbol}",
    ]
    reported_at = _value(row, "reported_at")
    if reported_at:
        lines.append(f"Reported: {reported_at}")
    else:
        event_date = _value(row, "scheduled_date")
        if event_date:
            lines.append(f"Earnings event date: {event_date}")
    fiscal_year = _value(row, "fiscal_year")
    fiscal_quarter = _value(row, "fiscal_quarter")
    fiscal_period = _value(row, "fiscal_period")
    if fiscal_year is not None or fiscal_quarter is not None or fiscal_period:
        identity = f"FY{fiscal_year}" if fiscal_year is not None else "Fiscal year unavailable"
        if fiscal_quarter is not None:
            identity += f" Q{fiscal_quarter}"
        elif fiscal_period:
            identity += f" {fiscal_period}"
        lines.append(f"Fiscal period: {identity}")
    period_end = _value(row, "fiscal_period_end")
    if period_end:
        lines.append(f"Fiscal period end: {period_end}")

    revenue = _money(_value(row, "revenue_actual_official"))
    if revenue:
        source = _value(row, "revenue_actual_source")
        lines.append(f"Official quarterly revenue: {revenue}{f' (source: {source})' if source else ''}")
    gaap_eps = _eps(_value(row, "eps_actual_gaap"))
    if gaap_eps:
        source = _value(row, "eps_actual_gaap_source")
        lines.append(f"Official GAAP diluted EPS: {gaap_eps}{f' (source: {source})' if source else ''}")
    adjusted_eps = _eps(_value(row, "eps_actual_adjusted"))
    if adjusted_eps:
        source = _value(row, "eps_actual_adjusted_source")
        lines.append(f"Adjusted/provider EPS: {adjusted_eps}{f' (source: {source})' if source else ''}")
    quality = _value(row, "data_quality_status")
    if quality:
        lines.append(f"Data quality: {quality}")
    sources = []
    if _value(row, "sec_filing_url") or _value(row, "sec_accession"):
        sources.append("SEC")
    if _value(row, "official_report_url"):
        sources.append("official report")
    if _value(row, "revenue_actual_source") or _value(row, "eps_actual_gaap_source"):
        sources.append("canonical official metrics")
    if sources:
        lines.append(f"Source: {', '.join(dict.fromkeys(sources))}")
    lines.extend([
        "Rules:",
        "- This is the latest known reported earnings event for this company.",
        "- Prefer these explicitly labelled facts over older supplementary snapshots.",
        "- Do not mix figures from different fiscal periods or accounting bases.",
    ])
    return "\n".join(lines)[:2000]
