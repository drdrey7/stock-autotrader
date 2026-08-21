"""Installer ordering harness — proves timers are quiesced BEFORE any mutation.

This harness parses the installer script and verifies the ordering of operations:
    1. All 3 timers are stopped BEFORE any EnvironmentFile/unit mutation.
    2. No `systemctl start` occurs before daemon-reload (validation complete).
    3. The final order is safe: stop → install → daemon-reload → clean → enable → start.

Run manually: python3 -m pytest tests/test_installer_ordering.py -v -s
"""

from __future__ import annotations

import re
from pathlib import Path


def get_installer_path() -> Path:
    return (
        Path(__file__).resolve().parents[1]
        / "deploy"
        / "install-history-ingestor-production.sh"
    )


def extract_operations() -> list[tuple[int, str, str]]:
    """Extract ordered operations from the installer script.

    Returns a list of (line_number, operation_type, line_content).
    """
    installer = get_installer_path()
    lines = installer.read_text().splitlines()

    operations = []
    for i, line in enumerate(lines, 1):
        stripped = line.strip()
        # Skip comments and empty lines
        if not stripped or stripped.startswith("#"):
            continue

        # Detect operations
        if "stop_active_timer" in stripped and "for timer in" in stripped:
            operations.append((i, "stop_loop", stripped))
        elif "stop_active_timer" in stripped and "$timer" in stripped:
            operations.append((i, "stop", stripped))
        elif "install -o root" in stripped and "history-ingestor" in stripped:
            operations.append((i, "install", stripped))
        elif "mv -f --" in stripped and "alpha-vantage" in stripped:
            operations.append((i, "mv_env", stripped))
        elif "systemctl daemon-reload" in stripped:
            operations.append((i, "daemon-reload", stripped))
        elif "systemctl clean" in stripped:
            operations.append((i, "clean", stripped))
        elif "systemctl enable" in stripped and "history-ingestor" in stripped:
            operations.append((i, "enable", stripped))
        elif "systemctl start" in stripped and "history-ingestor" in stripped:
            operations.append((i, "start", stripped))

    return operations


def test_timers_stopped_before_mutation():
    """All 3 timers must be stopped BEFORE any EnvironmentFile/unit mutation."""
    ops = extract_operations()
    assert ops, "No operations extracted — harness did not parse correctly"

    # Find the first stop and first mutation
    first_stop_idx = None
    first_mutation_idx = None
    for i, (line_num, op_type, line) in enumerate(ops):
        if op_type in ("stop", "stop_loop"):
            if first_stop_idx is None:
                first_stop_idx = i
        if op_type in ("install", "mv_env"):
            if first_mutation_idx is None:
                first_mutation_idx = i

    assert first_stop_idx is not None, "No timer stop operations found"
    assert first_mutation_idx is not None, "No mutation operations found"
    assert first_stop_idx < first_mutation_idx, (
        f"Timer stop (idx={first_stop_idx}) must come BEFORE mutation "
        f"(idx={first_mutation_idx}). Operations: {ops}"
    )


def test_all_three_timers_stopped():
    """All 3 timers must be explicitly stopped."""
    installer = get_installer_path()
    content = installer.read_text()

    # Check that all 3 timers are in the stop loop
    stop_section = re.search(
        r'for timer in(.*?); do',
        content,
        re.DOTALL,
    )
    assert stop_section, "Could not find timer stop loop in installer"
    timers_stopped = stop_section.group(1).strip().split()

    expected = {
        "history-ingestor-maintenance.timer",
        "history-ingestor-due-split.timer",
        "history-ingestor-bootstrap.timer",
    }
    assert set(timers_stopped) == expected, (
        f"Expected to stop {expected}, but found {set(timers_stopped)}"
    )


def test_no_start_before_daemon_reload():
    """No systemctl start should occur before daemon-reload."""
    ops = extract_operations()
    assert ops, "No operations extracted"

    first_start_idx = None
    first_daemon_reload_idx = None
    for i, (line_num, op_type, line) in enumerate(ops):
        if op_type == "start" and first_start_idx is None:
            first_start_idx = i
        if op_type == "daemon-reload" and first_daemon_reload_idx is None:
            first_daemon_reload_idx = i

    assert first_daemon_reload_idx is not None, "No daemon-reload found"
    if first_start_idx is not None:
        assert first_start_idx > first_daemon_reload_idx, (
            f"start (idx={first_start_idx}) must come AFTER daemon-reload "
            f"(idx={first_daemon_reload_idx})"
        )


def test_final_order_is_safe():
    """The final order must be: stop → install → daemon-reload → clean → enable → start."""
    ops = extract_operations()

    op_sequence = [op_type for _, op_type, _ in ops]

    def first_idx(op):
        return next((i for i, o in enumerate(op_sequence) if o == op), len(op_sequence))

    assert first_idx("stop") < first_idx("install"), "stop must come before install"
    assert first_idx("install") < first_idx("daemon-reload"), "install must come before daemon-reload"
    assert first_idx("daemon-reload") < first_idx("clean"), "daemon-reload must come before clean"
    assert first_idx("clean") < first_idx("enable"), "clean must come before enable"
    assert first_idx("enable") < first_idx("start"), "enable must come before start"


def test_stop_uses_systemctl_stop():
    """The stop function must use systemctl stop."""
    installer = get_installer_path()
    content = installer.read_text()

    # Find the stop_active_timer function
    stop_func = re.search(
        r'stop_active_timer\(\)\s*\{(.*?)\}',
        content,
        re.DOTALL,
    )
    assert stop_func, "Could not find stop_active_timer function"
    assert "systemctl stop" in stop_func.group(1), (
        "stop_active_timer must use systemctl stop"
    )


def test_stop_checks_is_active():
    """The stop function must check is-active before stopping."""
    installer = get_installer_path()
    content = installer.read_text()

    stop_func = re.search(
        r'stop_active_timer\(\)\s*\{(.*?)\}',
        content,
        re.DOTALL,
    )
    assert stop_func, "Could not find stop_active_timer function"
    assert "is-active" in stop_func.group(1), (
        "stop_active_timer must check is-active before stopping"
    )


if __name__ == "__main__":
    print("Running installer ordering harness...")
    ops = extract_operations()
    print(f"Extracted {len(ops)} operations:")
    for line_num, op_type, line in ops:
        print(f"  L{line_num}: {op_type} -> {line[:60]}")
    test_timers_stopped_before_mutation()
    test_all_three_timers_stopped()
    test_no_start_before_daemon_reload()
    test_final_order_is_safe()
    test_stop_uses_systemctl_stop()
    test_stop_checks_is_active()
    print("ALL HARNESS TESTS PASSED")
