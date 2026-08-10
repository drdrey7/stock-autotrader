import numpy as np
import pandas as pd
import pytest


@pytest.fixture
def ohlcv() -> pd.DataFrame:
    index = pd.date_range("2024-01-02", periods=320, freq="B", tz="UTC")
    trend = np.linspace(100, 180, len(index))
    wave = np.sin(np.arange(len(index)) / 9) * 2
    close = trend + wave
    return pd.DataFrame(
        {
            "open": close - 0.3,
            "high": close + 1.0,
            "low": close - 1.0,
            "close": close,
            "volume": np.linspace(1_000_000, 1_800_000, len(index)),
        },
        index=index,
    )
