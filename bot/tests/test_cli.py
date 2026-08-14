import contextlib
import io
import os
import tempfile
import unittest
from pathlib import Path

from bot import cli


class SmokeTests(unittest.TestCase):
    def test_smoke_command_ok(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self._env({"BOT_ENV": "dev", "DATA_DIR": str(Path(tmp) / "data")}):
                with contextlib.redirect_stdout(io.StringIO()):
                    code = cli.main(["smoke"])
        self.assertEqual(code, 0)

    def test_market_data_publish_without_secret_fails_cleanly(self):
        from types import SimpleNamespace
        from unittest.mock import patch

        from bot.config import Settings

        output = io.StringIO()
        with patch("bot.cli.get_settings", return_value=Settings(bot_env="production", ingest_secret="")):
            with contextlib.redirect_stdout(output):
                code = cli._cmd_market_data(SimpleNamespace(publish=True, no_cache=True))
        self.assertEqual(code, 2)
        self.assertIn("INGEST_SECRET not configured", output.getvalue())

    def test_smoke_does_not_create_or_mutate_data_dir(self):
        with tempfile.TemporaryDirectory() as tmp:
            data_dir = Path(tmp) / "data"
            with self._env({"BOT_ENV": "dev", "DATA_DIR": str(data_dir)}):
                with contextlib.redirect_stdout(io.StringIO()):
                    self.assertEqual(cli.main(["smoke"]), 0)
            self.assertFalse(data_dir.exists())

    @contextlib.contextmanager
    def _env(self, overrides):
        old = {key: os.environ.get(key) for key in overrides}
        for key, value in overrides.items():
            os.environ[key] = value
        try:
            yield
        finally:
            for key, value in old.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value


class ConfigTests(unittest.TestCase):
    def test_market_paths_follow_data_dir(self):
        from bot.config import Settings

        with tempfile.TemporaryDirectory() as tmp:
            data_dir = Path(tmp) / "runtime-data"
            settings = Settings(data_dir=data_dir)
        self.assertEqual(settings.market_data_dir, data_dir / "market")
        self.assertEqual(settings.market_data_cache, data_dir / "market" / "latest.json")

    def test_placeholder_secret_rejected(self):
        from bot.config import Settings

        with self.assertRaises(ValueError):
            Settings(bot_env="dev", ingest_secret="change-me")

    def test_check_secrets_production(self):
        from bot.config import Settings

        s = Settings(bot_env="production", ingest_secret="")
        self.assertIn("INGEST_SECRET", s.check_secrets())
        s2 = Settings(bot_env="production", ingest_secret="real-value")
        self.assertEqual(s2.check_secrets(), [])


if __name__ == "__main__":
    unittest.main()
