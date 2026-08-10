from bot.config import UniverseBucket
from bot.models import SecuritySnapshot
from bot.screening import filter_universe


def security(
    symbol: str, market_cap: float, price: float = 20, volume: float = 20_000_000, kind: str = "COMMON_STOCK"
) -> SecuritySnapshot:
    return SecuritySnapshot(
        symbol=symbol,
        company=symbol,
        market_cap=market_cap,
        price=price,
        median_dollar_volume_20d=volume,
        security_type=kind,
    )


def test_core_and_future_buckets_never_mix() -> None:
    result = filter_universe(
        [
            security("CORE", 2_000_000_000),
            security("MID", 700_000_000),
            security("ETF", 9_000_000_000, kind="ETF"),
            security("LOW", 2_000_000_000, volume=2_000_000),
        ]
    )
    assert [item.symbol for item in result[UniverseBucket.CORE]] == ["CORE"]
    assert [item.symbol for item in result[UniverseBucket.FUTURE_MID_CAP]] == ["MID"]
