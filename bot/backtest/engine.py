from dataclasses import dataclass
from enum import StrEnum
from math import isfinite

import numpy as np
import pandas as pd
from pandas.api.types import is_bool_dtype


class CostScenario(StrEnum):
    LOW_COST = "LOW_COST"
    NORMAL = "NORMAL"
    STRESS = "STRESS"


@dataclass(frozen=True)
class ExecutionCosts:
    commission_per_order: float
    spread_bps: float
    slippage_bps: float


COSTS = {
    CostScenario.LOW_COST: ExecutionCosts(0.0, 1.0, 1.0),
    CostScenario.NORMAL: ExecutionCosts(1.0, 3.0, 5.0),
    CostScenario.STRESS: ExecutionCosts(2.0, 8.0, 15.0),
}


@dataclass(frozen=True)
class Trade:
    signal_time: pd.Timestamp
    entry_time: pd.Timestamp
    exit_time: pd.Timestamp
    entry_price: float
    exit_price: float
    quantity: int
    pnl: float
    return_pct: float
    exit_reason: str


@dataclass(frozen=True)
class BacktestResult:
    trades: tuple[Trade, ...]
    equity_curve: pd.Series
    metrics: dict[str, float | None]
    scenario: CostScenario


class BacktestEngine:
    """Daily-bar baseline: signals at close execute no earlier than the next bar open."""

    def __init__(
        self,
        initial_capital: float = 100_000,
        risk_per_trade: float = 0.005,
        scenario: CostScenario = CostScenario.NORMAL,
    ) -> None:
        if not isfinite(initial_capital) or initial_capital <= 0:
            raise ValueError("Initial capital must be finite and positive")
        if not isfinite(risk_per_trade) or not 0 < risk_per_trade <= 1:
            raise ValueError("Risk per trade must be finite and in (0, 1]")
        self.initial_capital = initial_capital
        self.risk_per_trade = risk_per_trade
        self.scenario = scenario

    def run(
        self,
        bars: pd.DataFrame,
        entry_signal: pd.Series,
        stop_distance: pd.Series,
        max_holding_bars: int = 20,
    ) -> BacktestResult:
        if max_holding_bars < 1:
            raise ValueError("Maximum holding bars must be at least one")
        required = {"open", "high", "low", "close"}
        if missing := required.difference(bars.columns):
            raise ValueError(f"Missing columns: {sorted(missing)}")
        if bars.empty or not bars.index.is_monotonic_increasing or bars.index.has_duplicates:
            raise ValueError("Backtest index must be non-empty, unique and increasing")
        if not isinstance(bars.index, pd.DatetimeIndex) or bars.index.tz is None:
            raise ValueError("Backtest index must be a timezone-aware DatetimeIndex")
        if not bars.index.equals(entry_signal.index) or not bars.index.equals(stop_distance.index):
            raise ValueError("Bars, signals and stop distances must share the same point-in-time index")
        if not is_bool_dtype(entry_signal.dtype) or entry_signal.isna().any():
            raise ValueError("Entry signals must be non-null booleans")
        price_frame = bars[list(required)]
        if not np.isfinite(price_frame.to_numpy(dtype=float)).all() or (price_frame <= 0).any().any():
            raise ValueError("OHLC prices must be finite and positive")
        required_stops = stop_distance.iloc[:-1][entry_signal.iloc[:-1].to_numpy(dtype=bool)]
        if not np.isfinite(required_stops.to_numpy(dtype=float)).all() or (required_stops <= 0).any():
            raise ValueError("Stop distances must be finite and positive")
        costs = COSTS[self.scenario]
        cash, trades, pending, position = self.initial_capital, [], False, None
        curve: list[float] = []
        for index, (timestamp, row) in enumerate(bars.iterrows()):
            if pending and position is None:
                raw_entry = float(row["open"])
                entry = raw_entry * (1 + (costs.spread_bps / 2 + costs.slippage_bps) / 10_000)
                distance = float(stop_distance.iloc[index - 1])
                quantity = int((cash * self.risk_per_trade) // distance) if distance > 0 else 0
                affordable_cash = cash - costs.commission_per_order
                quantity = min(quantity, int(affordable_cash // entry) if affordable_cash > 0 else 0)
                if quantity > 0:
                    position = {
                        "signal_time": bars.index[index - 1],
                        "entry_time": timestamp,
                        "entry": entry,
                        "stop": entry - distance,
                        "quantity": quantity,
                        "bars": 0,
                    }
                    cash -= quantity * entry + costs.commission_per_order
                pending = False
            if position is not None:
                position["bars"] += 1
                exit_price, reason = None, None
                if float(row["open"]) <= position["stop"]:
                    exit_price, reason = float(row["open"]), "GAP_THROUGH_STOP"
                elif float(row["low"]) <= position["stop"]:
                    exit_price, reason = position["stop"], "STOP"
                elif position["bars"] >= max_holding_bars:
                    exit_price, reason = float(row["close"]), "TIME_EXIT"
                elif index == len(bars) - 1:
                    exit_price, reason = float(row["close"]), "END_OF_DATA"
                if exit_price is not None and reason is not None:
                    exit_price *= 1 - (costs.spread_bps / 2 + costs.slippage_bps) / 10_000
                    proceeds = position["quantity"] * exit_price - costs.commission_per_order
                    # `proceeds` already includes the exit commission. Deduct the
                    # separately paid entry commission once to reconcile trade P&L
                    # with the cash/equity ledger.
                    pnl = proceeds - position["quantity"] * position["entry"] - costs.commission_per_order
                    entry_cost = position["quantity"] * position["entry"] + costs.commission_per_order
                    trades.append(
                        Trade(
                            signal_time=position["signal_time"],
                            entry_time=position["entry_time"],
                            exit_time=timestamp,
                            entry_price=position["entry"],
                            exit_price=exit_price,
                            quantity=position["quantity"],
                            pnl=pnl,
                            return_pct=pnl / entry_cost,
                            exit_reason=reason,
                        )
                    )
                    cash += proceeds
                    position = None
            if index < len(bars) - 1 and position is None and bool(entry_signal.iloc[index]):
                pending = True
            marked = cash + (position["quantity"] * float(row["close"]) if position is not None else 0)
            curve.append(marked)
        equity_curve = pd.Series(curve, index=bars.index, name="equity")
        return BacktestResult(
            trades=tuple(trades),
            equity_curve=equity_curve,
            metrics=self._metrics(equity_curve, trades),
            scenario=self.scenario,
        )

    def _metrics(self, equity: pd.Series, trades: list[Trade]) -> dict[str, float | None]:
        total_return = equity.iloc[-1] / equity.iloc[0] - 1
        years = max(len(equity) / 252, 1 / 252)
        cagr = (equity.iloc[-1] / equity.iloc[0]) ** (1 / years) - 1
        drawdown = equity / equity.cummax() - 1
        daily_returns = equity.pct_change(fill_method=None).dropna()
        downside = daily_returns[daily_returns < 0]
        return_std = float(daily_returns.std())
        sharpe = (
            float(np.sqrt(252) * daily_returns.mean() / return_std)
            if np.isfinite(return_std) and return_std > 0
            else 0.0
        )
        downside_std = float(downside.std())
        sortino = (
            float(np.sqrt(252) * daily_returns.mean() / downside_std)
            if len(downside) > 1 and np.isfinite(downside_std) and downside_std > 0
            else 0.0
        )
        wins = [trade.pnl for trade in trades if trade.pnl > 0]
        losses = [trade.pnl for trade in trades if trade.pnl <= 0]
        gross_profit, gross_loss = sum(wins), abs(sum(losses))
        return {
            "cagr": float(cagr),
            "total_return": float(total_return),
            "max_drawdown": float(drawdown.min()),
            "sharpe": sharpe,
            "sortino": sortino,
            "calmar": float(cagr / abs(drawdown.min())) if drawdown.min() < 0 else 0.0,
            "trades": float(len(trades)),
            "win_rate": len(wins) / len(trades) if trades else 0.0,
            "average_win": float(np.mean(wins)) if wins else 0.0,
            "average_loss": float(np.mean(losses)) if losses else 0.0,
            "profit_factor": gross_profit / gross_loss if gross_loss else None,
            "expectancy": float(np.mean([trade.pnl for trade in trades])) if trades else 0.0,
        }
