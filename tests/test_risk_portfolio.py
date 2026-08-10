from datetime import UTC, datetime

import pytest
from pydantic import ValidationError

from bot.config import RiskConfig
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
        portfolio.open_position(
            " nvda ", "technology", "trend_breakout_v1", "1.0.0", 90, 85, datetime.now(UTC)
        )


def test_shadow_portfolio_enforces_gross_and_normalized_sector_exposure() -> None:
    gross_limited = ShadowPortfolio(RiskConfig(max_gross_exposure_pct=0.2, max_single_position_pct=0.2))
    gross_limited.open_position("AAA", "Technology", "s", "1", 100, 99, datetime.now(UTC))
    with pytest.raises(RiskPolicyError, match="gross exposure"):
        gross_limited.open_position("BBB", "Healthcare", "s", "1", 100, 99, datetime.now(UTC))

    sector_limited = ShadowPortfolio(RiskConfig(max_sector_exposure_pct=0.3))
    sector_limited.open_position("AAA", "Technology", "s", "1", 100, 99, datetime.now(UTC))
    with pytest.raises(RiskPolicyError, match="sector exposure"):
        sector_limited.open_position("BBB", " technology ", "s", "1", 100, 99, datetime.now(UTC))


@pytest.mark.parametrize("price", [0.0, -1.0, float("nan"), float("inf")])
def test_shadow_portfolio_rejects_invalid_marks(price: float) -> None:
    portfolio = ShadowPortfolio()
    portfolio.open_position("NVDA", "Technology", "s", "1", 100, 95, datetime.now(UTC))
    with pytest.raises(RiskPolicyError):
        portfolio.mark("NVDA", price)
    with pytest.raises(RiskPolicyError):
        portfolio.close_position("NVDA", price)


@pytest.mark.parametrize(
    "overrides",
    [
        {"initial_capital": 0},
        {"max_positions": 0},
        {"max_open_risk_pct": float("nan")},
        {"max_gross_exposure_pct": 1.1},
        {"max_single_position_pct": 0},
        {"max_sector_exposure_pct": float("inf")},
        {"risk_per_trade_pct": 0.02, "max_open_risk_pct": 0.01},
    ],
)
def test_risk_config_fails_closed_for_invalid_hard_limits(overrides: dict[str, float]) -> None:
    with pytest.raises(ValidationError):
        RiskConfig(**overrides)
