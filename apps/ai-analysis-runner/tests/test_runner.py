from __future__ import annotations

import json
import tempfile
import threading
import unittest
import uuid
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from unittest.mock import patch

from ai_analysis_runner.checkpoint import ResultCheckpointStore
from ai_analysis_runner.engine import EngineFailure
from ai_analysis_runner.http import HttpError
from ai_analysis_runner.models import Analysis, QueueMessage
from ai_analysis_runner.normalize import normalize_result
from ai_analysis_runner.runner import AnalysisRunner

from tests.helpers import output, settings

NOW = datetime(2026, 8, 23, 12, 0, tzinfo=UTC)


class FakeQueue:
    def __init__(self) -> None:
        self.acked: list[str] = []
        self.retried: list[tuple[str, int]] = []

    def ack(self, message: QueueMessage) -> None:
        self.acked.append(message.id)

    def retry(self, message: QueueMessage, delay: int) -> None:
        self.retried.append((message.id, delay))


class PullQueue(FakeQueue):
    def __init__(self, messages: list[QueueMessage]) -> None:
        super().__init__()
        self.messages = messages

    def pull(self) -> QueueMessage | None:
        return self.messages.pop(0) if self.messages else None


class FakeD1:
    def __init__(self, analysis: Analysis) -> None:
        self.analysis = analysis
        self.complete_calls = 0
        self.fail_calls = 0
        self.requeue_calls = 0
        self.complete_error = False
        self.heartbeat_ok = True
        self.completed_result_json: str | None = None
        self.leaseLost = threading.Event()

    def get_analysis(self, _analysis_id: str) -> Analysis:
        return self.analysis

    def claim(self, _analysis_id: str, message_id: str, token: str, _now: str, _stale: str) -> Analysis | None:
        if self.analysis.status not in {"queued", "running"}:
            return None
        if self.analysis.status == "running" and self.analysis.execution_token not in {None, "stale"}:
            return None
        self.analysis = replace(
            self.analysis,
            status="running",
            attempt_count=self.analysis.attempt_count + 1,
            execution_token=token,
            execution_message_id=message_id,
        )
        return self.analysis

    def heartbeat(self, *_args: Any) -> bool:
        if not self.heartbeat_ok:
            self.leaseLost.set()
            return False
        return True

    def complete(self, _id: str, _message: str, token: str, result_json: str, _completed: str, _valid: str) -> bool:
        self.complete_calls += 1
        if self.complete_error:
            raise HttpError("d1_request_failed", retryable=True)
        if self.analysis.execution_token != token:
            return False
        self.completed_result_json = result_json
        self.analysis = replace(self.analysis, status="completed")
        return True

    def fail(self, _id: str, _message: str, token: str, _now: str, _code: str, _safe: str) -> bool:
        self.fail_calls += 1
        if self.analysis.execution_token != token:
            return False
        self.analysis = replace(self.analysis, status="failed")
        return True

    def requeue(self, _id: str, _message: str, token: str, _now: str, _code: str, _safe: str) -> bool:
        self.requeue_calls += 1
        if self.analysis.execution_token != token:
            return False
        self.analysis = replace(self.analysis, status="queued", execution_token=None, execution_message_id=None)
        return True


class FakeEngine:
    def __init__(self, failure: EngineFailure | None = None) -> None:
        self.failure = failure
        self.calls = 0

    def run(self, *_args: str) -> Any:
        self.calls += 1
        if self.failure:
            raise self.failure
        return output()


def analysis(status: str = "queued", attempt: int = 0) -> Analysis:
    return Analysis(
        str(uuid.uuid4()), "AAPL", status, "2026-08-21", attempt,
        None if status == "queued" else "stale", None, None,
    )


def message(value: Analysis) -> QueueMessage:
    return QueueMessage("message-1", 1, "secret-lease", value.id)


