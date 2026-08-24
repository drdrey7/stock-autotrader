"""Normalize the pinned engine state into the app-owned result V1 contract."""

from __future__ import annotations

import json
import math
import re
from datetime import date, datetime
from typing import Any

from .constants import ENGINE_COMMIT, ENGINE_NAME, ENGINE_VERSION, RESULT_SCHEMA_VERSION
from .models import EngineOutput

_SYMBOL = re.compile(r"^[A-Z][A-Z0-9-]{0,11}$")
_COMMIT = re.compile(r"^[a-f0-9]{40}$")
_HEADERS = ("Rating", "Executive Summary", "Investment Thesis", "Price Target", "Time Horizon")
_HEADER = re.compile(r"^\*\*(Rating|Executive Summary|Investment Thesis|Price Target|Time Horizon)\*\*:\s*(.*)$")
_RECOMMENDATIONS = frozenset({"BUY", "OVERWEIGHT", "HOLD", "UNDERWEIGHT", "SELL"})
_TOP_KEYS = frozenset({
    "schemaVersion", "symbol", "analysisDate", "generatedAt", "engine", "recommendation",
    "executiveSummary", "investmentThesis", "priceTarget", "timeHorizon", "reports",
})
_ENGINE_KEYS = frozenset({"name", "version", "commit", "provider", "quickModel", "deepModel"})
_REPORT_KEYS = frozenset({
    "marketAndTechnical", "sentiment", "news", "fundamentals", "bullCase", "bearCase",
    "researchManager", "traderPlan", "risk", "portfolioManager",
})
_RISK_KEYS = frozenset({"aggressive", "neutral", "conservative"})


class ResultValidationError(RuntimeError):
    """The upstream result cannot safely satisfy the public contract."""


def _bounded_string(value: Any, *, maximum: int, nullable: bool) -> str | None:
    if value is None and nullable:
        return None
    if not isinstance(value, str):
        raise ResultValidationError("result_string_invalid")
    value = value.strip()
    if not value:
        if nullable:
            return None
        raise ResultValidationError("result_string_empty")
    if len(value) > maximum:
        raise ResultValidationError("result_string_too_long")
    return value


def _state_dict(value: Any) -> dict[str, Any]:
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise ResultValidationError("engine_state_invalid")
    return value


def _portfolio_sections(markdown: str) -> dict[str, str]:
    """Extract only exact v0.3.1 Portfolio Manager bold headers."""

    sections: dict[str, list[str]] = {}
    active: str | None = None
    for line in markdown.splitlines():
        match = _HEADER.fullmatch(line.strip())
        if match:
            active = match.group(1)
            sections[active] = [match.group(2)] if match.group(2) else []
            continue
        if active is not None:
            sections[active].append(line)
    return {name: "\n".join(lines).strip() for name, lines in sections.items() if name in _HEADERS}


def _price_target(value: str | None) -> float | None:
    if not value:
        return None
    match = re.fullmatch(r"(?:USD\s*)?\$?\s*([0-9]+(?:\.[0-9]+)?)", value.strip(), flags=re.IGNORECASE)
    if not match:
        return None
    price = float(match.group(1))
    return price if math.isfinite(price) and price > 0 else None


def _recommendation(decision: Any, rating: str | None) -> str:
    """Derive a valid recommendation, exact first then a conservative fallback.

    Order per application contract: (a) an exact valid recommendation from the
    engine decision; (b) an exact valid recommendation from the parsed portfolio
    Rating header; (c) tolerant fallback only when the leading token of a
    candidate is itself a known recommendation. Anchoring the tolerant match to
    the leading token accepts ``BUY: strong setup`` while rejecting incidental
    or negated mentions such as "Do not BUY at this level".
    """

    for candidate in (decision, rating):
        if isinstance(candidate, str) and candidate.strip().upper() in _RECOMMENDATIONS:
            return candidate.strip().upper()
    for candidate in (decision, rating):
        if isinstance(candidate, str):
            leading = re.match(r"[A-Za-z]+", candidate.strip())
            if leading is not None and leading.group(0).upper() in _RECOMMENDATIONS:
                return leading.group(0).upper()
    return ""


