import sys
import types
import unittest
from unittest.mock import patch

from bot.config import Settings
from bot.publishing import _public_engine_status, publish_system_status


class PublishingTests(unittest.TestCase):
    def test_degraded_runtime_maps_to_valid_public_engine_state(self):
        settings = Settings(bot_env="production", ingest_secret="")
        self.assertEqual(_public_engine_status(settings), "delayed")

    def test_healthy_runtime_maps_to_online(self):
        settings = Settings(bot_env="production", ingest_secret="real-value")
        self.assertEqual(_public_engine_status(settings), "online")

    def test_status_omits_unknown_data_timestamp(self):
        captured = {}

        def make_event(event_type, payload):
            captured.update(payload)
            return {"type": event_type, "payload": payload}

        fake_publisher = types.SimpleNamespace(
            client=types.SimpleNamespace(make_event=make_event)
        )
        settings = Settings(bot_env="production", ingest_secret="real-value")
        with patch.dict(sys.modules, {"publisher": fake_publisher}), patch(
            "bot.publishing.publish_events", return_value={"ok": True}
        ):
            publish_system_status(settings)
        self.assertNotIn("lastDataUpdate", captured)

    def test_status_preserves_supplied_data_timestamp(self):
        captured = {}

        def make_event(event_type, payload):
            captured.update(payload)
            return {"type": event_type, "payload": payload}

        fake_publisher = types.SimpleNamespace(
            client=types.SimpleNamespace(make_event=make_event)
        )
        timestamp = "2026-08-11T12:00:00Z"
        settings = Settings(bot_env="production", ingest_secret="real-value")
        with patch.dict(sys.modules, {"publisher": fake_publisher}), patch(
            "bot.publishing.publish_events", return_value={"ok": True}
        ):
            publish_system_status(settings, timestamp)
        self.assertEqual(captured["lastDataUpdate"], timestamp)


if __name__ == "__main__":
    unittest.main()
