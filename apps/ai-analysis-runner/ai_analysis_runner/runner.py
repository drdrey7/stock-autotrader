"""Idempotent continuous Queue-to-D1 execution loop."""

from __future__ import annotations

import logging
import random
import threading
import time
import uuid
from collections.abc import Callable
from datetime import timedelta
from typing import Any

from .checkpoint import CheckpointError, ResultCheckpointStore
from .config import Settings
from .d1 import D1Client, D1ProtocolError
from .engine import EngineFailure, TradingAgentsEngine
from .http import HttpError
from .models import Analysis, QueueMessage
from .normalize import ResultValidationError, normalize_result, serialize_result, validate_result
from .queue_client import LeasedQueueProtocolError, QueueClient, QueueProtocolError
from .structured_logging import log_event
from .time_utils import iso_utc, utc_now

_TERMINAL = frozenset({"completed", "failed"})


class LeaseHeartbeat:
    def __init__(
        self,
        d1: D1Client,
        analysis: Analysis,
        message: QueueMessage,
        execution_token: str,
        interval_seconds: int,
        now: Callable[[], Any],
    ) -> None:
        self._d1 = d1
        self._analysis = analysis
        self._message = message
        self._token = execution_token
        self._interval = interval_seconds
        self._now = now
        self._stop = threading.Event()
        self.lost = threading.Event()
        self._thread = threading.Thread(target=self._run, name=f"heartbeat-{analysis.id}", daemon=True)

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._thread.join(timeout=min(10, self._interval))

    def _run(self) -> None:
        while not self._stop.wait(self._interval):
            try:
                held = self._d1.heartbeat(
                    self._analysis.id,
                    self._message.id,
                    self._token,
                    iso_utc(self._now()),
                )
                if not held:
                    self.lost.set()
                    log_event("analysis_lease_lost", analysis_id=self._analysis.id, message_id=self._message.id)
                    return
            except (HttpError, D1ProtocolError):
                log_event(
                    "analysis_heartbeat_failed",
                    level=logging.WARNING,
                    analysis_id=self._analysis.id,
                    message_id=self._message.id,
                    code="d1_unavailable",
                )


