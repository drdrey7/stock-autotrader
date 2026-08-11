import unittest

from bot.publishing import _public_engine_status
from bot.config import Settings


class PublishingTests(unittest.TestCase):
    def test_degraded_runtime_maps_to_valid_public_engine_state(self):
        settings = Settings(bot_env="production", ingest_secret="")
        self.assertEqual(_public_engine_status(settings), "delayed")

    def test_healthy_runtime_maps_to_online(self):
        settings = Settings(bot_env="production", ingest_secret="real-value")
        self.assertEqual(_public_engine_status(settings), "online")


if __name__ == "__main__":
    unittest.main()
