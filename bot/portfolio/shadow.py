from datetime import datetime
from uuid import uuid4

from pydantic import BaseModel

from bot.config import RiskConfig
from bot.risk import PositionSizer, RiskPolicyError


class ShadowPosition(BaseModel):
    id: str
    symbol: str
    sector: str
    strategy_id: str
    strategy_version: str
    entry_price: float
    current_price: float
    stop_price: float
    quantity: int
    initial_risk: float
    opened_at: datetime
    unrealized_pnl: float = 0
    r_multiple: float = 0


class ShadowPortfolio:
    def __init__(self, config: RiskConfig | None = None) -> None:
        self.config = config or RiskConfig()
        self.cash = self.config.initial_capital
        self.realized_pnl = 0.0
        self.positions: dict[str, ShadowPosition] = {}
        self.sizer = PositionSizer(self.config)

    @property
    def equity(self) -> float:
        return self.cash + sum(
            position.quantity * position.current_price for position in self.positions.values()
        )

    @property
    def open_risk(self) -> float:
        return sum(position.initial_risk for position in self.positions.values())

    def open_position(
        self,
        symbol: str,
        sector: str,
        strategy_id: str,
        strategy_version: str,
        entry_price: float,
        stop_price: float,
        opened_at: datetime,
    ) -> ShadowPosition:
        if symbol in self.positions:
            raise RiskPolicyError("Averaging down and duplicate positions are disabled")
        if len(self.positions) >= self.config.max_positions:
            raise RiskPolicyError("Maximum position count reached")
        sized = self.sizer.size(self.equity, entry_price, stop_price)
        if self.open_risk + sized.initial_risk > self.equity * self.config.max_open_risk_pct:
            raise RiskPolicyError("Maximum open risk exceeded")
        sector_exposure = sum(
            p.quantity * p.current_price for p in self.positions.values() if p.sector == sector
        )
        if sector_exposure + sized.notional > self.equity * self.config.max_sector_exposure_pct:
            raise RiskPolicyError("Maximum sector exposure exceeded")
        if sized.notional > self.cash:
            raise RiskPolicyError("No leverage: insufficient simulated cash")
        position = ShadowPosition(
            id=str(uuid4()),
            symbol=symbol,
            sector=sector,
            strategy_id=strategy_id,
            strategy_version=strategy_version,
            entry_price=entry_price,
            current_price=entry_price,
            stop_price=stop_price,
            quantity=sized.quantity,
            initial_risk=sized.initial_risk,
            opened_at=opened_at,
        )
        self.cash -= sized.notional
        self.positions[symbol] = position
        return position

    def mark(self, symbol: str, price: float) -> ShadowPosition:
        position = self.positions[symbol]
        position.current_price = price
        position.unrealized_pnl = (price - position.entry_price) * position.quantity
        position.r_multiple = position.unrealized_pnl / position.initial_risk
        return position

    def close_position(self, symbol: str, exit_price: float) -> float:
        position = self.positions.pop(symbol)
        proceeds = position.quantity * exit_price
        pnl = (exit_price - position.entry_price) * position.quantity
        self.cash += proceeds
        self.realized_pnl += pnl
        return pnl
