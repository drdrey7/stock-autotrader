import numpy as np
import pandas as pd

REQUIRED_COLUMNS = frozenset({"open", "high", "low", "close", "volume"})


def _validate(frame: pd.DataFrame) -> pd.DataFrame:
    missing = REQUIRED_COLUMNS.difference(frame.columns)
    if missing:
        raise ValueError(f"Missing OHLCV columns: {', '.join(sorted(missing))}")
    if len(frame) < 2:
        raise ValueError("At least two bars are required")
    if not frame.index.is_monotonic_increasing or frame.index.has_duplicates:
        raise ValueError("OHLCV index must be unique and increasing")
    return frame.astype({column: "float64" for column in REQUIRED_COLUMNS})


def ema(close: pd.Series, window: int) -> pd.Series:
    return close.ewm(span=window, adjust=False, min_periods=window).mean()


def atr(frame: pd.DataFrame, window: int = 14) -> pd.Series:
    previous_close = frame["close"].shift(1)
    true_range = pd.concat(
        [
            (frame["high"] - frame["low"]),
            (frame["high"] - previous_close).abs(),
            (frame["low"] - previous_close).abs(),
        ],
        axis=1,
    ).max(axis=1)
    return true_range.rolling(window, min_periods=window).mean()


def momentum(close: pd.Series, sessions: int) -> pd.Series:
    return close.pct_change(sessions, fill_method=None)


def relative_strength(close: pd.Series, benchmark_close: pd.Series, sessions: int = 63) -> pd.Series:
    aligned = pd.concat([close.rename("asset"), benchmark_close.rename("benchmark")], axis=1).ffill()
    return momentum(aligned["asset"], sessions) - momentum(aligned["benchmark"], sessions)


def swing_points(frame: pd.DataFrame, radius: int = 2) -> tuple[pd.Series, pd.Series]:
    if radius < 1:
        raise ValueError("Swing-point radius must be at least one bar")
    window = radius * 2 + 1
    # A centred window identifies the pivot itself, but the pivot is not knowable
    # until `radius` later bars have closed. Publish the flag on that confirmation
    # bar so every feature at time t uses data available at or before t.
    pivot_high = frame["high"].eq(frame["high"].rolling(window, center=True).max())
    pivot_low = frame["low"].eq(frame["low"].rolling(window, center=True).min())
    swing_high = pivot_high.shift(radius, fill_value=False)
    swing_low = pivot_low.shift(radius, fill_value=False)
    return swing_high.fillna(False), swing_low.fillna(False)


def basic_market_regime(benchmark: pd.DataFrame) -> pd.Series:
    benchmark = _validate(benchmark)
    ema_50 = ema(benchmark["close"], 50)
    ema_200 = ema(benchmark["close"], 200)
    return (benchmark["close"] > ema_200) & (ema_50 > ema_200)


def calculate_features(frame: pd.DataFrame, spy: pd.DataFrame, qqq: pd.DataFrame) -> pd.DataFrame:
    data = _validate(frame).copy()
    spy_data, qqq_data = _validate(spy), _validate(qqq)
    for window in (20, 50, 100, 200):
        data[f"ema{window}"] = ema(data["close"], window)
    data["atr14"] = atr(data)
    data["atr_pct"] = data["atr14"] / data["close"]
    for label, sessions in (("1m", 21), ("3m", 63), ("6m", 126), ("12m", 252)):
        data[f"momentum_{label}"] = momentum(data["close"], sessions)
    data["rs_spy"] = relative_strength(data["close"], spy_data["close"])
    data["rs_qqq"] = relative_strength(data["close"], qqq_data["close"])
    data["adv20"] = (data["close"] * data["volume"]).rolling(20, min_periods=20).mean()
    data["median_dollar_volume20"] = (data["close"] * data["volume"]).rolling(20, min_periods=20).median()
    data["relative_volume"] = data["volume"] / data["volume"].rolling(20, min_periods=20).mean().shift(1)
    data["prior_high_20d"] = data["high"].rolling(20, min_periods=20).max().shift(1)
    data["prior_high_50d"] = data["high"].rolling(50, min_periods=50).max().shift(1)
    data["breakout_20d"] = data["close"] > data["prior_high_20d"]
    data["breakout_50d"] = data["close"] > data["prior_high_50d"]
    data["swing_high"], data["swing_low"] = swing_points(data)
    data["market_regime_positive"] = basic_market_regime(spy_data).reindex(data.index).ffill().fillna(False)
    return data.replace([np.inf, -np.inf], np.nan)
