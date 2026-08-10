import numpy as np
import pandas as pd

from bot.features import calculate_features


def test_calculates_required_features_without_lookahead(ohlcv: pd.DataFrame) -> None:
    spy = ohlcv.copy()
    qqq = ohlcv.copy()
    features = calculate_features(ohlcv, spy, qqq)
    required = {
        "ema20",
        "ema50",
        "ema100",
        "ema200",
        "atr14",
        "atr_pct",
        "momentum_1m",
        "momentum_3m",
        "momentum_6m",
        "momentum_12m",
        "rs_spy",
        "rs_qqq",
        "adv20",
        "median_dollar_volume20",
        "relative_volume",
        "prior_high_20d",
        "prior_high_50d",
        "swing_high",
        "swing_low",
        "breakout_20d",
        "breakout_50d",
        "market_regime_positive",
    }
    assert required.issubset(features.columns)
    last = features.index[-1]
    expected_prior_high = ohlcv["high"].iloc[-21:-1].max()
    assert features.loc[last, "prior_high_20d"] == expected_prior_high
    assert np.isfinite(features.loc[last, "atr_pct"])


def test_rejects_unsorted_or_incomplete_data(ohlcv: pd.DataFrame) -> None:
    incomplete = ohlcv.drop(columns="volume")
    try:
        calculate_features(incomplete, ohlcv, ohlcv)
    except ValueError as error:
        assert "volume" in str(error)
    else:
        raise AssertionError("Incomplete data must fail closed")
