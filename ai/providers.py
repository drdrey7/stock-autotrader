from abc import ABC, abstractmethod

from ai.schemas import AiEventAssessment
from bot.models import StrategyDecision


class CandidateEventProvider(ABC):
    """Called only after deterministic quant screening; never controls sizing or hard risk."""

    @abstractmethod
    def assess(self, candidate: StrategyDecision) -> AiEventAssessment:
        """Return structured public rationale; never request or persist chain-of-thought."""
