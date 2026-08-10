from datetime import UTC, datetime

from bot.models import SignalStatus, StrategyContext
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
