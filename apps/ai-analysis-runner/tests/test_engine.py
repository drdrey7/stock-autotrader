from __future__ import annotations

import tempfile
import unittest
import uuid
from pathlib import Path
from typing import Any

from ai_analysis_runner.engine import EngineFailure, TradingAgentsEngine, _UsageCallback, _context_graph_factory

from tests.helpers import final_state, settings


class RecordingGraph:
    calls: list[dict[str, Any]] = []
    failures_by_provider: dict[str, int] = {}

    def __init__(self, **kwargs: Any) -> None:
        self.kwargs = kwargs
        self.calls.append(kwargs)

    def propagate(self, symbol: str, analysis_date: str, asset_type: str) -> tuple[dict[str, Any], str]:
        provider = self.kwargs["config"]["llm_provider"]
        remaining = self.failures_by_provider.get(provider, 0)
        if remaining:
            self.failures_by_provider[provider] = remaining - 1
            raise RuntimeError("provider emitted a secret that must not escape")
        return final_state(), "Buy"


class GoUsageLimitError(RuntimeError):
    status_code = 429
    body = {"error": {"type": "GoUsageLimitError"}}


class UsageLimitedGraph(RecordingGraph):
    def propagate(self, symbol: str, analysis_date: str, asset_type: str) -> tuple[dict[str, Any], str]:
        raise GoUsageLimitError("upstream text must stay private")


