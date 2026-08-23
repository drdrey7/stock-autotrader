from __future__ import annotations

import tempfile
import unittest
import uuid
from pathlib import Path
from typing import Any

from ai_analysis_runner.engine import EngineFailure, TradingAgentsEngine

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
