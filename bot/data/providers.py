from abc import ABC, abstractmethod
from datetime import datetime

import pandas as pd


class MarketDataProvider(ABC):
    @abstractmethod
    def history(self, symbol: str, start: datetime, end: datetime) -> pd.DataFrame:
        """Return split/dividend-adjusted OHLCV known by `end`, with UTC timestamps."""

    @abstractmethod
    def universe(self, as_of: datetime) -> pd.DataFrame:
        """Return point-in-time universe membership, never today's constituents for old dates."""
