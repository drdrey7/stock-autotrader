import pandas as pd
import pytest

from bot.backtest import BacktestEngine, CostScenario


def test_signal_executes_at_next_open_and_gap_through_stop() -> None:
    index = pd.date_range("2026-01-05", periods=5, freq="B", tz="UTC")
    bars = pd.DataFrame(
        {
            "open": [100, 110, 100, 99, 100],
            "high": [102, 112, 103, 101, 102],
            "low": [99, 108, 98, 97, 99],
            "close": [101, 111, 101, 100, 101],
        },
        index=index,
    )
    signal = pd.Series([True, False, False, False, False], index=index)
    stop = pd.Series([5.0] * len(index), index=index)
    result = BacktestEngine(scenario=CostScenario.LOW_COST).run(bars, signal, stop)
    assert len(result.trades) == 1
    trade = result.trades[0]
    assert trade.signal_time == index[0]
    assert trade.entry_time == index[1]
    assert trade.entry_price == pytest.approx(110 * 1.00015)
    assert trade.exit_time == index[2]
    assert trade.exit_price == pytest.approx(100 * 0.99985)
    assert trade.exit_reason == "GAP_THROUGH_STOP"
