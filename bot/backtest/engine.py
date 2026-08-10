from dataclasses import dataclass
from enum import StrEnum

import numpy as np
import pandas as pd


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
    metrics: dict[str, float]
    scenario: CostScenario


class BacktestEngine:
    """Daily-bar baseline: signals at close execute no earlier than the next bar open."""

    def __init__(
        self,
        initial_capital: float = 100_000,
        risk_per_trade: float = 0.005,
        scenario: CostScenario = CostScenario.NORMAL,
    ) -> None:
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
        required = {"open", "high", "low", "close"}
        if missing := required.difference(bars.columns):
            raise ValueError(f"Missing columns: {sorted(missing)}")
        if not bars.index.equals(entry_signal.index) or not bars.index.equals(stop_distance.index):
            raise ValueError("Bars, signals and stop distances must share the same point-in-time index")
        costs = COSTS[self.scenario]
        cash, trades, pending, position = self.initial_capital, [], False, None
        curve: list[float] = []
        for index, (timestamp, row) in enumerate(bars.iterrows()):
            if pending and position is None:
                raw_entry = float(row["open"])
                entry = raw_entry * (1 + (costs.spread_bps / 2 + costs.slippage_bps) / 10_000)
                distance = float(stop_distance.iloc[index - 1])
                quantity = int((cash * self.risk_per_trade) // distance) if distance > 0 else 0
                quantity = min(quantity, int(cash // entry))
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
                if exit_price is not None and reason is not None:
                    exit_price *= 1 - (costs.spread_bps / 2 + costs.slippage_bps) / 10_000
                    proceeds = position["quantity"] * exit_price - costs.commission_per_order
                    pnl = proceeds - position["quantity"] * position["entry"] - 2 * costs.commission_per_order
                    trades.append(
                        Trade(
                            signal_time=position["signal_time"],
                            entry_time=position["entry_time"],
                            exit_time=timestamp,
                            entry_price=position["entry"],
                            exit_price=exit_price,
                            quantity=position["quantity"],
                            pnl=pnl,
                            return_pct=exit_price / position["entry"] - 1,
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

    def _metrics(self, equity: pd.Series, trades: list[Trade]) -> dict[str, float]:
        total_return = equity.iloc[-1] / equity.iloc[0] - 1
        years = max(len(equity) / 252, 1 / 252)
        cagr = (equity.iloc[-1] / equity.iloc[0]) ** (1 / years) - 1
        drawdown = equity / equity.cummax() - 1
        daily_returns = equity.pct_change(fill_method=None).dropna()
        downside = daily_returns[daily_returns < 0]
        sharpe = (
            float(np.sqrt(252) * daily_returns.mean() / daily_returns.std()) if daily_returns.std() else 0.0
        )
        sortino = (
            float(np.sqrt(252) * daily_returns.mean() / downside.std())
            if len(downside) > 1 and downside.std()
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
            "profit_factor": gross_profit / gross_loss if gross_loss else 0.0,
            "expectancy": float(np.mean([trade.pnl for trade in trades])) if trades else 0.0,
        }
