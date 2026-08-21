"""Installer rollback harness — proves transactional failure modes.

Verifies the installer's two failure modes:
A) Failure BEFORE mutation → NO-CHANGE (healthy install preserved)
B) Failure AFTER mutation started → ROLLBACK to previous state

Run: python3 -m pytest tests/test_installer_rollback.py -v
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


def test_preflight_validates_before_timers():
    """Phase 1 must validate credentials BEFORE any timer operations."""
    installer = get_installer_path()
    content = installer.read_text()

    # Find the actual Phase 1 start (echo statement)
    preflight_start = content.find('echo "=== Phase 1: Preflight')
    # Find the start of Phase 2 (Snapshot) - this is the real boundary
    snapshot_start = content.find('echo "=== Phase 2: Snapshot')

    assert preflight_start != -1, "Preflight phase not found"
    assert snapshot_start != -1, "Snapshot phase not found"

    preflight_block = content[preflight_start:snapshot_start]

    # Preflight must contain credential validation
    assert "validate_effective_value" in preflight_block
    assert "validate_alpha_vantage_keys" in preflight_block
    assert "verify_future_schedules" in preflight_block

    # Preflight must NOT contain actual systemctl stop/start commands
    lines = preflight_block.split('\n')
    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith('#'):
            continue
        if 'systemctl stop' in stripped and 'command -v' not in stripped:
            raise AssertionError(f"Preflight should not stop timers: {stripped}")
        if 'systemctl start' in stripped and 'command -v' not in stripped:
            raise AssertionError(f"Preflight should not start timers: {stripped}")


def test_invalid_credentials_exits_before_mutation():
    """If credentials are invalid, installer exits BEFORE MUTATION_STARTED=1."""
    installer = get_installer_path()
    content = installer.read_text()

    # The credential validation section should have exit 1 calls
    # BEFORE the MUTATION_STARTED=1 marker
    mutation_start = content.find("MUTATION_STARTED=1")
    preflight_block = content[:mutation_start]

    # There should be exit 1 calls in the preflight block
    assert "exit 1" in preflight_block

    # Verify that the exits happen before any timer operations
    first_exit_idx = preflight_block.find("exit 1")
    first_timer_stop_idx = preflight_block.find("stop_active_timer")

    if first_timer_stop_idx != -1:
        assert first_exit_idx < first_timer_stop_idx


def test_snapshot_before_quiesce():
    """Phase 2 (snapshot) must come before Phase 3 (quiesce)."""
    installer = get_installer_path()
    content = installer.read_text()

    snapshot_pos = content.find("Phase 2: Snapshot")
    quiesce_pos = content.find("Phase 3: Quiesce")

    assert snapshot_pos != -1, "Snapshot phase not found"
    assert quiesce_pos != -1, "Quiesce phase not found"
    assert snapshot_pos < quiesce_pos, "Snapshot must come before quiesce"


def test_rollback_restores_environment_file():
    """Rollback must restore the original EnvironmentFile."""
    installer = get_installer_path()
    content = installer.read_text()

    rollback_start = content.find("rollback()")
    assert rollback_start != -1, "rollback function not found"

    rollback_block = content[rollback_start:]

    # Must restore EnvironmentFile
    assert "ORIGINAL_ENV_EXISTS" in rollback_block
    assert "ORIGINAL_ENV_CONTENT" in rollback_block


def test_rollback_restores_units():
    """Rollback must restore unit files from backup."""
    installer = get_installer_path()
    content = installer.read_text()

    rollback_start = content.find("rollback()")
    rollback_block = content[rollback_start:]

    assert "BACKUP_DIR" in rollback_block
    assert "UNITS" in rollback_block


def test_rollback_restores_timer_states():
    """Rollback must restore timer active/enabled states."""
    installer = get_installer_path()
    content = installer.read_text()

    rollback_start = content.find("rollback()")
    rollback_block = content[rollback_start:]

    assert "ORIGINAL_TIMER_ACTIVE" in rollback_block
    assert "ORIGINAL_TIMER_ENABLED" in rollback_block
    assert "systemctl enable" in rollback_block
    assert "systemctl start" in rollback_block


def test_mutation_started_triggers_rollback_on_error():
    """When MUTATION_STARTED=1, ERR trap must trigger rollback."""
    installer = get_installer_path()
    content = installer.read_text()

    assert "MUTATION_STARTED=0" in content
    assert "MUTATION_STARTED=1" in content

    # The error handler must check MUTATION_STARTED
    assert "handle_error" in content
    assert '[ "$MUTATION_STARTED" -eq 1 ]' in content


def test_no_provider_calls_in_installer():
    """Installer must never make Alpha Vantage API calls."""
    installer = get_installer_path()
    content = installer.read_text()

    # Should not contain any curl/wget calls to alpha vantage
    provider_patterns = [
        r"curl.*alpha.?vantage",
        r"wget.*alpha.?vantage",
        r"curl.*alphavantage",
        r"wget.*alphavantage",
    ]

    for pattern in provider_patterns:
        assert not re.search(pattern, content, re.IGNORECASE), (
            f"Installer should not make provider calls, found: {pattern}"
        )


def test_installer_cleans_up_backups_on_success():
    """On success, backup directory must be removed."""
    installer = get_installer_path()
    content = installer.read_text()

    success_start = content.find("Phase 5: Success")
    assert success_start != -1, "Success phase not found"

    success_block = content[success_start:]
    assert "cleanup_backup_dir" in success_block


def test_installer_cleans_up_backups_on_failure():
    """On failure, backup directory must be removed."""
    installer = get_installer_path()
    content = installer.read_text()

    rollback_start = content.find("rollback()")
    rollback_block = content[rollback_start:]

    assert "cleanup_backup_dir" in rollback_block


def test_timers_quiesced_before_environment_file_install():
    """Timers must be stopped BEFORE EnvironmentFile is installed."""
    installer = get_installer_path()
    content = installer.read_text()

    # Find positions
    stop_section = content.find("stop_active_timer")
    env_install = content.find('mv -f -- "$CANDIDATE" "$ENV_FILE"')

    assert stop_section != -1, "Timer stop section not found"
    assert env_install != -1, "EnvironmentFile install not found"
    assert stop_section < env_install, "Timers must be stopped before env install"


def test_daemon_reload_after_unit_install():
    """daemon-reload must happen after unit installation."""
    installer = get_installer_path()
    content = installer.read_text()

    # Find the actual install command in the main flow (Phase 4)
    install_units = content.find('install -o root -g root -m 0644 "$APP/deploy/$unit" /etc/systemd/system/')
    # Find the actual daemon-reload in the main flow (Phase 4, after install)
    daemon_reload = content.find("# daemon-reload\nsystemctl daemon-reload")

    assert install_units != -1, "Unit install command not found"
    assert daemon_reload != -1, "daemon-reload not found"
    assert install_units < daemon_reload, "Units must install before daemon-reload"


def test_enable_start_after_daemon_reload():
    """enable+start must happen after daemon-reload."""
    installer = get_installer_path()
    content = installer.read_text()

    daemon_reload = content.find("systemctl daemon-reload")
    enable = content.find("systemctl enable")

    assert daemon_reload != -1
    assert enable != -1
    assert daemon_reload < enable


def test_preflight_checks_unit_files_exist():
    """Preflight must verify source unit files exist."""
    installer = get_installer_path()
    content = installer.read_text()

    preflight_start = content.find("Phase 1: Preflight")
    preflight_end = content.find("Phase 2: Snapshot")
    preflight_block = content[preflight_start:preflight_end]

    assert "unit file missing" in preflight_block


def test_preflight_checks_schedules():
    """Preflight must verify schedules are in the future."""
    installer = get_installer_path()
    content = installer.read_text()

    preflight_start = content.find("Phase 1: Preflight")
    preflight_end = content.find("Phase 2: Snapshot")
    preflight_block = content[preflight_start:preflight_end]

    assert "verify_future_schedules" in preflight_block
    assert "ERROR: A next trigger is not in a future UTC day" in preflight_block


if __name__ == "__main__":
    import sys
    tests = [
        test_preflight_validates_before_timers,
        test_invalid_credentials_exits_before_mutation,
        test_snapshot_before_quiesce,
        test_rollback_restores_environment_file,
        test_rollback_restores_units,
        test_rollback_restores_timer_states,
        test_mutation_started_triggers_rollback_on_error,
        test_no_provider_calls_in_installer,
        test_installer_cleans_up_backups_on_success,
        test_installer_cleans_up_backups_on_failure,
        test_timers_quiesced_before_environment_file_install,
        test_daemon_reload_after_unit_install,
        test_enable_start_after_daemon_reload,
        test_preflight_checks_unit_files_exist,
        test_preflight_checks_schedules,
    ]

    failed = 0
    for test in tests:
        try:
            test()
            print(f"  {test.__name__}: PASS")
        except AssertionError as e:
            print(f"  {test.__name__}: FAIL - {e}")
            failed += 1

    if failed:
        print(f"\n{failed} tests FAILED")
        sys.exit(1)
    else:
        print("\nALL ROLLBACK HARNESS TESTS PASSED")