def normalize_result(symbol: str, analysis_date: str, generated_at: str, output: EngineOutput) -> dict[str, Any]:
    state = output.final_state
    if not isinstance(state, dict):
        raise ResultValidationError("engine_state_invalid")
    portfolio = _bounded_string(state.get("final_trade_decision"), maximum=120_000, nullable=False)
    assert isinstance(portfolio, str)
    sections = _portfolio_sections(portfolio)
    investment = _state_dict(state.get("investment_debate_state"))
    risk = _state_dict(state.get("risk_debate_state"))
    recommendation = _recommendation(output.decision, sections.get("Rating"))
    result = {
        "schemaVersion": RESULT_SCHEMA_VERSION,
        "symbol": symbol,
        "analysisDate": analysis_date,
        "generatedAt": generated_at,
        "engine": {
            "name": ENGINE_NAME,
            "version": ENGINE_VERSION,
            "commit": ENGINE_COMMIT,
            "provider": output.provider,
            "quickModel": output.quick_model,
            "deepModel": output.deep_model,
        },
        "recommendation": recommendation,
        "executiveSummary": _bounded_string(sections.get("Executive Summary"), maximum=20_000, nullable=True),
        "investmentThesis": _bounded_string(sections.get("Investment Thesis"), maximum=80_000, nullable=True),
        "priceTarget": _price_target(sections.get("Price Target")),
        "timeHorizon": _bounded_string(sections.get("Time Horizon"), maximum=2_000, nullable=True),
        "reports": {
            "marketAndTechnical": _bounded_string(state.get("market_report"), maximum=120_000, nullable=True),
            "sentiment": _bounded_string(state.get("sentiment_report"), maximum=120_000, nullable=True),
            "news": _bounded_string(state.get("news_report"), maximum=120_000, nullable=True),
            "fundamentals": _bounded_string(state.get("fundamentals_report"), maximum=120_000, nullable=True),
            "bullCase": _bounded_string(investment.get("bull_history"), maximum=120_000, nullable=True),
            "bearCase": _bounded_string(investment.get("bear_history"), maximum=120_000, nullable=True),
            "researchManager": _bounded_string(investment.get("judge_decision"), maximum=120_000, nullable=True),
            "traderPlan": _bounded_string(state.get("trader_investment_plan"), maximum=120_000, nullable=True),
            "risk": {
                "aggressive": _bounded_string(risk.get("aggressive_history"), maximum=120_000, nullable=True),
                "neutral": _bounded_string(risk.get("neutral_history"), maximum=120_000, nullable=True),
                "conservative": _bounded_string(risk.get("conservative_history"), maximum=120_000, nullable=True),
            },
            "portfolioManager": portfolio,
        },
    }
    validate_result(result)
    return result


def _validate_iso(value: Any) -> None:
    if not isinstance(value, str):
        raise ResultValidationError("result_timestamp_invalid")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ResultValidationError("result_timestamp_invalid") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ResultValidationError("result_timestamp_invalid")


def validate_result(result: Any, *, max_bytes: int | None = None) -> None:
    if not isinstance(result, dict) or set(result) != _TOP_KEYS:
        raise ResultValidationError("result_shape_invalid")
    if result["schemaVersion"] != RESULT_SCHEMA_VERSION or isinstance(result["schemaVersion"], bool):
        raise ResultValidationError("result_version_invalid")
    symbol = result["symbol"]
    if not isinstance(symbol, str) or not _SYMBOL.fullmatch(symbol):
        raise ResultValidationError("result_symbol_invalid")
    analysis_date = result["analysisDate"]
    if not isinstance(analysis_date, str) or len(analysis_date) != 10:
        raise ResultValidationError("result_date_invalid")
    try:
        if date.fromisoformat(analysis_date).isoformat() != analysis_date:
            raise ValueError
    except ValueError as exc:
        raise ResultValidationError("result_date_invalid") from exc
    _validate_iso(result["generatedAt"])

    engine = result["engine"]
    if not isinstance(engine, dict) or set(engine) != _ENGINE_KEYS:
        raise ResultValidationError("result_engine_invalid")
    if engine["name"] != ENGINE_NAME or engine["version"] != ENGINE_VERSION:
        raise ResultValidationError("result_engine_invalid")
    if not isinstance(engine["commit"], str) or not _COMMIT.fullmatch(engine["commit"]) or engine["commit"] != ENGINE_COMMIT:
        raise ResultValidationError("result_engine_invalid")
    for key, maximum in (("provider", 64), ("quickModel", 128), ("deepModel", 128)):
        _bounded_string(engine.get(key), maximum=maximum, nullable=False)

    if result["recommendation"] not in _RECOMMENDATIONS:
        raise ResultValidationError("result_recommendation_invalid")
    _bounded_string(result["executiveSummary"], maximum=20_000, nullable=True)
    _bounded_string(result["investmentThesis"], maximum=80_000, nullable=True)
    price = result["priceTarget"]
    if price is not None and (isinstance(price, bool) or not isinstance(price, (int, float)) or not math.isfinite(price) or price <= 0):
        raise ResultValidationError("result_price_target_invalid")
    _bounded_string(result["timeHorizon"], maximum=2_000, nullable=True)

    reports = result["reports"]
    if not isinstance(reports, dict) or set(reports) != _REPORT_KEYS:
        raise ResultValidationError("result_reports_invalid")
    for key in _REPORT_KEYS - {"risk", "portfolioManager"}:
        _bounded_string(reports[key], maximum=120_000, nullable=True)
    _bounded_string(reports["portfolioManager"], maximum=120_000, nullable=False)
    risk = reports["risk"]
    if not isinstance(risk, dict) or set(risk) != _RISK_KEYS:
        raise ResultValidationError("result_risk_invalid")
    for key in _RISK_KEYS:
        _bounded_string(risk[key], maximum=120_000, nullable=True)

    encoded = serialize_result(result)
    if max_bytes is not None and len(encoded.encode("utf-8")) > max_bytes:
        raise ResultValidationError("result_too_large")


def serialize_result(result: dict[str, Any]) -> str:
    try:
        return json.dumps(result, separators=(",", ":"), sort_keys=True, ensure_ascii=False, allow_nan=False)
    except (TypeError, ValueError) as exc:
        raise ResultValidationError("result_json_invalid") from exc
