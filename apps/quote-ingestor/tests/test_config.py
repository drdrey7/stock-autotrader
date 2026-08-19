"""Config wiring: no dead knobs, the D1 batch size is internal to the client."""

from __future__ import annotations

import unittest

from quote_ingestor.config import Settings
from quote_ingestor.d1 import D1Client


def _settings() -> Settings:
    return Settings(
        finnhub_api_key="k",
        cloudflare_api_token="t",
        cloudflare_account_id="c",
        cloudflare_d1_database_id="d",
    )


class DeadConfigTest(unittest.TestCase):
    def test_no_dead_d1_settings_fields(self) -> None:
        # P2 #3: d1_region / d1_batch_max_rows were never wired to runtime —
        # removed so operators can't be misled by knobs that do nothing.
        settings = _settings()
        self.assertFalse(hasattr(settings, "d1_region"))
        self.assertFalse(hasattr(settings, "d1_batch_max_rows"))

    def test_d1_batch_size_is_an_internal_client_constant(self) -> None:
        # The proven 20-row chunk lives inside D1Client (unit-testable), not in
        # process-level Settings.
        client = D1Client("t", "c", "d")
        self.assertEqual(client._batch_max_rows, 20)  # noqa: SLF001


if __name__ == "__main__":
    unittest.main()
