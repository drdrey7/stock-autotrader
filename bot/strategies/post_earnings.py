from datetime import timedelta
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


class PostEarningsV1(Strategy):
    metadata = StrategyMetadata(
        id="post_earnings_v1",
        name="Post Earnings",
        version="1.0.0",
        description="Price and volume follow-through after a confirmed earnings event.",
        lifecycle_state="Research",
        universe="US Core >= $1B",
        holding_period="2-20 sessions",
        parameters={"event_window_days": 5, "min_price_reaction_pct": 0.03, "min_relative_volume": 1.8},
    )

    def screen(self, context: StrategyContext) -> bool:
        event = context.earnings
        return bool(
            event
            and event.available_at <= context.as_of
            and event.event_date <= context.as_of.date() <= event.event_date + timedelta(days=5)
        )

    def calculate_stop(self, context: StrategyContext) -> float | None:
        close, atr14 = context.features.get("close"), context.features.get("atr14")
        if not isinstance(close, (int, float)) or not isinstance(atr14, (int, float)):
            return None
        stop = round(float(close) - 2.5 * float(atr14), 4)
        return stop if isfinite(stop) and stop > 0 else None

    def generate_signal(self, context: StrategyContext) -> StrategyDecision:
        event = context.earnings
        checks = [
            (event is not None, "EARNINGS_EVENT", "Earnings event available"),
            (
                bool(event and event.available_at <= context.as_of),
                "EVENT_TIMESTAMP",
                "Event information available at signal time",
            ),
            (
                bool(
                    event and event.event_date <= context.as_of.date() <= event.event_date + timedelta(days=5)
                ),
                "EVENT_WINDOW",
                "Signal date within five days after earnings",
            ),
            (
                bool(event and (event.price_reaction_pct or 0) >= 0.03),
                "PRICE_REACTION",
                "Positive price reaction >= 3%",
            ),
            (
                bool(event and (event.relative_volume or 0) >= 1.8),
                "EVENT_VOLUME",
                "Post-event volume >= 1.8x",
            ),
            (
                feature_number(context, "rs_spy", -1) > 0,
                "RELATIVE_STRENGTH",
                "Relative strength vs SPY positive",
            ),
            (
                self.calculate_stop(context) is not None,
                "STOP_VALID",
                "Volatility stop is finite and above zero",
            ),
        ]
        reasons = [
            DecisionReason(
                outcome=ReasonOutcome.PASS if passed else ReasonOutcome.REJECT, code=code, label=label
            )
            for passed, code, label in checks
        ]
        passed = sum(check[0] for check in checks)
        signal = (
            SignalStatus.STRONG_SETUP
            if passed == len(checks)
            else SignalStatus.WATCH
            if passed >= 3
            else SignalStatus.REJECTED
        )
        return StrategyDecision(
            strategy_id=self.metadata.id,
            strategy_version=self.metadata.version,
            symbol=context.symbol,
            signal=signal,
            direction=Direction.BULLISH if passed >= 3 else Direction.NEUTRAL,
            quant_score=100 * passed / len(checks),
            reasons=reasons,
            stop_price=self.calculate_stop(context),
            metadata={"guidance_status": event.guidance_status if event else None},
        )

    def exit_signal(self, context: StrategyContext, position: dict[str, Any]) -> bool:
        close = feature_number(context, "close", float("nan"))
        ema20 = feature_number(context, "ema20", close)
        return close < ema20
