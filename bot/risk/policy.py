from dataclasses import dataclass
from math import floor, isfinite

from bot.config import RiskConfig


class RiskPolicyError(ValueError):
    pass


@dataclass(frozen=True)
class PositionSize:
    quantity: int
    notional: float
    initial_risk: float
    risk_pct: float


class PositionSizer:
    def __init__(self, config: RiskConfig | None = None) -> None:
        self.config = config or RiskConfig()

    def size(self, equity: float, entry_price: float, stop_price: float) -> PositionSize:
        if not all(isfinite(value) for value in (equity, entry_price, stop_price)):
            raise RiskPolicyError("Equity and prices must be finite")
        if equity <= 0 or entry_price <= 0 or stop_price <= 0:
            raise RiskPolicyError("Equity and prices must be positive")
        per_share_risk = entry_price - stop_price
        if per_share_risk <= 0:
            raise RiskPolicyError("Stop must be below entry for a long position")
        risk_budget = equity * self.config.risk_per_trade_pct
        risk_quantity = floor(risk_budget / per_share_risk)
        exposure_quantity = floor((equity * self.config.max_single_position_pct) / entry_price)
        quantity = min(risk_quantity, exposure_quantity)
        if quantity < 1:
            raise RiskPolicyError("Position cannot be opened within risk and exposure limits")
        initial_risk = quantity * per_share_risk
        return PositionSize(
            quantity=quantity,
            notional=quantity * entry_price,
            initial_risk=initial_risk,
            risk_pct=initial_risk / equity,
        )
