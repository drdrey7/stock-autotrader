"""Private filesystem helpers for runner state directories."""

from __future__ import annotations

from pathlib import Path

_PRIVATE_MODE = 0o700


def ensure_private_directory(path: Path) -> None:
    """Create every missing ancestor and the leaf explicitly with mode 0o700.

    ``Path.mkdir(mode=0o700, parents=True)`` only applies the mode to the final
    component; parents are created with ``0o777 & ~umask`` (commonly 0o755).
    This helper walks from the deepest missing level up and creates each missing
    directory one at a time so every created level is private.
    """

    missing: list[Path] = []
    node = path
    while not node.exists():
        missing.append(node)
        parent = node.parent
        if parent == node:  # reached the filesystem root
            break
        node = parent
    for level in reversed(missing):
        level.mkdir(mode=_PRIVATE_MODE, exist_ok=True)