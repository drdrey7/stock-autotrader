"""Cloudflare Queues HTTP pull-consumer client."""

from __future__ import annotations

import base64
import binascii
import json
import re
import urllib.request
import uuid
from collections.abc import Callable
from typing import Any

from .constants import JOB_SCHEMA_VERSION
from .http import HttpError, post_json
from .models import QueueMessage

QUEUE_ENDPOINT = "https://api.cloudflare.com/client/v4/accounts/{account_id}/queues/{queue_id}/messages/{action}"
_MESSAGE_ID = re.compile(r"^[A-Za-z0-9_-]{1,256}$")


class QueueProtocolError(RuntimeError):
    """A poison or unsupported Queue message that must not reach the engine."""


class QueueClient:
    def __init__(
        self,
        api_token: str,
        account_id: str,
        queue_id: str,
        *,
        visibility_timeout_ms: int,
        timeout_seconds: float,
        max_attempts: int,
        opener: Callable[..., Any] = urllib.request.urlopen,
    ) -> None:
        self._token = api_token
        self._base = QUEUE_ENDPOINT.format(account_id=account_id, queue_id=queue_id, action="{action}")
        self._visibility_timeout_ms = visibility_timeout_ms
        self._timeout = timeout_seconds
        self._max_attempts = max_attempts
        self._opener = opener

    def _post(self, action: str, body: dict[str, Any], *, max_attempts: int | None = None) -> dict[str, Any]:
        payload = post_json(
            self._base.format(action=action),
            self._token,
            body,
            timeout_seconds=self._timeout,
            max_attempts=self._max_attempts if max_attempts is None else max_attempts,
            opener=self._opener,
        )
        if payload.get("success") is not True:
            raise HttpError("queue_api_failed", retryable=False)
        return payload

    def pull(self) -> QueueMessage | None:
        payload = self._post(
            "pull",
            {"batch_size": 1, "visibility_timeout_ms": self._visibility_timeout_ms},
            max_attempts=1,
        )
        result = payload.get("result")
        messages = result.get("messages") if isinstance(result, dict) else None
        if messages is None:
            raise QueueProtocolError("queue_pull_response_invalid")
        if not isinstance(messages, list):
            raise QueueProtocolError("queue_pull_response_invalid")
        if not messages:
            return None
        if len(messages) != 1 or not isinstance(messages[0], dict):
            raise QueueProtocolError("queue_pull_response_invalid")
        return self._parse_message(messages[0])

    def _parse_message(self, raw: dict[str, Any]) -> QueueMessage:
        message_id = raw.get("id")
        lease_id = raw.get("lease_id")
        attempts = raw.get("attempts")
        if not isinstance(message_id, str) or not _MESSAGE_ID.fullmatch(message_id):
            raise QueueProtocolError("queue_message_id_invalid")
        if not isinstance(lease_id, str) or not lease_id or len(lease_id) > 2048:
            raise QueueProtocolError("queue_lease_invalid")
        if isinstance(attempts, bool) or not isinstance(attempts, int) or attempts < 1:
            raise QueueProtocolError("queue_attempts_invalid")

        metadata = raw.get("metadata")
        if metadata is None:
            metadata = {}
        if not isinstance(metadata, dict):
            raise QueueProtocolError("queue_metadata_invalid")
        content_type = metadata.get("CF-Content-Type", metadata.get("content_type", "text"))
        if not isinstance(content_type, str):
            raise QueueProtocolError("queue_content_type_invalid")
        content_type = content_type.lower()
        body = raw.get("body")
        if not isinstance(body, str):
            raise QueueProtocolError("queue_body_invalid")
        if len(body.encode("utf-8")) > 16_384:
            raise QueueProtocolError("queue_body_too_large")
        if content_type == "v8":
            raise QueueProtocolError("queue_v8_unsupported")
        if content_type in {"json", "bytes"}:
            try:
                body = base64.b64decode(body, validate=True).decode("utf-8")
            except (binascii.Error, UnicodeDecodeError) as exc:
                raise QueueProtocolError("queue_base64_invalid") from exc
        elif content_type != "text":
            raise QueueProtocolError("queue_content_type_unsupported")
        try:
            job = json.loads(body)
        except json.JSONDecodeError as exc:
            raise QueueProtocolError("queue_job_json_invalid") from exc
        if not isinstance(job, dict) or set(job) != {"schemaVersion", "analysisId"}:
            raise QueueProtocolError("queue_job_shape_invalid")
        if job.get("schemaVersion") != JOB_SCHEMA_VERSION or isinstance(job.get("schemaVersion"), bool):
            raise QueueProtocolError("queue_job_version_unsupported")
        analysis_id = job.get("analysisId")
        try:
            canonical_id = str(uuid.UUID(analysis_id)) if isinstance(analysis_id, str) else ""
        except ValueError as exc:
            raise QueueProtocolError("queue_analysis_id_invalid") from exc
        if canonical_id != analysis_id.lower():
            raise QueueProtocolError("queue_analysis_id_invalid")
        timestamp_ms = raw.get("timestamp_ms")
        if isinstance(timestamp_ms, bool) or not isinstance(timestamp_ms, int):
            timestamp_ms = None
        return QueueMessage(message_id, attempts, lease_id, canonical_id, timestamp_ms)

    def ack(self, message: QueueMessage) -> None:
        self._post("ack", {"acks": [{"lease_id": message.lease_id}], "retries": []})

    def retry(self, message: QueueMessage, delay_seconds: int) -> None:
        self._post(
            "ack",
            {"acks": [], "retries": [{"lease_id": message.lease_id, "delay_seconds": delay_seconds}]},
        )
