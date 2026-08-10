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


def test_trade_pnl_reconciles_with_equity_after_two_commissions() -> None:
    index = pd.date_range("2026-01-05", periods=3, freq="B", tz="UTC")
    bars = pd.DataFrame(
        {
            "open": [100.0, 100.0, 100.0],
            "high": [101.0, 101.0, 101.0],
            "low": [99.0, 99.0, 99.0],
            "close": [100.0, 100.0, 100.0],
        },
        index=index,
    )
    signal = pd.Series([True, False, False], index=index)
    stop = pd.Series([50.0, 50.0, 50.0], index=index)
    result = BacktestEngine(scenario=CostScenario.NORMAL).run(bars, signal, stop, max_holding_bars=2)

    assert len(result.trades) == 1
    assert result.trades[0].pnl == pytest.approx(
        result.equity_curve.iloc[-1] - BacktestEngine().initial_capital
    )
    entry_cost = result.trades[0].quantity * result.trades[0].entry_price + 1.0
    assert result.trades[0].return_pct == pytest.approx(result.trades[0].pnl / entry_cost)


def test_backtest_rejects_descending_or_naive_time_index() -> None:
    descending = pd.date_range("2026-01-05", periods=3, freq="B", tz="UTC")[::-1]
    bars = pd.DataFrame({"open": 100.0, "high": 101.0, "low": 99.0, "close": 100.0}, index=descending)
    signal = pd.Series([True, False, False], index=descending)
    stop = pd.Series([5.0] * 3, index=descending)
    with pytest.raises(ValueError, match="unique and increasing"):
        BacktestEngine().run(bars, signal, stop)

    naive = descending.tz_localize(None)[::-1]
    bars.index = signal.index = stop.index = naive
    with pytest.raises(ValueError, match="timezone-aware"):
        BacktestEngine().run(bars, signal, stop)


def test_entry_affordability_reserves_commission() -> None:
    index = pd.date_range("2026-01-05", periods=2, freq="B", tz="UTC")
    bars = pd.DataFrame(
        {"open": [99.0, 99.0], "high": [100.0, 100.0], "low": [98.0, 98.0], "close": [99.0, 99.0]},
        index=index,
    )
    signal = pd.Series([True, False], index=index)
    stop = pd.Series([1.0, 1.0], index=index)
    result = BacktestEngine(initial_capital=100.0, risk_per_trade=0.02, scenario=CostScenario.NORMAL).run(
        bars, signal, stop
    )
    assert result.equity_curve.iloc[-1] == pytest.approx(100.0)


def test_open_position_is_closed_and_auditable_at_end_of_data() -> None:
    index = pd.date_range("2026-01-05", periods=3, freq="B", tz="UTC")
    bars = pd.DataFrame(
        {
            "open": [100.0, 101.0, 102.0],
            "high": [101.0, 102.0, 103.0],
            "low": [99.0, 100.0, 101.0],
            "close": [100.0, 102.0, 103.0],
        },
        index=index,
    )
    signal = pd.Series([True, False, False], index=index)
    stop = pd.Series([10.0] * 3, index=index)
    result = BacktestEngine(scenario=CostScenario.LOW_COST).run(bars, signal, stop, max_holding_bars=20)
    assert len(result.trades) == 1
    assert result.trades[0].exit_reason == "END_OF_DATA"
    assert result.metrics["trades"] == 1


def test_backtest_rejects_missing_signal_or_nonfinite_prices() -> None:
    index = pd.date_range("2026-01-05", periods=2, freq="B", tz="UTC")
    bars = pd.DataFrame(
        {"open": [100.0, 100.0], "high": [101.0, 101.0], "low": [99.0, 99.0], "close": [100.0, 100.0]},
        index=index,
    )
    stop = pd.Series([5.0, 5.0], index=index)
    with pytest.raises(ValueError, match="non-null booleans"):
        BacktestEngine().run(bars, pd.Series([True, None], index=index), stop)
    bars.loc[index[1], "open"] = float("nan")
    with pytest.raises(ValueError, match="finite and positive"):
        BacktestEngine().run(bars, pd.Series([True, False], index=index), stop)


def test_stop_warmup_nans_are_allowed_without_signals() -> None:
    index = pd.date_range("2026-01-05", periods=3, freq="B", tz="UTC")
    bars = pd.DataFrame(
        {"open": [100.0] * 3, "high": [101.0] * 3, "low": [99.0] * 3, "close": [100.0] * 3},
        index=index,
    )
    signal = pd.Series([False, True, False], index=index)
    stop = pd.Series([float("nan"), 5.0, float("nan")], index=index)
    result = BacktestEngine(scenario=CostScenario.LOW_COST).run(bars, signal, stop)
    assert result.trades[0].entry_time == index[2]


def test_undefined_metrics_are_null_not_nonfinite_or_misleading() -> None:
    index = pd.date_range("2026-01-05", periods=2, freq="B", tz="UTC")
    bars = pd.DataFrame(
        {"open": [100.0, 100.0], "high": [101.0, 102.0], "low": [99.0, 99.0], "close": [100.0, 101.0]},
        index=index,
    )
    result = BacktestEngine(scenario=CostScenario.LOW_COST).run(
        bars,
        pd.Series([True, False], index=index),
        pd.Series([10.0, 10.0], index=index),
    )
    assert result.trades[0].pnl > 0
    assert result.metrics["profit_factor"] is None
    assert result.metrics["sharpe"] == 0.0


@pytest.mark.parametrize(
    ("capital", "risk"),
    [(0.0, 0.01), (-1.0, 0.01), (float("inf"), 0.01), (100.0, 0.0), (100.0, 1.1)],
)
def test_backtest_rejects_invalid_configuration(capital: float, risk: float) -> None:
    with pytest.raises(ValueError):
        BacktestEngine(initial_capital=capital, risk_per_trade=risk)


def test_backtest_rejects_nonpositive_holding_period() -> None:
    index = pd.date_range("2026-01-05", periods=2, freq="B", tz="UTC")
    bars = pd.DataFrame(
        {"open": [100.0] * 2, "high": [101.0] * 2, "low": [99.0] * 2, "close": [100.0] * 2},
        index=index,
    )
    with pytest.raises(ValueError, match="at least one"):
        BacktestEngine().run(
            bars,
            pd.Series([False, False], index=index),
            pd.Series([5.0, 5.0], index=index),
            max_holding_bars=0,
        )
