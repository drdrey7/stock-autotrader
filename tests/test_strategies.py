from datetime import UTC, date, datetime, timedelta

import pytest
from pydantic import ValidationError

from bot.models import EarningsSnapshot, SignalStatus, StrategyContext
from bot.strategies.registry import registry


def test_registry_is_metadata_driven() -> None:
    assert {item["id"] for item in registry.metadata()} == {"trend_breakout_v1", "post_earnings_v1"}


def test_trend_breakout_produces_structured_reasons() -> None:
    strategy = registry.get("trend_breakout_v1")
    context = StrategyContext(
        symbol="TEST",
        market_regime_positive=True,
        as_of=datetime.now(UTC),
        features={
            "close": 120.0,
            "ema20": 115.0,
            "ema50": 110.0,
            "ema200": 100.0,
            "atr14": 3.0,
            "atr_pct": 0.025,
            "median_dollar_volume20": 25_000_000.0,
            "rs_spy": 0.08,
            "rs_qqq": 0.04,
            "breakout_20d": True,
            "breakout_50d": False,
            "relative_volume": 1.8,
        },
    )
    decision = strategy.generate_signal(context)
    assert decision.signal == SignalStatus.STRONG_SETUP
    assert decision.stop_price == 114.0
    assert all(reason.code and reason.label for reason in decision.reasons)


def test_post_earnings_rejects_future_event() -> None:
    strategy = registry.get("post_earnings_v1")
    as_of = datetime(2026, 8, 10, 20, tzinfo=UTC)
    context = StrategyContext(
        symbol="NVDA",
        market_regime_positive=True,
        as_of=as_of,
        features={"close": 120.0, "atr14": 3.0, "rs_spy": 0.1},
        earnings=EarningsSnapshot(
            symbol="NVDA",
            event_date=date(2026, 8, 11),
            available_at=as_of - timedelta(hours=1),
            price_reaction_pct=0.08,
            relative_volume=2.5,
        ),
    )
    assert not strategy.screen(context)
    decision = strategy.generate_signal(context)
    assert any(reason.code == "EVENT_WINDOW" and reason.outcome == "reject" for reason in decision.reasons)
    assert decision.signal != SignalStatus.STRONG_SETUP


def test_strategy_context_rejects_mismatched_earnings_and_naive_timestamps() -> None:
    aware = datetime(2026, 8, 10, 20, tzinfo=UTC)
    with pytest.raises(ValidationError, match="must match"):
        StrategyContext(
            symbol="NVDA",
            market_regime_positive=True,
            as_of=aware,
            features={},
            earnings=EarningsSnapshot(symbol="AAPL", event_date=date(2026, 8, 10), available_at=aware),
        )
    with pytest.raises(ValidationError):
        StrategyContext(
            symbol="NVDA",
            market_regime_positive=True,
            as_of=datetime(2026, 8, 10, 20),
            features={},
        )


def test_post_earnings_cannot_publish_strong_setup_with_invalid_stop() -> None:
    strategy = registry.get("post_earnings_v1")
    as_of = datetime(2026, 8, 10, 20, tzinfo=UTC)
    context = StrategyContext(
        symbol="NVDA",
        market_regime_positive=True,
        as_of=as_of,
        features={"close": 100.0, "atr14": 50.0, "rs_spy": 0.1},
        earnings=EarningsSnapshot(
            symbol="NVDA",
            event_date=date(2026, 8, 10),
            available_at=as_of - timedelta(hours=1),
            price_reaction_pct=0.08,
            relative_volume=2.5,
        ),
    )
    decision = strategy.generate_signal(context)
    assert decision.stop_price is None
    assert decision.signal != SignalStatus.STRONG_SETUP


def test_trend_breakout_never_serializes_nonfinite_stop() -> None:
    strategy = registry.get("trend_breakout_v1")
    context = StrategyContext(
        symbol="NVDA",
        market_regime_positive=True,
        as_of=datetime.now(UTC),
        features={"close": 100.0, "atr14": float("nan"), "atr_pct": 0.03},
    )
    decision = strategy.generate_signal(context)
    assert decision.stop_price is None
    assert any(reason.code == "STOP_VALID" and reason.outcome == "reject" for reason in decision.reasons)