class EngineTests(unittest.TestCase):
    def setUp(self) -> None:
        RecordingGraph.calls = []
        RecordingGraph.failures_by_provider = {}

    def test_programmatic_graph_uses_all_analysts_and_isolated_checkpoint_paths(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            value = settings(Path(directory))
            analysis_id = str(uuid.uuid4())
            result = TradingAgentsEngine(value, RecordingGraph).run(analysis_id, "AAPL", "2026-08-21")
            call = RecordingGraph.calls[0]
            self.assertEqual(call["selected_analysts"], ("market", "social", "news", "fundamentals"))
            self.assertFalse(call["debug"])
            config = call["config"]
            self.assertTrue(config["checkpoint_enabled"])
            self.assertIn(f"jobs/{analysis_id}/google/cache", config["data_cache_dir"])
            self.assertIn(f"jobs/{analysis_id}/google/results", config["results_dir"])
            self.assertIn(f"jobs/{analysis_id}/google/memory/trading_memory.md", config["memory_log_path"])
            self.assertEqual(result.provider, "google")

    def test_earnings_adapter_preserves_existing_identity_context(self) -> None:
        class Graph:
            def __init__(self, **_kwargs: Any) -> None:
                pass

            def resolve_instrument_context(self, ticker: str, asset_type: str = "stock") -> str:
                return f"identity:{ticker}:{asset_type}"

        adapted = _context_graph_factory(Graph, "AUTHORITATIVE LATEST EARNINGS\nReported: 2026-08-26")
        context = adapted().resolve_instrument_context("NVDA")
        self.assertIn("identity:NVDA:stock", context)
        self.assertIn("AUTHORITATIVE LATEST EARNINGS", context)

    def test_every_state_directory_level_is_private(self) -> None:
        import stat

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            value = settings(root)
            analysis_id = str(uuid.uuid4())
            TradingAgentsEngine(value, RecordingGraph).run(analysis_id, "AAPL", "2026-08-21")
            job_root = root / "jobs" / analysis_id / "google"
            private_levels = (
                root / "jobs",
                root / "jobs" / analysis_id,
                job_root,
                job_root / "cache",
                job_root / "results",
                job_root / "memory",
            )
            for level in private_levels:
                self.assertTrue(level.is_dir(), level)
                self.assertEqual(stat.S_IMODE(level.stat().st_mode), 0o700, level)

    def test_openai_compatible_base_url_is_forwarded_to_graph(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            value = settings(
                Path(directory),
                primary_provider="openai_compatible",
                llm_backend_url="https://opencode.ai/zen/go/v1",
                quick_model="deepseek-v4-flash",
                deep_model="deepseek-v4-flash",
            )
            TradingAgentsEngine(value, RecordingGraph).run(str(uuid.uuid4()), "AAPL", "2026-08-21")
            config = RecordingGraph.calls[0]["config"]
            self.assertEqual(config["llm_provider"], "openai_compatible")
            self.assertEqual(config["backend_url"], "https://opencode.ai/zen/go/v1")

    def test_openrouter_uses_paid_models_and_usage_callback(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            value = settings(
                Path(directory),
                primary_provider="openrouter",
                llm_backend_url=None,
                quick_model="openai/gpt-5.4-mini",
                deep_model="openai/gpt-5.5",
            )
            result = TradingAgentsEngine(value, RecordingGraph).run(str(uuid.uuid4()), "MSFT", "2026-08-24")
            config = RecordingGraph.calls[0]["config"]
            self.assertEqual(config["llm_provider"], "openrouter")
            self.assertEqual(config["quick_think_llm"], "openai/gpt-5.4-mini")
            self.assertEqual(config["deep_think_llm"], "openai/gpt-5.5")
            self.assertIsNone(config["backend_url"])
            self.assertEqual(result.provider, "openrouter")
            self.assertEqual(len(RecordingGraph.calls[0]["callbacks"]), 1)

    def test_usage_callback_handles_pinned_dispatcher_and_nested_openrouter_usage(self) -> None:
        try:
            from langchain_core.callbacks import CallbackManager
            from langchain_core.messages import AIMessage
            from langchain_core.outputs import ChatGeneration, LLMResult
        except ImportError as error:
            self.skipTest(f"langchain-core not installed: {error}")

        progress: list[tuple[str, int, int]] = []
        callback = _UsageCallback()
        callback.set_progress_callback(lambda stage, step, total: progress.append((stage, step, total)))
        manager = CallbackManager([callback])
        manager.on_chain_start({"name": "Bull Researcher"}, {})
        manager.on_llm_end(LLMResult(generations=[[ChatGeneration(message=AIMessage(
            content="valid result",
            response_metadata={"usage": {
                "prompt_tokens": 100,
                "completion_tokens": 40,
                "prompt_tokens_details": {"cached_tokens": 25},
                "completion_tokens_details": {"reasoning_tokens": 10},
            }},
        ))]]))
        self.assertEqual(progress, [("bull", 5, 12)])
        self.assertEqual(callback.calls, 1)
        self.assertEqual(callback.input_tokens, 100)
        self.assertEqual(callback.output_tokens, 40)
        self.assertEqual(callback.cached_tokens, 25)
        self.assertEqual(callback.reasoning_tokens, 10)

    def test_progress_telemetry_exception_cannot_break_callback(self) -> None:
        callback = _UsageCallback()
        callback.set_progress_callback(lambda *_args: (_ for _ in ()).throw(RuntimeError("telemetry")))
        callback.on_chain_start({"name": "Market Analyst"}, {})
        self.assertEqual(callback._last_progress_step, 1)

    def test_engine_timeout_is_non_retryable(self) -> None:
        failure = EngineFailure("engine_timeout", "Analysis exceeded its execution time limit.", retryable=False)
        self.assertFalse(failure.retryable)

    def test_opencode_go_usage_limit_is_definitive_and_safe(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            value = settings(
                Path(directory),
                primary_provider="openai_compatible",
                llm_backend_url="https://opencode.ai/zen/go/v1",
                quick_model="deepseek-v4-flash",
                deep_model="deepseek-v4-flash",
            )
            with self.assertRaises(EngineFailure) as raised:
                TradingAgentsEngine(value, UsageLimitedGraph).run(str(uuid.uuid4()), "AAPL", "2026-08-21")
            self.assertEqual(raised.exception.code, "provider_usage_limit")
            self.assertFalse(raised.exception.retryable)
            self.assertNotIn("upstream", raised.exception.safe_message)

    def test_one_bounded_openai_fallback_has_separate_cache(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            value = settings(Path(directory), openai_fallback_enabled=True, openai_api_key="secret")
            RecordingGraph.failures_by_provider = {"google": 1}
            result = TradingAgentsEngine(value, RecordingGraph).run(str(uuid.uuid4()), "AAPL", "2026-08-21")
            self.assertEqual([call["config"]["llm_provider"] for call in RecordingGraph.calls], ["google", "openai"])
            self.assertEqual(result.provider, "openai")
            self.assertNotEqual(
                RecordingGraph.calls[0]["config"]["data_cache_dir"],
                RecordingGraph.calls[1]["config"]["data_cache_dir"],
            )

    def test_fallback_is_attempted_only_once_and_error_is_safe(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            value = settings(Path(directory), openai_fallback_enabled=True, openai_api_key="secret")
            RecordingGraph.failures_by_provider = {"google": 2, "openai": 2}
            with self.assertRaises(EngineFailure) as raised:
                TradingAgentsEngine(value, RecordingGraph).run(str(uuid.uuid4()), "AAPL", "2026-08-21")
            self.assertEqual(len(RecordingGraph.calls), 2)
            self.assertNotIn("secret", raised.exception.safe_message)


if __name__ == "__main__":
    unittest.main()
