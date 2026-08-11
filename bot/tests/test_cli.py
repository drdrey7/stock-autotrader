import json
import tempfile
import unittest
from pathlib import Path

from bot import cli


class SmokeTests(unittest.TestCase):
    def test_smoke_command_ok(self):
        import contextlib
        import io

        with tempfile.TemporaryDirectory() as tmp:
            with self._env({"BOT_ENV": "dev", "DATA_DIR": str(Path(tmp) / "data")}):
                with contextlib.redirect_stdout(io.StringIO()):
                    code = cli.main(["smoke"])
        self.assertEqual(code, 0)

    def _env(self, overrides):
        import contextlib
        import os

        @contextlib.contextmanager
        def _set():
            old = {}
            for k, v in overrides.items():
                old[k] = os.environ.get(k)
                os.environ[k] = v
            try:
                yield
            finally:
                for k, v in overrides.items():
                    if old[k] is None:
                        os.environ.pop(k, None)
                    else:
                        os.environ[k] = old[k]

        return _set()


class ConfigTests(unittest.TestCase):
    def test_placeholder_secret_rejected(self):
        import os

        from bot.config import Settings

        old = os.environ.get("INGEST_SECRET")
        os.environ["INGEST_SECRET"] = "change-me"
        try:
            with self.assertRaises(ValueError):
                Settings(bot_env="dev", ingest_secret="change-me")
        finally:
            if old is None:
                os.environ.pop("INGEST_SECRET", None)
            else:
                os.environ["INGEST_SECRET"] = old

    def test_check_secrets_production(self):
        from bot.config import Settings

        s = Settings(bot_env="production", ingest_secret="")
        self.assertIn("INGEST_SECRET", s.check_secrets())
        s2 = Settings(bot_env="production", ingest_secret="real-value")
        self.assertEqual(s2.check_secrets(), [])


if __name__ == "__main__":
    unittest.main()
