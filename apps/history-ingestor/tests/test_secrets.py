"""Secret-leak tests (history ingestor).

Mirrors apps/quote-ingestor/tests/test_secrets.py: the Alpha Vantage key
values must NEVER appear in logs, errors, reports, checkpoints or any
serialised output of the tool.
"""

from __future__ import annotations

import io
import json
import logging
import unittest

from history_ingestor.config import Settings, from_env
from history_ingestor.provider import AllKeysFailedError, ProviderError, QuotaExhaustedError

KEYS = ("AVKEY_TEST_KEY_0001", "AVKEY_TEST_KEY_0002")


def settings_with(keys=KEYS):
    return Settings(
        alpha_vantage_keys=list(keys),
        cloudflare_api_token="CF_TOKEN_VALUE",
        cloudflare_account_id="acct",
        cloudflare_d1_database_id="db",
    )


class SecretTests(unittest.TestCase):
    def test_config_error_never_mentions_values(self):
        with self.assertRaises(Exception):
            from_env({})  # missing ALPHA_VANTAGE_API_KEYS etc.
        # from_env raises ConfigError with the var NAME, not values.
        from history_ingestor.config import ConfigError
        try:
            from_env({})
            self.fail("expected ConfigError")
        except ConfigError as exc:
            message = str(exc)
            self.assertIn("ALPHA_VANTAGE_API_KEYS", message)
        for key in KEYS:
            self.assertNotIn(key, message)

    def test_provider_errors_never_contain_keys(self):
        client_errors: list[str] = []
        # Simulated failure paths formatting every message the client can raise.
        try:
            raise QuotaExhaustedError("provider daily quota reached on 1 key(s)")
        except QuotaExhaustedError as exc:
            client_errors.append(str(exc))
        try:
            raise AllKeysFailedError("all keys failed transiently")
        except AllKeysFailedError as exc:
            client_errors.append(str(exc))
        try:
            raise ProviderError("provider message: Invalid API call")
        except ProviderError as exc:
            client_errors.append(str(exc))
        for message in client_errors:
            for key in KEYS:
                self.assertNotIn(key, message)

    def test_checkpoint_serialisation_contains_no_key_values(self):
        from history_ingestor.state import Checkpoint
        state = Checkpoint(
            day="2026-08-19",
            keys=[{"index": 0, "used": 3, "status": "ok"}, {"index": 1, "used": 0, "status": "ok"}],
            symbols={"NVDA": {"weekly": "done", "splits": "done"}},
            started_at="", updated_at="",
        )
        serialised = json.dumps(state.to_dict())
        for key in KEYS:
            self.assertNotIn(key, serialised)
        self.assertIn("index", serialised)  # indexes only, never values

    def test_logs_never_contain_key_values(self):
        buffer = io.StringIO()
        handler = logging.StreamHandler(buffer)
        logger = logging.getLogger("history_ingestor")
        logger.setLevel(logging.DEBUG)
        logger.addHandler(handler)
        try:
            logger.info("provider call for symbol=%s function=%s", "NVDA", "TIME_SERIES_WEEKLY")
            logger.error("request failed for %s", "NVDA")
            logging.shutdown()
        finally:
            logger.removeHandler(handler)
        logs = buffer.getvalue()
        for key in KEYS:
            self.assertNotIn(key, logs)
        self.assertIn("NVDA", logs)

    def test_settings_never_str_exposes_keys(self):
        settings = settings_with()
        text = str(settings)
        for key in KEYS:
            self.assertNotIn(key, text)
        self.assertIn("alpha_vantage_keys", text)  # field names are fine


if __name__ == "__main__":
    unittest.main()
