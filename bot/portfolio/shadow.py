from datetime import datetime
from math import isfinite
from uuid import uuid4

from pydantic import AwareDatetime, BaseModel

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
    opened_at: AwareDatetime
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
        symbol = symbol.strip().upper()
        sector = sector.strip()
        sector_key = sector.casefold()
        if symbol in self.positions:
            raise RiskPolicyError("Averaging down and duplicate positions are disabled")
        if len(self.positions) >= self.config.max_positions:
            raise RiskPolicyError("Maximum position count reached")
        sized = self.sizer.size(self.equity, entry_price, stop_price)
        if self.open_risk + sized.initial_risk > self.equity * self.config.max_open_risk_pct:
            raise RiskPolicyError("Maximum open risk exceeded")
        gross_exposure = sum(p.quantity * p.current_price for p in self.positions.values())
        if gross_exposure + sized.notional > self.equity * self.config.max_gross_exposure_pct:
            raise RiskPolicyError("Maximum gross exposure exceeded")
        sector_exposure = sum(
            p.quantity * p.current_price for p in self.positions.values() if p.sector.casefold() == sector_key
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
        if not isfinite(price) or price <= 0:
            raise RiskPolicyError("Mark price must be finite and positive")
        position = self.positions[symbol.strip().upper()]
        position.current_price = price
        position.unrealized_pnl = (price - position.entry_price) * position.quantity
        position.r_multiple = position.unrealized_pnl / position.initial_risk
        return position

    def close_position(self, symbol: str, exit_price: float) -> float:
        if not isfinite(exit_price) or exit_price <= 0:
            raise RiskPolicyError("Exit price must be finite and positive")
        position = self.positions.pop(symbol.strip().upper())
        proceeds = position.quantity * exit_price
        pnl = (exit_price - position.entry_price) * position.quantity
        self.cash += proceeds
        self.realized_pnl += pnl
        return pnl
