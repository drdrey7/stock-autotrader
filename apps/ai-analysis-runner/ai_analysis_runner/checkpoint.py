"""Durable local normalized-result checkpoint before the terminal D1 CAS."""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
import uuid
from pathlib import Path
from typing import Any

from .normalize import ResultValidationError, serialize_result, validate_result


class CheckpointError(RuntimeError):
    """A local checkpoint was absent or invalid."""


class ResultCheckpointStore:
    def __init__(self, state_dir: Path, max_result_bytes: int) -> None:
        self._directory = state_dir / "pending-results"
        self._max_result_bytes = max_result_bytes

    @staticmethod
    def _canonical_id(analysis_id: str) -> str:
        try:
            canonical = str(uuid.UUID(analysis_id))
        except ValueError as exc:
            raise CheckpointError("checkpoint_id_invalid") from exc
        if canonical != analysis_id.lower():
            raise CheckpointError("checkpoint_id_invalid")
        return canonical

    def _path(self, analysis_id: str) -> Path:
        return self._directory / f"{self._canonical_id(analysis_id)}.json"

    def save(self, analysis_id: str, result: dict[str, Any]) -> None:
        validate_result(result, max_bytes=self._max_result_bytes)
        result_json = serialize_result(result)
        envelope = {
            "analysisId": self._canonical_id(analysis_id),
            "sha256": hashlib.sha256(result_json.encode("utf-8")).hexdigest(),
            "result": result,
        }
        self._directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        descriptor, temporary = tempfile.mkstemp(prefix=".pending-", suffix=".tmp", dir=self._directory)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                os.fchmod(handle.fileno(), 0o600)
                json.dump(envelope, handle, separators=(",", ":"), sort_keys=True, ensure_ascii=False, allow_nan=False)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, self._path(analysis_id))
        except BaseException:
            try:
                os.unlink(temporary)
            except FileNotFoundError:
                pass
            raise

    def load(self, analysis_id: str, symbol: str, analysis_date: str) -> dict[str, Any] | None:
        path = self._path(analysis_id)
        try:
            raw = path.read_bytes()
        except FileNotFoundError:
            return None
        if len(raw) > self._max_result_bytes + 65_536:
            raise CheckpointError("checkpoint_too_large")
        try:
            envelope = json.loads(raw.decode("utf-8"))
            if not isinstance(envelope, dict) or set(envelope) != {"analysisId", "sha256", "result"}:
                raise CheckpointError("checkpoint_shape_invalid")
            if envelope["analysisId"] != self._canonical_id(analysis_id):
                raise CheckpointError("checkpoint_analysis_mismatch")
            result = envelope["result"]
            validate_result(result, max_bytes=self._max_result_bytes)
            serialized = serialize_result(result)
            digest = hashlib.sha256(serialized.encode("utf-8")).hexdigest()
            if envelope["sha256"] != digest:
                raise CheckpointError("checkpoint_digest_invalid")
            if result["symbol"] != symbol or result["analysisDate"] != analysis_date:
                raise CheckpointError("checkpoint_subject_mismatch")
            return result
        except (UnicodeDecodeError, json.JSONDecodeError, ResultValidationError, KeyError, TypeError) as exc:
            raise CheckpointError("checkpoint_invalid") from exc

    def delete(self, analysis_id: str) -> None:
        try:
            self._path(analysis_id).unlink()
        except FileNotFoundError:
            pass