class RunnerTests(unittest.TestCase):
    def build(self, directory: str, current: Analysis, engine: FakeEngine, **setting_overrides: Any) -> tuple[AnalysisRunner, FakeQueue, FakeD1]:
        queue = FakeQueue()
        d1 = FakeD1(current)
        value = settings(Path(directory), **setting_overrides)
        runner = AnalysisRunner(
            value, queue, d1, engine, ResultCheckpointStore(value.state_dir, value.result_max_bytes), now=lambda: NOW,
        )
        return runner, queue, d1

    def test_success_checkpoints_before_complete_and_acks_only_terminal(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            current = analysis()
            engine = FakeEngine()
            runner, queue, d1 = self.build(directory, current, engine)
            runner.process_message(message(current))
            self.assertEqual(d1.complete_calls, 1)
            self.assertEqual(queue.acked, ["message-1"])
            self.assertEqual(d1.analysis.status, "completed")
            self.assertFalse((Path(directory) / "pending-results" / f"{current.id}.json").exists())
            assert d1.completed_result_json is not None
            self.assertEqual(json.loads(d1.completed_result_json)["symbol"], "AAPL")

    def test_lost_lease_abandons_without_ack_fail_or_requeue(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            current = analysis()
            engine = FakeEngine()
            runner, queue, d1 = self.build(directory, current, engine, heartbeat_interval_seconds=0)
            d1.heartbeat_ok = False
            original_run = engine.run

            def slow_run(*_args: str) -> Any:
                # Deterministic barrier: block the engine until the background
                # heartbeat thread has actually observed the lost lease, instead
                # of racing a sleep against thread scheduling.
                d1.leaseLost.wait(timeout=2)
                return original_run()

            engine.run = slow_run
            runner.process_message(message(current))
            self.assertTrue(d1.leaseLost.is_set())
            self.assertEqual(d1.complete_calls, 0)
            self.assertEqual(d1.fail_calls, 0)
            self.assertEqual(d1.requeue_calls, 0)
            self.assertEqual(queue.acked, [])
            self.assertEqual(queue.retried, [])

    def test_redelivery_recovers_normalized_checkpoint_without_paid_call(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            current = analysis()
            engine = FakeEngine()
            runner, queue, d1 = self.build(directory, current, engine)
            result = normalize_result("AAPL", "2026-08-21", "2026-08-23T12:00:00.000Z", output())
            runner.checkpoints.save(current.id, result)
            runner.process_message(message(current))
            self.assertEqual(engine.calls, 0)
            self.assertEqual(d1.complete_calls, 1)
            self.assertEqual(queue.acked, ["message-1"])

    def test_ambiguous_complete_short_retries_and_preserves_checkpoint_for_no_cost_recovery(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            current = analysis()
            engine = FakeEngine()
            runner, queue, d1 = self.build(directory, current, engine)
            d1.complete_error = True
            runner.process_message(message(current))
            self.assertEqual(engine.calls, 1)
            self.assertEqual(queue.acked, [])
            self.assertEqual(queue.retried, [("message-1", 60)])
            self.assertTrue((Path(directory) / "pending-results" / f"{current.id}.json").exists())

    def test_retryable_failure_requeues_before_queue_retry_and_does_not_ack(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            current = analysis(attempt=0)
            engine = FakeEngine(EngineFailure("provider_failed", "Provider failed.", retryable=True))
            runner, queue, d1 = self.build(directory, current, engine)
            runner.process_message(message(current))
            self.assertEqual(d1.requeue_calls, 1)
            self.assertEqual(queue.retried, [("message-1", 60)])
            self.assertEqual(queue.acked, [])

    def test_final_attempt_fails_then_trigger_owned_refund_path_can_ack(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            current = analysis(attempt=2)
            engine = FakeEngine(EngineFailure("provider_failed", "Provider failed.", retryable=True))
            runner, queue, d1 = self.build(directory, current, engine, max_analysis_attempts=3)
            runner.process_message(message(current))
            self.assertEqual(d1.fail_calls, 1)
            self.assertEqual(d1.analysis.status, "failed")
            self.assertEqual(queue.acked, ["message-1"])
            self.assertEqual(queue.retried, [])

    def test_nonretryable_failure_is_immediately_definitive(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            current = analysis()
            engine = FakeEngine(EngineFailure("engine_unavailable", "Engine unavailable.", retryable=False))
            runner, queue, d1 = self.build(directory, current, engine)
            runner.process_message(message(current))
            self.assertEqual(d1.fail_calls, 1)
            self.assertEqual(queue.acked, ["message-1"])

    def test_existing_terminal_is_idempotently_acked_without_claim_or_engine(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            current = analysis(status="completed")
            engine = FakeEngine()
            runner, queue, d1 = self.build(directory, current, engine)
            runner.process_message(message(current))
            self.assertEqual(engine.calls, 0)
            self.assertEqual(d1.complete_calls, 0)
            self.assertEqual(queue.acked, ["message-1"])

    def test_poison_message_does_not_stop_next_message(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            first = analysis()
            second = analysis()
            first_message = QueueMessage("message-1", 1, "lease-1", first.id)
            second_message = QueueMessage("message-2", 1, "lease-2", second.id)
            runner, _, _ = self.build(directory, first, FakeEngine())
            runner.queue = PullQueue([first_message, second_message])
            processed: list[str] = []

            def process(current: QueueMessage) -> None:
                processed.append(current.id)
                if current.id == "message-1":
                    raise KeyError("poison")
                runner.stop_event.set()

            with patch.object(runner, "process_message", side_effect=process):
                runner.run_forever()

            self.assertEqual(processed, ["message-1", "message-2"])


if __name__ == "__main__":
    unittest.main()
