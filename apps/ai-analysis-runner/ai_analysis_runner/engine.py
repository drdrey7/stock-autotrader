"""Lazy programmatic adapter for the immutable TradingAgents release."""

from __future__ import annotations

import copy
import uuid
from collections.abc import Callable
from typing import Any

from .config import Settings
from .models import EngineOutput
from .private import ensure_private_directory


class EngineFailure(RuntimeError):
    def __init__(self, code: str, safe_message: str, *, retryable: bool) -> None:
        super().__init__(code)
        self.code = code
        self.safe_message = safe_message
        self.retryable = retryable


def _execution_failure(exc: Exception) -> EngineFailure:
    """Classify provider exhaustion without exposing upstream response text."""

    status_code = getattr(exc, "status_code", None)
    body = getattr(exc, "body", None)
    if isinstance(body, dict):
        error = body.get("error") if isinstance(body.get("error"), dict) else body
        provider_type = error.get("type")
        if status_code == 429 and provider_type == "GoUsageLimitError":
            return EngineFailure(
                "provider_usage_limit",
                "Analysis provider usage limit has been reached.",
                retryable=False,
            )
    return EngineFailure("engine_execution_failed", "Analysis engine execution failed.", retryable=True)


class TradingAgentsEngine:
    """Runs a single graph at a time with per-analysis state isolation."""

    def __init__(self, settings: Settings, graph_factory: Callable[..., Any] | None = None) -> None:
        self._settings = settings
        self._graph_factory = graph_factory

    @staticmethod
    def _analysis_id(value: str) -> str:
        try:
            canonical = str(uuid.UUID(value))
        except ValueError as exc:
            raise EngineFailure("analysis_id_invalid", "Analysis identifier is invalid.", retryable=False) from exc
        if canonical != value.lower():
            raise EngineFailure("analysis_id_invalid", "Analysis identifier is invalid.", retryable=False)
        return canonical

    def _load(self) -> tuple[Callable[..., Any], dict[str, Any]]:
        if self._graph_factory is not None:
            return self._graph_factory, {}
        try:
            from tradingagents.default_config import DEFAULT_CONFIG
            from tradingagents.graph.trading_graph import TradingAgentsGraph
        except (ImportError, ModuleNotFoundError) as exc:
            raise EngineFailure("engine_unavailable", "Analysis engine is unavailable.", retryable=False) from exc
        return TradingAgentsGraph, copy.deepcopy(DEFAULT_CONFIG)

    def _run_provider(
        self,
        analysis_id: str,
        symbol: str,
        analysis_date: str,
        provider: str,
        quick_model: str,
        deep_model: str,
    ) -> EngineOutput:
        graph_factory, config = self._load()
        job_root = self._settings.state_dir / "jobs" / self._analysis_id(analysis_id) / provider
        cache_dir = job_root / "cache"
        results_dir = job_root / "results"
        memory_path = job_root / "memory" / "trading_memory.md"
        for directory in (cache_dir, results_dir, memory_path.parent):
            ensure_private_directory(directory)
        config.update({
            "data_cache_dir": str(cache_dir),
            "results_dir": str(results_dir),
            "memory_log_path": str(memory_path),
            "llm_provider": provider,
            "quick_think_llm": quick_model,
            "deep_think_llm": deep_model,
            "backend_url": self._settings.llm_backend_url if provider == self._settings.primary_provider else None,
            "checkpoint_enabled": True,
            "output_language": "English",
            "max_debate_rounds": 1,
            "max_risk_discuss_rounds": 1,
            "llm_max_retries": self._settings.llm_max_retries,
        })
        try:
            graph = graph_factory(
                selected_analysts=("market", "social", "news", "fundamentals"),
                debug=False,
                config=config,
                callbacks=None,
            )
            final_state, decision = graph.propagate(symbol, analysis_date, asset_type="stock")
        except EngineFailure:
            raise
        except Exception as exc:
            raise _execution_failure(exc) from exc
        if not isinstance(final_state, dict) or not isinstance(decision, str):
            raise EngineFailure("engine_output_invalid", "Analysis engine returned an invalid result.", retryable=True)
        return EngineOutput(final_state, decision, provider, quick_model, deep_model)

    def run(self, analysis_id: str, symbol: str, analysis_date: str) -> EngineOutput:
        try:
            return self._run_provider(
                analysis_id,
                symbol,
                analysis_date,
                self._settings.primary_provider,
                self._settings.quick_model,
                self._settings.deep_model,
            )
        except EngineFailure as primary_error:
            if not (
                primary_error.retryable
                and self._settings.primary_provider == "google"
                and self._settings.openai_fallback_enabled
            ):
                raise
            try:
                return self._run_provider(
                    analysis_id,
                    symbol,
                    analysis_date,
                    "openai",
                    self._settings.openai_quick_model,
                    self._settings.openai_deep_model,
                )
            except EngineFailure as fallback_error:
                raise EngineFailure(
                    "engine_primary_and_fallback_failed",
                    "Primary and fallback analysis providers failed.",
                    retryable=fallback_error.retryable,
                ) from fallback_error