class AnalysisRunner:
    def __init__(
        self,
        settings: Settings,
        queue: QueueClient,
        d1: D1Client,
        engine: TradingAgentsEngine,
        checkpoints: ResultCheckpointStore,
        *,
        stop_event: threading.Event | None = None,
        now: Callable[[], Any] = utc_now,
        rand: Callable[[], float] = random.random,
    ) -> None:
        self.settings = settings
        self.queue = queue
        self.d1 = d1
        self.engine = engine
        self.checkpoints = checkpoints
        self.stop_event = stop_event or threading.Event()
        self._now = now
        self._rand = rand

    def _queue_retry(self, message: QueueMessage) -> None:
        try:
            self.queue.retry(message, self.settings.retry_delay_seconds)
        except (HttpError, QueueProtocolError):
            log_event(
                "queue_retry_failed",
                level=logging.WARNING,
                analysis_id=message.analysis_id,
                message_id=message.id,
                code="queue_unavailable",
            )

    def _ack_if_terminal(self, message: QueueMessage) -> bool:
        try:
            analysis = self.d1.get_analysis(message.analysis_id)
        except (HttpError, D1ProtocolError):
            return False
        if analysis is None or analysis.status not in _TERMINAL:
            return False
        try:
            self.queue.ack(message)
        except (HttpError, QueueProtocolError):
            log_event(
                "queue_ack_failed",
                level=logging.WARNING,
                analysis_id=message.analysis_id,
                message_id=message.id,
                status=analysis.status,
                code="queue_unavailable",
            )
            return False
        try:
            self.checkpoints.delete(message.analysis_id)
        except OSError:
            log_event("checkpoint_delete_failed", level=logging.WARNING, analysis_id=message.analysis_id, code="filesystem_error")
        log_event(
            "analysis_message_acked",
            analysis_id=message.analysis_id,
            message_id=message.id,
            status=analysis.status,
        )
        return True

    def process_message(self, message: QueueMessage) -> None:
        try:
            current = self.d1.get_analysis(message.analysis_id)
        except (HttpError, D1ProtocolError):
            log_event("analysis_lookup_failed", level=logging.WARNING, analysis_id=message.analysis_id, code="d1_unavailable")
            self._queue_retry(message)
            return
        if current is None:
            log_event("analysis_missing", level=logging.WARNING, analysis_id=message.analysis_id, code="analysis_missing")
            self._queue_retry(message)
            return
        if current.status in _TERMINAL:
            if not self._ack_if_terminal(message):
                self._queue_retry(message)
            return

        now = self._now()
        execution_token = str(uuid.uuid4())
        try:
            claimed = self.d1.claim(
                message.analysis_id,
                message.id,
                execution_token,
                iso_utc(now),
                iso_utc(now - timedelta(seconds=self.settings.stale_lease_seconds)),
            )
        except (HttpError, D1ProtocolError):
            log_event("analysis_claim_failed", level=logging.WARNING, analysis_id=message.analysis_id, code="d1_unavailable")
            self._queue_retry(message)
            return
        if claimed is None:
            if not self._ack_if_terminal(message):
                self._queue_retry(message)
            return

        log_event(
            "analysis_claimed",
            analysis_id=claimed.id,
            message_id=message.id,
            symbol=claimed.symbol,
            attempt=claimed.attempt_count,
        )
        heartbeat = LeaseHeartbeat(
            self.d1,
            claimed,
            message,
            execution_token,
            self.settings.heartbeat_interval_seconds,
            self._now,
        )
        heartbeat.start()
        failure: tuple[str, str, bool] | None = None
        result: dict[str, Any] | None = None
        try:
            try:
                result = self.checkpoints.load(claimed.id, claimed.symbol, claimed.analysis_date)
            except CheckpointError:
                log_event("checkpoint_invalid", level=logging.WARNING, analysis_id=claimed.id, code="checkpoint_invalid")
                try:
                    self.checkpoints.delete(claimed.id)
                except OSError:
                    pass
            if result is None:
                engine_started = time.monotonic()
                log_event(
                    "analysis_engine_started",
                    analysis_id=claimed.id,
                    provider=self.settings.primary_provider,
                    quick_model=self.settings.quick_model,
                    deep_model=self.settings.deep_model,
                )
                try:
                    output = self.engine.run(claimed.id, claimed.symbol, claimed.analysis_date)
                finally:
                    log_event(
                        "analysis_engine_finished",
                        analysis_id=claimed.id,
                        duration_ms=round((time.monotonic() - engine_started) * 1000),
                    )
                result = normalize_result(claimed.symbol, claimed.analysis_date, iso_utc(self._now()), output)
                validate_result(result, max_bytes=self.settings.result_max_bytes)
                self.checkpoints.save(claimed.id, result)
            else:
                log_event("checkpoint_recovered", analysis_id=claimed.id)
        except EngineFailure as exc:
            failure = (exc.code, exc.safe_message, exc.retryable)
        except ResultValidationError:
            failure = ("result_invalid", "Analysis engine returned an invalid result.", True)
        except (CheckpointError, OSError):
            failure = ("checkpoint_failed", "Analysis result could not be checkpointed.", True)
        except Exception as exc:
            log_event(
                "analysis_execution_unexpected",
                level=logging.ERROR,
                analysis_id=claimed.id,
                message_id=message.id,
                error_type=type(exc).__name__,
            )
            failure = ("runner_error", "Analysis execution failed.", True)
        finally:
            heartbeat.stop()

        if heartbeat.lost.is_set():
            log_event("analysis_abandoned_after_lease_loss", level=logging.WARNING, analysis_id=claimed.id)
            self._queue_retry(message)
            return
        if failure is not None:
            self._handle_failure(claimed, message, execution_token, *failure)
            return
        assert result is not None
        completed = self._now()
        result_json = serialize_result(result)
        try:
            updated = self.d1.complete(
                claimed.id,
                message.id,
                execution_token,
                result_json,
                iso_utc(completed),
                iso_utc(completed + timedelta(days=self.settings.valid_days)),
            )
        except (HttpError, D1ProtocolError):
            log_event("analysis_complete_unknown", level=logging.WARNING, analysis_id=claimed.id, code="d1_unavailable")
            if not self._ack_if_terminal(message):
                self._queue_retry(message)
            return
        if not updated:
            if not self._ack_if_terminal(message):
                self._queue_retry(message)
            return
        log_event("analysis_completed", analysis_id=claimed.id, symbol=claimed.symbol, provider=result["engine"]["provider"])
        if not self._ack_if_terminal(message):
            self._queue_retry(message)

    def _handle_failure(
        self,
        claimed: Analysis,
        message: QueueMessage,
        execution_token: str,
        code: str,
        safe_message: str,
        retryable: bool,
    ) -> None:
        now = iso_utc(self._now())
        definitive = not retryable or claimed.attempt_count >= self.settings.max_analysis_attempts
        try:
            if definitive:
                transitioned = self.d1.fail(
                    claimed.id,
                    message.id,
                    execution_token,
                    now,
                    code[:64],
                    safe_message[:300],
                )
                if transitioned:
                    try:
                        self.checkpoints.delete(claimed.id)
                    except OSError:
                        pass
                    log_event("analysis_failed", analysis_id=claimed.id, attempt=claimed.attempt_count, code=code)
                if not self._ack_if_terminal(message):
                    self._queue_retry(message)
                return
            transitioned = self.d1.requeue(
                claimed.id,
                message.id,
                execution_token,
                now,
                code[:64],
                safe_message[:300],
            )
            if transitioned:
                log_event("analysis_requeued", analysis_id=claimed.id, attempt=claimed.attempt_count, code=code)
                self._queue_retry(message)
            else:
                self._ack_if_terminal(message)
        except (HttpError, D1ProtocolError):
            log_event("analysis_failure_transition_unknown", level=logging.WARNING, analysis_id=claimed.id, code="d1_unavailable")
            if not self._ack_if_terminal(message):
                self._queue_retry(message)

    def run_forever(self) -> None:
        empty_delay = self.settings.empty_poll_min_seconds
        log_event("runner_started")
        while not self.stop_event.is_set():
            try:
                message = self.queue.pull()
            except LeasedQueueProtocolError as exc:
                log_event("queue_protocol_rejected", level=logging.WARNING, code=str(exc))
                try:
                    self.queue.ack_lease(exc.lease_id)
                    log_event("queue_poison_acked", code=str(exc))
                except (HttpError, QueueProtocolError):
                    log_event("queue_poison_ack_failed", level=logging.WARNING, code="queue_unavailable")
                    try:
                        self.queue.retry_lease(exc.lease_id, self.settings.retry_delay_seconds)
                    except (HttpError, QueueProtocolError):
                        log_event("queue_poison_retry_failed", level=logging.WARNING, code="queue_unavailable")
                empty_delay = self.settings.empty_poll_min_seconds
                continue
            except QueueProtocolError as exc:
                log_event("queue_protocol_rejected", level=logging.WARNING, code=str(exc))
                self.stop_event.wait(empty_delay)
                empty_delay = min(self.settings.empty_poll_max_seconds, empty_delay * 2)
                continue
            except HttpError:
                log_event("queue_pull_failed", level=logging.WARNING, code="queue_unavailable")
                self.stop_event.wait(empty_delay)
                empty_delay = min(self.settings.empty_poll_max_seconds, empty_delay * 2)
                continue
            if message is None:
                jittered = empty_delay * (0.8 + self._rand() * 0.4)
                self.stop_event.wait(jittered)
                empty_delay = min(self.settings.empty_poll_max_seconds, empty_delay * 2)
                continue
            empty_delay = self.settings.empty_poll_min_seconds
            log_event(
                "queue_message_received",
                analysis_id=message.analysis_id,
                message_id=message.id,
                delivery_attempt=message.attempts,
                published_at_ms=message.timestamp_ms,
            )
            try:
                self.process_message(message)
            except Exception as exc:
                log_event(
                    "message_processing_unexpected",
                    level=logging.ERROR,
                    analysis_id=message.analysis_id,
                    message_id=message.id,
                    error_type=type(exc).__name__,
                )
                self._queue_retry(message)
        log_event("runner_stopped")
