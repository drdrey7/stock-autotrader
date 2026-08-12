"""DailyBriefing composition and validation tests (unittest — CI-compatible)."""
from __future__ import annotations

import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from publisher.briefing import (
    IdeaDraft,
    build_briefing,
    calendar_date_in_briefing_timezone,
    validate_briefing,
)
from publisher.market import BenchmarkItem, load_benchmarks, load_candidate_quotes
from publisher.universe import load_universe
from publisher.x_feed import CandidateIdea, XPost

REPO_ROOT = Path(__file__).resolve().parents[1]
PREPARED_AT = datetime(2026, 8, 12, 12, 30, tzinfo=timezone.utc)  # 08:30 ET EDT


def _benchmarks() -> list[BenchmarkItem]:
    items = load_benchmarks(
        [
            {"name": "S&P 500", "symbol": "SP:SPX", "value": "6,412.10", "change": "+0.31%", "state": "Constructive", "note": "Note"},
            {"name": "Nasdaq-100", "symbol": "NASDAQ:NDX", "value": "23,830.02", "change": "+0.55%", "state": "Leading", "note": "Note"},
            {"name": "VIX", "symbol": "CBOE:VIX", "value": "15.40", "change": "-2.10%", "state": "Contained", "note": "Note"},
        ]
    )
    if items is None:
        raise AssertionError("benchmark fixture is invalid")
    return items


def _universe():
    return load_universe(
        REPO_ROOT / "data" / "sp500.v1.json",
        REPO_ROOT / "data" / "nasdaq100.v1.json",
    )


def _quote(symbol: str = "NVDA", ratio: float | None = 2.6, reward_text: str = "2.6R") -> dict:
    return {
        "symbol": symbol,
        "company": "NVIDIA Corporation",
        "price": "$183.10",
        "change": "+1.75%",
        "thesis": "Setup intact.",
        "technical": ["Above 20D."],
        "financial": ["Large cap."],
        "news": ["No adverse headline."],
        "risks": ["Gap risk."],
        "levels": {
            "trigger": "Hold $183.60",
            "invalidation": "Close $179.20",
            "objective": "$194.00",
            "rewardRisk": reward_text,
            "rewardRiskRatio": ratio,
        },
    }


def _idea(symbol: str = "NVDA", age_hours: float = 2.0) -> IdeaDraft:
    post = XPost(
        post_id="post-x",
        text=f"${symbol} setup",
        created_at=PREPARED_AT - timedelta(hours=age_hours),
        url="https://x.com/nolimitgains/status/post-x",
        author="@nolimitgains",
    )
    universe = _universe()
    labels = universe.index_labels(symbol)
    candidate = CandidateIdea(
        post=post,
        symbol=symbol,
        universe="Both" if len(labels) == 2 else labels[0],
    )
    quote = load_candidate_quotes([_quote(symbol)])[symbol]
    return IdeaDraft(candidate=candidate, quote=quote, collected_at=PREPARED_AT)


class BriefingTests(unittest.TestCase):
    def test_edition_date_in_new_york(self) -> None:
        late_utc = datetime(2026, 8, 12, 23, 30, tzinfo=timezone.utc)  # 19:30 ET same day
        self.assertEqual(calendar_date_in_briefing_timezone(late_utc), "2026-08-12")

    def test_build_and_validate_ok(self) -> None:
        briefing = build_briefing(
            edition_type="pre_market",
            prepared_at=PREPARED_AT,
            benchmarks=_benchmarks(),
            ideas=[_idea("NVDA"), _idea("AAPL")],
            universe=_universe(),
        )
        self.assertIs(briefing["example"], False)
        self.assertEqual(briefing["editionDate"], "2026-08-12")
        self.assertEqual(briefing["editionType"], "pre_market")
        self.assertEqual(len(briefing["market"]), 3)
        self.assertEqual(len(briefing["ideas"]), 2)
        self.assertEqual(validate_briefing(briefing, _universe()), [])

    def test_empty_ideas_valid(self) -> None:
        briefing = build_briefing(
            edition_type="post_close",
            prepared_at=PREPARED_AT,
            benchmarks=_benchmarks(),
            ideas=[],
            universe=_universe(),
        )
        self.assertEqual(briefing["ideas"], [])
        self.assertEqual(validate_briefing(briefing, _universe()), [])

    def test_more_than_three_ideas_rejected(self) -> None:
        with self.assertRaises(ValueError):
            build_briefing(
                edition_type="pre_market",
                prepared_at=PREPARED_AT,
                benchmarks=_benchmarks(),
                ideas=[_idea("NVDA"), _idea("AAPL"), _idea("MSFT"), _idea("AMZN")],
                universe=_universe(),
            )

    def test_market_summary_is_bounded(self) -> None:
        verbose = [
            BenchmarkItem(name=item.name, symbol=item.symbol, value=item.value, change=item.change, state="x" * 700, note=item.note)
            for item in _benchmarks()
        ]
        briefing = build_briefing(
            edition_type="pre_market",
            prepared_at=PREPARED_AT,
            benchmarks=verbose,
            ideas=[],
            universe=_universe(),
        )
        self.assertLessEqual(len(briefing["marketSummary"]), 2_000)
        self.assertEqual(validate_briefing(briefing, _universe()), [])

    def test_validation_catches_stale_source(self) -> None:
        briefing = build_briefing(
            edition_type="pre_market",
            prepared_at=PREPARED_AT,
            benchmarks=_benchmarks(),
            ideas=[_idea("NVDA", age_hours=30)],
            universe=_universe(),
        )
        errors = validate_briefing(briefing, _universe())
        self.assertTrue(any("26h" in error for error in errors))

    def test_validation_catches_ratio_mismatch(self) -> None:
        post = XPost(
            post_id="post-x",
            text="$NVDA setup",
            created_at=PREPARED_AT - timedelta(hours=2),
            url="https://x.com/nolimitgains/status/post-x",
            author="@nolimitgains",
        )
        candidate = CandidateIdea(post=post, symbol="NVDA", universe="Both")
        quote = load_candidate_quotes([_quote(ratio=2.6, reward_text="3.0R")])["NVDA"]
        briefing = build_briefing(
            edition_type="pre_market",
            prepared_at=PREPARED_AT,
            benchmarks=_benchmarks(),
            ideas=[IdeaDraft(candidate=candidate, quote=quote, collected_at=PREPARED_AT)],
            universe=_universe(),
        )
        errors = validate_briefing(briefing, _universe())
        self.assertTrue(any("agree" in error for error in errors))

    def test_validation_catches_non_member(self) -> None:
        post = XPost(
            post_id="post-x",
            text="$ZZZZZ setup",
            created_at=PREPARED_AT - timedelta(hours=2),
            url="https://x.com/nolimitgains/status/post-x",
            author="@nolimitgains",
        )
        candidate = CandidateIdea(post=post, symbol="ZZZZZ", universe="S&P 500")
        quote = load_candidate_quotes([_quote("ZZZZZ")])["ZZZZZ"]
        briefing = build_briefing(
            edition_type="pre_market",
            prepared_at=PREPARED_AT,
            benchmarks=_benchmarks(),
            ideas=[IdeaDraft(candidate=candidate, quote=quote, collected_at=PREPARED_AT)],
            universe=_universe(),
        )
        errors = validate_briefing(briefing, _universe())
        self.assertTrue(any("not a member" in error for error in errors))


if __name__ == "__main__":
    unittest.main()
