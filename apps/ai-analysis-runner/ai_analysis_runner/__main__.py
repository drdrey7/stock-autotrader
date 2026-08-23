"""Service entrypoint."""

from __future__ import annotations

import logging
import signal
import threading

from .checkpoint import ResultCheckpointStore
from .config import ConfigError, from_env
from .d1 import D1Client
from .engine import TradingAgentsEngine
from .queue_client import QueueClient
from .runner import AnalysisRunner
from .structured_logging import configure_logging, log_event


def main() -> int:
    configure_logging()
    try:
        settings = from_env()
    except ConfigError as exc:
        log_event("configuration_invalid", level=logging.ERROR, code=str(exc))
        return 2

    stop_event = threading.Event()

    def request_stop(_signum: int, _frame: object) -> None:
        stop_event.set()

    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGINT, request_stop)
    queue = QueueClient(
        settings.cloudflare_queues_api_token,
        settings.cloudflare_account_id,
        settings.cloudflare_ai_queue_id,
        visibility_timeout_ms=settings.queue_visibility_timeout_ms,
        timeout_seconds=settings.queue_request_timeout_seconds,
        max_attempts=settings.http_max_attempts,
    )
    d1 = D1Client(
        settings.cloudflare_api_token,
        settings.cloudflare_account_id,
        settings.cloudflare_d1_database_id,
        timeout_seconds=settings.d1_request_timeout_seconds,
        max_attempts=settings.http_max_attempts,
    )
    runner = AnalysisRunner(
        settings,
        queue,
        d1,
        TradingAgentsEngine(settings),
        ResultCheckpointStore(settings.state_dir, settings.result_max_bytes),
        stop_event=stop_event,
    )
    runner.run_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
