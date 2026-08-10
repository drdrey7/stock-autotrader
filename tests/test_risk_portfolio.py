from datetime import UTC, datetime

import pytest

from bot.portfolio import ShadowPortfolio
from bot.risk import PositionSizer, RiskPolicyError


def test_position_size_obeys_risk_and_exposure() -> None:
    size = PositionSizer().size(equity=5_000, entry_price=100, stop_price=95)
    assert size.quantity == 5
    assert size.initial_risk == 25
    assert size.notional <= 1_500


def test_shadow_portfolio_forbids_duplicate_and_leverage() -> None:
    portfolio = ShadowPortfolio()
    portfolio.open_position("NVDA", "Technology", "trend_breakout_v1", "1.0.0", 100, 95, datetime.now(UTC))
    with pytest.raises(RiskPolicyError, match="Averaging down"):
        portfolio.open_position("NVDA", "Technology", "trend_breakout_v1", "1.0.0", 90, 85, datetime.now(UTC))
