"""Logging setup: console + rotating file, structured-ish, safe by default."""
from __future__ import annotations

import logging
import sys
from logging.handlers import RotatingFileHandler
from pathlib import Path

_FORMAT = "%(asctime)s %(levelname)s [%(name)s] %(message)s"


def setup_logging(log_level: str = "INFO", log_file: Path | None = None) -> None:
    level = getattr(logging, log_level.upper(), logging.INFO)
    root = logging.getLogger()
    root.setLevel(level)

    if root.handlers:
        return

    console = logging.StreamHandler(sys.stderr)
    console.setFormatter(logging.Formatter(_FORMAT))
    root.addHandler(console)

    if log_file is not None:
        log_file.parent.mkdir(parents=True, exist_ok=True)
        file_handler = RotatingFileHandler(log_file, maxBytes=5_000_000, backupCount=3)
        file_handler.setFormatter(logging.Formatter(_FORMAT))
        root.addHandler(file_handler)


def get_logger(name: str) -> logging.Logger:
    return logging.getLogger(name)
