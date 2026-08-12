"""DailyBriefing composition and local validation.

Mirrors the authoritative contract (``packages/contracts/src/daily-briefing.ts``)
so the publisher fails locally before any network publication. The contract
remains the source of truth at the ingest boundary; this module catches the
same classes of error early with deterministic, testable rules.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

from .market import BenchmarkItem, CandidateQuote, load_benchmarks
from .universe import UniverseSnapshot
from .x_feed import CandidateIdea

BRIEFING_TIMEZONE = ZoneInfo("America/New_York")
MAX_SOURCE_AGE = timedelta(hours=26)
EDITION_TITLES = {
    "pre_market": "Pre-market briefing",
    "post_close": "Post-close briefing",
}
SCHEDULE_BY_EDITION = {
    "pre_market": [
        {"label": "Pre-market briefing", "time": "08:30 ET", "detail": "Published before the US open."},
        {"label": "X source window", "time": "24h", "detail": "Ideas collected from the source account within 24h of publication."},
    ],
    "post_close": [
        {"label": "Post-close briefing", "time": "16:30 ET", "detail": "Published after the US close."},
        {"label": "X source window", "time": "24h", "detail": "Ideas collected from the source account within 24h of publication."},
    ],
}
REWARD_RISK_TEXT_RE = re.compile(r"^(\d+(?:\.\d+)?)R\b", re.IGNORECASE)


def calendar_date_in_briefing_timezone(timestamp: datetime) -> str:
    """Return YYYY-MM-DD of ``timestamp`` in the briefing timezone."""
    local = timestamp.astimezone(BRIEFING_TIMEZONE)
    return local.strftime("%Y-%m-%d")


def _iso(timestamp: datetime) -> str:
    return timestamp.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _market_summary(benchmarks: list[BenchmarkItem]) -> str:
    states = ", ".join(f"{item.name} {item.state.lower()}" for item in benchmarks)
    return f"Index snapshot: {states}. See benchmark notes for context; this is not investment advice."


@dataclass(frozen=True)
class IdeaDraft:
    candidate: CandidateIdea
    quote: CandidateQuote
    collected_at: datetime

    def to_contract(self) -> dict[str, Any]:
        post = self.candidate.post
        # contract caps each list at 20 entries; composition guarantees the cap
        cap = lambda items: list(items)[:20]  # noqa: E731
        return {
            "symbol": self.candidate.symbol,
            "company": self.quote.company,
            "universe": self.candidate.universe,
            "verdict": "Potential Entry",
            "price": self.quote.price,
            "change": self.quote.change,
            "thesis": self.quote.thesis,
            "source": {
                "handle": post.author,
                "reference": post.url,
                "originalTimestamp": _iso(post.created_at),
                "collectedTimestamp": _iso(self.collected_at),
                "summary": f"Idea from {post.author} on {post.created_at.astimezone(BRIEFING_TIMEZONE).strftime('%Y-%m-%d %H:%M %Z')}.",
            },
            "technical": cap(self.quote.technical),
            "financial": cap(self.quote.financial),
            "news": cap(self.quote.news),
            "risks": cap(self.quote.risks),
            "levels": self.quote.levels.to_contract(),
        }


def build_briefing(
    *,
    edition_type: str,
    prepared_at: datetime,
    benchmarks: list[BenchmarkItem],
    ideas: list[IdeaDraft],
    universe: UniverseSnapshot,
) -> dict[str, Any]:
    """Compose a DailyBriefing object (``example: false``)."""
    if prepared_at.tzinfo is None:
        raise ValueError("prepared_at must be timezone-aware")
    if edition_type not in EDITION_TITLES:
        raise ValueError(f"unknown edition_type: {edition_type!r}")
    if len(ideas) > 3:
        raise ValueError("a briefing may contain at most three ideas")

    briefing: dict[str, Any] = {
        "example": False,
        "editionDate": calendar_date_in_briefing_timezone(prepared_at),
        "editionType": edition_type,
        "timezone": "America/New_York",
        "preparedAt": _iso(prepared_at),
        "title": EDITION_TITLES[edition_type],
        "marketSummary": _market_summary(benchmarks),
        "market": [item.to_contract() for item in benchmarks],
        "ideas": [idea.to_contract() for idea in ideas],
        "schedule": list(SCHEDULE_BY_EDITION[edition_type]),
    }
    return briefing


def validate_briefing(
    briefing: dict[str, Any],
    universe: UniverseSnapshot,
) -> list[str]:
    """Return a list of validation errors (empty = valid). Mirrors the contract."""
    errors: list[str] = []

    if briefing.get("example") is not False:
        errors.append("published briefing must have example=false")

    edition_date = briefing.get("editionDate")
    prepared_at = briefing.get("preparedAt")
    if not isinstance(prepared_at, str):
        errors.append("preparedAt must be an ISO timestamp")
        return errors
    try:
        prepared_dt = datetime.fromisoformat(prepared_at.replace("Z", "+00:00"))
    except ValueError:
        errors.append("preparedAt is not a valid ISO timestamp")
        return errors
    if prepared_dt.tzinfo is None:
        errors.append("preparedAt must include a timezone offset")

    if edition_date != calendar_date_in_briefing_timezone(prepared_dt):
        errors.append("preparedAt must fall on editionDate in the briefing timezone")

    if briefing.get("editionType") not in ("pre_market", "post_close"):
        errors.append("editionType must be pre_market or post_close")

    market = briefing.get("market")
    if not isinstance(market, list) or len(market) != 3:
        errors.append("market must contain exactly three benchmark items")
    else:
        expected = {"S&P 500": "SP:SPX", "Nasdaq-100": "NASDAQ:NDX", "VIX": "CBOE:VIX"}
        seen: set[str] = set()
        for item in market:
            name, symbol = item.get("name"), item.get("symbol")
            if name not in expected or symbol != expected[name]:
                errors.append(f"market item must use canonical benchmark: {name}/{symbol}")
            if name in seen:
                errors.append("market items must be unique")
            seen.add(name)
        if seen != set(expected):
            errors.append("market must contain each canonical benchmark exactly once")

    ideas = briefing.get("ideas")
    if not isinstance(ideas, list) or len(ideas) > 3:
        errors.append("ideas must be a list of at most three")
        return errors

    seen_symbols: set[str] = set()
    for index, idea in enumerate(ideas):
        symbol = idea.get("symbol")
        universe_label = idea.get("universe")
        verdict = idea.get("verdict")

        if not isinstance(symbol, str) or not re.fullmatch(r"[A-Z0-9.-]{1,12}", symbol):
            errors.append(f"idea[{index}] has an invalid symbol")
            continue
        if symbol in seen_symbols:
            errors.append(f"idea[{index}] duplicates symbol {symbol}")
        seen_symbols.add(symbol)

        if universe_label not in ("S&P 500", "Nasdaq-100", "Both"):
            errors.append(f"idea[{index}] has an invalid universe label")
        else:
            labels = universe.index_labels(symbol)
            if universe_label == "Both" and len(labels) != 2:
                errors.append(f"idea[{index}] {symbol} is not in both indexes")
            elif universe_label in ("S&P 500", "Nasdaq-100") and universe_label not in labels:
                errors.append(f"idea[{index}] {symbol} is not a member of {universe_label}")

        source = idea.get("source")
        if not isinstance(source, dict):
            errors.append(f"idea[{index}] requires a source object")
            continue
        original = source.get("originalTimestamp")
        collected = source.get("collectedTimestamp")
        if verdict == "Potential Entry":
            if not isinstance(original, str) or not isinstance(collected, str):
                errors.append(f"idea[{index}] Potential Entry requires source timestamps")
            else:
                try:
                    original_dt = datetime.fromisoformat(original.replace("Z", "+00:00"))
                    collected_dt = datetime.fromisoformat(collected.replace("Z", "+00:00"))
                except ValueError:
                    errors.append(f"idea[{index}] source timestamps are invalid")
                    continue
                if not (original_dt <= collected_dt <= prepared_dt):
                    errors.append(f"idea[{index}] source timestamps must be chronological")
                if prepared_dt - original_dt > MAX_SOURCE_AGE or prepared_dt - collected_dt > MAX_SOURCE_AGE:
                    errors.append(f"idea[{index}] source timestamps must be within 26h of preparedAt")

        levels = idea.get("levels")
        if not isinstance(levels, dict):
            errors.append(f"idea[{index}] requires levels")
            continue
        reward_text = levels.get("rewardRisk")
        ratio = levels.get("rewardRiskRatio")
        if verdict == "Potential Entry":
            match = REWARD_RISK_TEXT_RE.match(str(reward_text).strip()) if isinstance(reward_text, str) else None
            if ratio is None or not isinstance(ratio, (int, float)) or ratio <= 0:
                errors.append(f"idea[{index}] Potential Entry requires a positive rewardRiskRatio")
            elif not match:
                errors.append(f"idea[{index}] rewardRisk text must start with an NxR ratio")
            elif abs(float(match.group(1)) - float(ratio)) > 0.01:
                errors.append(f"idea[{index}] rewardRisk text and ratio must agree")
        elif ratio is not None:
            errors.append(f"idea[{index}] only Potential Entry ideas may include rewardRiskRatio")
        if isinstance(reward_text, str) and REWARD_RISK_TEXT_RE.match(reward_text.strip()) and ratio is None:
            errors.append(f"idea[{index}] rewardRisk text cannot contain a ratio without a numeric value")

    return errors
