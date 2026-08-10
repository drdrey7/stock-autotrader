from bot.config import UniverseBucket, UniverseConfig
from bot.models import SecuritySnapshot


def filter_universe(
    securities: list[SecuritySnapshot], config: UniverseConfig | None = None
) -> dict[UniverseBucket, list[SecuritySnapshot]]:
    rules = config or UniverseConfig()
    buckets: dict[UniverseBucket, list[SecuritySnapshot]] = {
        UniverseBucket.CORE: [],
        UniverseBucket.FUTURE_MID_CAP: [],
    }
    for security in securities:
        if security.security_type.upper() in rules.excluded_security_types:
            continue
        if (
            security.price < rules.min_price
            or security.median_dollar_volume_20d < rules.min_median_dollar_volume_20d
        ):
            continue
        if security.market_cap >= rules.min_market_cap:
            buckets[UniverseBucket.CORE].append(security)
        elif security.market_cap >= rules.future_bucket_min_market_cap:
            buckets[UniverseBucket.FUTURE_MID_CAP].append(security)
    return buckets
