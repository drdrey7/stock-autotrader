from bot.service import health


def test_private_health_discloses_no_infrastructure() -> None:
    assert health().model_dump() == {"status": "ok", "strategies_loaded": 2}
