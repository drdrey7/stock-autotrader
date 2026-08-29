"""Lazy programmatic adapter for the immutable TradingAgents release."""

from __future__ import annotations

import copy
import signal
import threading
import time
import uuid
from collections.abc import Callable
from typing import Any

from .config import Settings
from .models import EngineOutput
from .private import ensure_private_directory
from .structured_logging import log_event


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
    if isinstance(exc, TimeoutError):
        return EngineFailure("engine_timeout", "Analysis exceeded its execution time limit.", retryable=False)
    return EngineFailure("engine_execution_failed", "Analysis engine execution failed.", retryable=True)


class _UsageCallback:
    """Collect numeric usage metadata without retaining prompts or responses."""

    def __init__(self) -> None:
        self.calls = 0
        self.input_tokens = 0
        self.output_tokens = 0
        self.cached_tokens = 0
        self.reasoning_tokens = 0
        self.cost_usd = 0.0

    @staticmethod
    def _number(value: Any) -> int:
        return value if isinstance(value, int) and value >= 0 else 0

    def on_llm_end(self, response: Any, **_kwargs: Any) -> None:
        self.calls += 1
        usage: dict[str, Any] = {}
        cost: int | float | None = None
        llm_output = getattr(response, "llm_output", None)
        if isinstance(llm_output, dict) and isinstance(llm_output.get("token_usage"), dict):
            usage.update(llm_output["token_usage"])
        if isinstance(llm_output, dict) and isinstance(llm_output.get("cost"), (int, float)):
            cost = llm_output["cost"]
        for generation_list in getattr(response, "generations", []) or []:
            for generation in generation_list or []:
                metadata = getattr(getattr(generation, "message", None), "response_metadata", None)
                if isinstance(metadata, dict):
                    candidate = metadata.get("token_usage") or metadata.get("usage")
                    if isinstance(candidate, dict):
                        usage.update(candidate)
                    metadata_cost = metadata.get("cost") or metadata.get("cost_usd")
                    if cost is None and isinstance(metadata_cost, (int, float)):
                        cost = metadata_cost
        self.input_tokens += self._number(usage.get("prompt_tokens", usage.get("input_tokens")))
        self.output_tokens += self._number(usage.get("completion_tokens", usage.get("output_tokens")))
        self.cached_tokens += self._number(usage.get("cached_tokens", usage.get("cache_read_input_tokens")))
        self.reasoning_tokens += self._number(usage.get("reasoning_tokens"))
        if cost is None:
            usage_cost = usage.get("cost") or usage.get("cost_usd")
            if isinstance(usage_cost, (int, float)):
                cost = usage_cost
        if isinstance(cost, (int, float)) and cost >= 0:
            self.cost_usd += float(cost)


class _EngineDeadline:
    def __init__(self, seconds: int) -> None:
        self.seconds = seconds
        self.previous_handler: Any = None

    def __enter__(self) -> None:
        if threading.current_thread() is threading.main_thread():
            self.previous_handler = signal.signal(signal.SIGALRM, self._raise)
            signal.setitimer(signal.ITIMER_REAL, self.seconds)

    def __exit__(self, *_args: object) -> None:
        if self.previous_handler is not None:
            signal.setitimer(signal.ITIMER_REAL, 0)
            signal.signal(signal.SIGALRM, self.previous_handler)

    @staticmethod
    def _raise(_signum: int, _frame: Any) -> None:
        raise TimeoutError("analysis execution deadline exceeded")


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
        usage = _UsageCallback()
        started = time.monotonic()
        try:
            with _EngineDeadline(self._settings.engine_timeout_seconds):
                graph = graph_factory(
                    selected_analysts=("market", "social", "news", "fundamentals"),
                    debug=False,
                    config=config,
                    callbacks=[usage],
                )
                final_state, decision = graph.propagate(symbol, analysis_date, asset_type="stock")
        except EngineFailure:
            raise
        except Exception as exc:
            raise _execution_failure(exc) from exc
        finally:
            log_event(
                "analysis_engine_metrics",
                analysis_id=analysis_id,
                provider=provider,
                quick_model=quick_model,
                deep_model=deep_model,
                duration_ms=round((time.monotonic() - started) * 1000),
                llm_calls=usage.calls,
                input_tokens=usage.input_tokens,
                output_tokens=usage.output_tokens,
                cached_tokens=usage.cached_tokens,
                reasoning_tokens=usage.reasoning_tokens,
                cost_usd=round(usage.cost_usd, 8),
            )
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
