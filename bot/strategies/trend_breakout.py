from math import isfinite
from typing import Any

from bot.models import (
    DecisionReason,
    Direction,
    ReasonOutcome,
    SignalStatus,
    StrategyContext,
    StrategyDecision,
)
from bot.strategies.base import Strategy, StrategyMetadata, feature_number


class TrendBreakoutV1(Strategy):
    metadata = StrategyMetadata(
        id="trend_breakout_v1",
        name="Trend Breakout",
        version="1.0.0",
        description="Trend, relative-strength and volume-confirmed breakouts in liquid US equities.",
        lifecycle_state="Shadow",
        universe="US Core >= $1B",
        holding_period="5-30 sessions",
        parameters={"min_relative_volume": 1.5, "min_rs_spy": 0.0, "min_atr_pct": 0.01, "max_atr_pct": 0.08},
    )

    def screen(self, context: StrategyContext) -> bool:
        return bool(
            context.market_regime_positive
            and feature_number(context, "median_dollar_volume20", 0) >= 10_000_000
        )

    def calculate_stop(self, context: StrategyContext) -> float | None:
        close, atr14 = context.features.get("close"), context.features.get("atr14")
        if not isinstance(close, (int, float)) or not isinstance(atr14, (int, float)):
            return None
        stop = round(float(close) - 2 * float(atr14), 4)
        return stop if isfinite(stop) and stop > 0 else None

    def generate_signal(self, context: StrategyContext) -> StrategyDecision:
        f = context.features
        close = feature_number(context, "close", 0)
        ema20 = feature_number(context, "ema20", float("inf"))
        ema50 = feature_number(context, "ema50", float("inf"))
        ema200 = feature_number(context, "ema200", float("inf"))
        rs_spy = feature_number(context, "rs_spy", -1)
        rs_qqq = feature_number(context, "rs_qqq", -1)
        relative_volume = feature_number(context, "relative_volume", 0)
        atr_pct = feature_number(context, "atr_pct", 1)
        stop_price = self.calculate_stop(context)
        checks = [
            (
                context.market_regime_positive,
                "MARKET_REGIME",
                "Market regime positive",
                str(context.market_regime_positive),
                "true",
            ),
            (
                close > ema20 > ema50 > ema200,
                "EMA_STACK",
                "Above EMA20 / EMA50 / EMA200",
                "trend stack",
                "positive",
            ),
            (
                rs_spy > 0 and rs_qqq > 0,
                "RELATIVE_STRENGTH",
                "Relative strength vs SPY and QQQ positive",
                f"SPY {rs_spy}",
                "> 0",
            ),
            (
                bool(f.get("breakout_20d") or f.get("breakout_50d")),
                "BREAKOUT",
                "20-day or 50-day breakout",
                str(bool(f.get("breakout_20d") or f.get("breakout_50d"))),
                "true",
            ),
            (
                relative_volume >= 1.5,
                "VOLUME_CONFIRM",
                "Volume confirmation",
                f"{relative_volume:.2f}x",
                ">= 1.50x",
            ),
            (
                0.01 <= atr_pct <= 0.08,
                "VOLATILITY",
                "Volatility inside baseline range",
                f"{atr_pct:.2%}",
                "1%-8%",
            ),
            (
                stop_price is not None,
                "STOP_VALID",
                "Volatility stop is finite and above zero",
                str(stop_price),
                "> 0",
            ),
        ]
        reasons = [
            DecisionReason(
                outcome=ReasonOutcome.PASS if passed else ReasonOutcome.REJECT,
                code=code,
                label=label,
                observed=observed,
                threshold=threshold,
            )
            for passed, code, label, observed, threshold in checks
        ]
        passed = sum(check[0] for check in checks)
        signal = (
            SignalStatus.STRONG_SETUP
            if passed == len(checks)
            else SignalStatus.WATCH
            if passed >= 4
            else SignalStatus.REJECTED
        )
        return StrategyDecision(
            strategy_id=self.metadata.id,
            strategy_version=self.metadata.version,
            symbol=context.symbol,
            signal=signal,
            direction=Direction.BULLISH if passed >= 4 else Direction.NEUTRAL,
            quant_score=round(100 * passed / len(checks), 2),
            reasons=reasons,
            stop_price=stop_price,
        )

    def exit_signal(self, context: StrategyContext, position: dict[str, Any]) -> bool:
        close = feature_number(context, "close", float("nan"))
        ema20 = feature_number(context, "ema20", close)
        return close < ema20
