from bot.strategies.base import Strategy
from bot.strategies.post_earnings import PostEarningsV1
from bot.strategies.trend_breakout import TrendBreakoutV1


class StrategyRegistry:
    def __init__(self) -> None:
        self._strategies: dict[str, Strategy] = {}

    def register(self, strategy: Strategy) -> None:
        strategy_id = strategy.metadata.id
        if strategy_id in self._strategies:
            raise ValueError(f"Strategy already registered: {strategy_id}")
        self._strategies[strategy_id] = strategy

    def get(self, strategy_id: str) -> Strategy:
        try:
            return self._strategies[strategy_id]
        except KeyError as exc:
            raise KeyError(f"Unknown strategy: {strategy_id}") from exc

    def all(self) -> tuple[Strategy, ...]:
        return tuple(self._strategies.values())

    def metadata(self) -> list[dict[str, object]]:
        return [vars(item.metadata) for item in self.all()]


registry = StrategyRegistry()
registry.register(TrendBreakoutV1())
registry.register(PostEarningsV1())
