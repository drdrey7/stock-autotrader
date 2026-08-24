from __future__ import annotations

import tempfile
import unittest

from ai_analysis_runner.config import ConfigError, from_env


def base_env() -> dict[str, str]:
    return {
        "CLOUDFLARE_API_TOKEN": "d1-super-secret",
        "CLOUDFLARE_QUEUES_API_TOKEN": "queue-super-secret",
        "CLOUDFLARE_ACCOUNT_ID": "account-id",
        "CLOUDFLARE_D1_DATABASE_ID": "database-id",
        "CLOUDFLARE_AI_QUEUE_ID": "queue-id",
        "GOOGLE_API_KEY": "google-super-secret",
        "AI_ANALYSIS_STATE_DIR": tempfile.gettempdir(),
    }


class ConfigTests(unittest.TestCase):
    def test_google_defaults_are_current_configured_models(self) -> None:
        value = from_env(base_env())
        self.assertEqual(value.primary_provider, "google")
        self.assertEqual(value.quick_model, "gemini-3.1-flash-lite")
        self.assertEqual(value.deep_model, "gemini-3.5-flash")
        self.assertFalse(value.openai_fallback_enabled)

    def test_openai_primary_requires_only_openai_key_and_gets_openai_defaults(self) -> None:
        environ = base_env()
        environ.pop("GOOGLE_API_KEY")
        environ.update({"TRADINGAGENTS_LLM_PROVIDER": "openai", "OPENAI_API_KEY": "openai-secret"})
        value = from_env(environ)
        self.assertEqual(value.primary_provider, "openai")
        self.assertEqual(value.quick_model, "gpt-5.4-mini")
        self.assertEqual(value.deep_model, "gpt-5.5")

    def test_selected_provider_key_is_required(self) -> None:
        environ = base_env()
        environ.pop("GOOGLE_API_KEY")
        with self.assertRaisesRegex(ConfigError, "GOOGLE_API_KEY"):
            from_env(environ)
        environ["TRADINGAGENTS_LLM_PROVIDER"] = "openai"
        with self.assertRaisesRegex(ConfigError, "OPENAI_API_KEY"):
            from_env(environ)

    def test_fallback_is_opt_in_bounded_and_requires_key(self) -> None:
        environ = base_env() | {"AI_ANALYSIS_OPENAI_FALLBACK_ENABLED": "true"}
        with self.assertRaisesRegex(ConfigError, "OPENAI_API_KEY"):
            from_env(environ)
        environ["OPENAI_API_KEY"] = "openai-secret"
        self.assertTrue(from_env(environ).openai_fallback_enabled)
        environ["TRADINGAGENTS_LLM_PROVIDER"] = "openai"
        with self.assertRaisesRegex(ConfigError, "only valid"):
            from_env(environ)

    def test_repr_redacts_every_secret(self) -> None:
        environ = base_env() | {"OPENAI_API_KEY": "openai-super-secret"}
        rendered = repr(from_env(environ))
        for secret in ("d1-super-secret", "queue-super-secret", "google-super-secret", "openai-super-secret"):
            self.assertNotIn(secret, rendered)

    def test_rejects_relative_state_and_unsafe_ranges(self) -> None:
        with self.assertRaisesRegex(ConfigError, "absolute"):
            from_env(base_env() | {"AI_ANALYSIS_STATE_DIR": "relative"})
        with self.assertRaisesRegex(ConfigError, "two heartbeat"):
            from_env(base_env() | {
                "AI_ANALYSIS_HEARTBEAT_INTERVAL_SECONDS": "60",
                "AI_ANALYSIS_STALE_LEASE_SECONDS": "120",
            })

    def test_empty_model_variables_fall_back_to_defaults(self) -> None:
        environ = base_env()
        environ["TRADINGAGENTS_QUICK_THINK_LLM"] = ""
        environ["AI_ANALYSIS_OPENAI_QUICK_MODEL"] = ""
        value = from_env(environ)
        self.assertEqual(value.quick_model, "gemini-3.1-flash-lite")
        self.assertEqual(value.openai_quick_model, "gpt-5.4-mini")


if __name__ == "__main__":
    unittest.main()

