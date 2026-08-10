from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any

from bot.models import StrategyContext, StrategyDecision


def feature_number(context: StrategyContext, key: str, default: float) -> float:
    value = context.features.get(key)
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else default


@dataclass(frozen=True)
class StrategyMetadata:
    id: str
    name: str
    version: str
    description: str
    lifecycle_state: str
    universe: str
    holding_period: str
    parameters: dict[str, str | int | float | bool]


class Strategy(ABC):
    metadata: StrategyMetadata

    @abstractmethod
    def screen(self, context: StrategyContext) -> bool:
        """Cheap deterministic eligibility check before full signal generation."""

    @abstractmethod
    def generate_signal(self, context: StrategyContext) -> StrategyDecision:
        """Return a public, structured decision without private chain-of-thought."""

    @abstractmethod
    def calculate_stop(self, context: StrategyContext) -> float | None:
        """Calculate a deterministic stop from market data."""

    @abstractmethod
    def exit_signal(self, context: StrategyContext, position: dict[str, Any]) -> bool:
        """Return True when deterministic exit conditions are met."""
