#!/usr/bin/env bash
# One-time installer for the history-ingestor production automation.
# Requires root (writes to /etc/systemd/system, /etc/stock-autotrader).
#
# Usage:
#   sudo ./deploy/install-history-ingestor-production.sh
#
# This script:
#   1. Validates all prerequisites (preflight, read-only)
#   2. Snapshots current state for rollback
#   3. Quiesces existing timers
#   4. Installs EnvironmentFile + systemd units
#   5. Enables + starts all 3 timers
#   6. Does NOT invoke any provider calls (no Alpha Vantage requests)
#
# FAILURE MODES:
#   A) Failure BEFORE mutation → NO-CHANGE (healthy install preserved)
#   B) Failure AFTER mutation started → ROLLBACK to previous state
#
# TIMER STRATEGY — SAFE TO RUN NOW:
#   The timers have Persistent=true for future outage catch-up, but a fresh
#   install waits for the next legitimate OnCalendar match. Per systemd docs,
#   Persistent=true only causes catch-up activation if the timer has ALREADY
#   been triggered at least once (stored in /var/lib/systemd/timers/).
#
#   Schedules verified at install time:
#     *-*-* 07:00:00 UTC       (maintenance)
#     *-*-* 06:00:00 UTC       (bootstrap)
#     Tue..Sat *-*-* 13:10 UTC (due-split)
set -euo pipefail

REPO="${REPO:-/home/hermes/projects/stock-autotrader}"
APP="${APP:-$REPO/apps/history-ingestor}"
DIR="${DIR:-/etc/stock-autotrader}"
VAULT="${VAULT:-/home/hermes/.secrets/stock-autotrader/history.env}"

ENV_FILE="$DIR/alpha-vantage.env"
CANDIDATE=""
MUTATION_STARTED=0
BACKUP_DIR=""
TIMERS=(history-ingestor-maintenance.timer history-ingestor-due-split.timer history-ingestor-bootstrap.timer)
UNITS=(history-ingestor-maintenance.service history-ingestor-maintenance.timer history-ingestor-due-split.service history-ingestor-due-split.timer history-ingestor-bootstrap.service history-ingestor-bootstrap.timer)

# Track original state for rollback
declare -A ORIGINAL_TIMER_ACTIVE
declare -A ORIGINAL_TIMER_ENABLED
ORIGINAL_ENV_EXISTS=0
ORIGINAL_ENV_CONTENT=""

cleanup_candidate() {
    if [ -n "$CANDIDATE" ] && [ -e "$CANDIDATE" ]; then
        rm -f -- "$CANDIDATE"
    fi
}

cleanup_backup_dir() {
    if [ -n "$BACKUP_DIR" ] && [ -d "$BACKUP_DIR" ]; then
        rm -rf -- "$BACKUP_DIR"
    fi
}

rollback() {
    echo "=== ROLLBACK: Restoring previous state ===" >&2
    local rc=0

    # Restore EnvironmentFile
    if [ "$ORIGINAL_ENV_EXISTS" -eq 1 ]; then
        if [ -n "$ORIGINAL_ENV_CONTENT" ]; then
            echo "$ORIGINAL_ENV_CONTENT" > "$ENV_FILE" 2>/dev/null || rc=1
        fi
    else
        rm -f "$ENV_FILE" 2>/dev/null || rc=1
    fi

    # Restore unit files from backup
    if [ -n "$BACKUP_DIR" ] && [ -d "$BACKUP_DIR" ]; then
        for unit in "${UNITS[@]}"; do
            if [ -f "$BACKUP_DIR/$unit" ]; then
                cp -f "$BACKUP_DIR/$unit" "/etc/systemd/system/$unit" 2>/dev/null || rc=1
            fi
        done
    fi

    # daemon-reload to pick up restored units
    systemctl daemon-reload 2>/dev/null || rc=1

    # Restore timer enabled/disabled state
    for timer in "${TIMERS[@]}"; do
        if [ "${ORIGINAL_TIMER_ENABLED[$timer]:-0}" -eq 1 ]; then
            systemctl enable "$timer" 2>/dev/null || rc=1
        else
            systemctl disable "$timer" 2>/dev/null || rc=1
        fi
    done

    # Restore timer active/inactive state
    for timer in "${TIMERS[@]}"; do
        if [ "${ORIGINAL_TIMER_ACTIVE[$timer]:-0}" -eq 1 ]; then
            systemctl start "$timer" 2>/dev/null || rc=1
        fi
        # If originally inactive, it stays stopped (no need to re-stop)
    done

    cleanup_backup_dir
    cleanup_candidate

    if [ "$rc" -ne 0 ]; then
        echo "WARNING: Some rollback steps failed. Manual review required." >&2
    fi
    echo "=== ROLLBACK COMPLETE ===" >&2
}

trap cleanup_candidate EXIT

# Phase 6 handler: if mutation started, rollback on error
handle_error() {
    if [ "$MUTATION_STARTED" -eq 1 ]; then
        rollback
    fi
    exit 1
}

trap handle_error ERR

###############################################################################
# PHASE 1: PREFLIGHT (read-only)
###############################################################################

echo "=== Phase 1: Preflight validation (read-only) ==="

# Check prerequisites
command -v systemctl >/dev/null 2>&1 || { echo "ERROR: systemctl not found" >&2; exit 1; }
command -v systemd-analyze >/dev/null 2>&1 || { echo "ERROR: systemd-analyze not found" >&2; exit 1; }
command -v date >/dev/null 2>&1 || { echo "ERROR: date not found" >&2; exit 1; }
[ -d "$APP/deploy" ] || { echo "ERROR: deploy dir missing: $APP" >&2; exit 1; }
[ -f "$VAULT" ] || { echo "ERROR: vault secrets missing: $VAULT" >&2; exit 1; }

# Verify all source unit files exist
for unit in "${UNITS[@]}"; do
    [ -f "$APP/deploy/$unit" ] || { echo "ERROR: unit file missing: $APP/deploy/$unit" >&2; exit 1; }
done

# Verify vault is readable
if ! grep -q '=' "$VAULT" 2>/dev/null; then
    echo "ERROR: vault file is empty or malformed" >&2
    exit 1
fi

# --- Credential validation ---
mkdir -p "$DIR"
umask 077

# Build candidate from vault (never write to ENV_FILE yet)
CANDIDATE=$(mktemp "$DIR/.alpha-vantage.env.tmp.XXXXXX")
if ! grep -E '^(ALPHA_VANTAGE_API_KEYS|CLOUDFLARE_API_TOKEN|CLOUDFLARE_ACCOUNT_ID|CLOUDFLARE_D1_DATABASE_ID)=' "$VAULT" > "$CANDIDATE"; then
    echo "ERROR: Required variables could not be read from vault" >&2
    exit 1
fi

# Verify all 4 required variables are present and non-empty after the basic
# systemd EnvironmentFile quoting rules are applied. Never print values.
assignment_count() {
    local var="$1"
    awk -v name="$var" 'index($0, name "=") == 1 { count++ } END { print count + 0 }' "$CANDIDATE"
}

candidate_value() {
    local var="$1"
    awk -v name="$var" 'index($0, name "=") == 1 { print substr($0, length(name) + 2); exit }' "$CANDIDATE"
}

normalize_env_value() {
    local value="$1"
    local inner last first
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    [[ -n "$value" ]] || return 1

    first="${value:0:1}"
    last="${value: -1}"
    if [[ "$first" == '"' && ${#value} -ge 2 && "$last" == '"' ]]; then
        inner="${value:1:${#value}-2}"
    elif [[ "$first" == "'" && ${#value} -ge 2 && "$last" == "'" ]]; then
        inner="${value:1:${#value}-2}"
    elif [[ "$first" == '"' || "$first" == "'" ]]; then
        return 1
    else
        inner="$value"
    fi

    inner="${inner#"${inner%%[![:space:]]*}"}"
    inner="${inner%"${inner##*[![:space:]]}"}"
    [[ -n "$inner" ]] || return 1
    printf '%s\n' "$inner"
}

validate_effective_value() {
    local var="$1"
    local raw value
    if [[ "$(assignment_count "$var")" != "1" ]]; then
        echo "ERROR: Required variable $var is missing or duplicated in vault" >&2
        return 1
    fi
    raw=$(candidate_value "$var")
    if ! value=$(normalize_env_value "$raw"); then
        echo "ERROR: Required variable $var missing or empty in vault" >&2
        return 1
    fi
}

for var in ALPHA_VANTAGE_API_KEYS CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_D1_DATABASE_ID; do
    validate_effective_value "$var"
done

# Match history_ingestor.config.parse_keys(): comma-separated, non-empty,
# alphanumeric keys only. Never print the key values.
validate_alpha_vantage_keys() {
    local raw key normalized
    local -a keys
    raw=$(candidate_value ALPHA_VANTAGE_API_KEYS)
    if ! normalized=$(normalize_env_value "$raw"); then
        echo "ERROR: ALPHA_VANTAGE_API_KEYS is empty or malformed" >&2
        return 1
    fi
    IFS=',' read -r -a keys <<< "$normalized"
    if ((${#keys[@]} == 0)); then
        echo "ERROR: ALPHA_VANTAGE_API_KEYS is empty or malformed" >&2
        return 1
    fi
    for key in "${keys[@]}"; do
        key="${key#"${key%%[![:space:]]*}"}"
        key="${key%"${key##*[![:space:]]}"}"
        if [[ -z "$key" || ! "$key" =~ ^[A-Za-z0-9]+$ ]]; then
            echo "ERROR: ALPHA_VANTAGE_API_KEYS contains an empty or malformed key" >&2
            return 1
        fi
    done
}
validate_alpha_vantage_keys

echo "  Credentials: OK"

# --- Schedule validation ---
calendar_next_timestamp() {
    local expression="$1"
    local output timestamp
    if ! output=$(systemd-analyze calendar "$expression" 2>&1); then
        echo "ERROR: Could not calculate next trigger for $expression" >&2
        return 1
    fi
    if [[ "$output" =~ ([0-9]{4}-[0-9]{2}-[0-9]{2})[[:space:]]([0-9]{2}:[0-9]{2}:[0-9]{2})([[:space:]][A-Za-z][A-Za-z0-9_+:/-]*)? ]]; then
        timestamp="${BASH_REMATCH[1]} ${BASH_REMATCH[2]}${BASH_REMATCH[3]:- UTC}"
    else
        echo "ERROR: Could not parse next trigger for $expression" >&2
        return 1
    fi
    printf '%s\n' "$timestamp"
}

timestamp_to_epoch() {
    local timestamp="$1"
    local epoch
    if ! epoch=$(date -u -d "$timestamp" +%s 2>/dev/null); then
        echo "ERROR: Could not parse timestamp: $timestamp" >&2
        return 1
    fi
    printf '%s\n' "$epoch"
}

verify_future_schedules() {
    local maint_next boot_next due_next
    local maint_epoch boot_epoch due_epoch now_epoch today_start_epoch tomorrow_start_epoch

    if ! maint_next=$(calendar_next_timestamp '*-*-* 07:00:00 UTC'); then return 1; fi
    if ! boot_next=$(calendar_next_timestamp '*-*-* 06:00:00 UTC'); then return 1; fi
    if ! due_next=$(calendar_next_timestamp 'Tue..Sat *-*-* 13:10:00 UTC'); then return 1; fi
    if ! maint_epoch=$(timestamp_to_epoch "$maint_next"); then return 1; fi
    if ! boot_epoch=$(timestamp_to_epoch "$boot_next"); then return 1; fi
    if ! due_epoch=$(timestamp_to_epoch "$due_next"); then return 1; fi

    now_epoch=$(date -u +%s)
    today_start_epoch=$(date -u -d "$(date -u +%Y-%m-%d) 00:00:00 UTC" +%s)
    tomorrow_start_epoch=$((today_start_epoch + 86400))
    if (( maint_epoch <= now_epoch || maint_epoch < tomorrow_start_epoch \
        || boot_epoch <= now_epoch || boot_epoch < tomorrow_start_epoch \
        || due_epoch <= now_epoch || due_epoch < tomorrow_start_epoch )); then
        echo "ERROR: A next trigger is not in a future UTC day" >&2
        return 1
    fi

    MAINT_NEXT="$maint_next"
    BOOT_NEXT="$boot_next"
    DUE_NEXT="$due_next"
    echo "  maintenance: $MAINT_NEXT"
    echo "  bootstrap:   $BOOT_NEXT"
    echo "  due-split:    $DUE_NEXT"
}

verify_future_schedules
echo "  Schedules: OK"

# Verify source unit files are syntactically valid (basic check)
for unit in "${UNITS[@]}"; do
    if ! grep -q '^\[' "$APP/deploy/$unit" 2>/dev/null; then
        echo "ERROR: unit file missing section header: $unit" >&2
        exit 1
    fi
done
echo "  Unit source files: OK"

echo "=== Preflight PASSED ==="

###############################################################################
# PHASE 2: SNAPSHOT CURRENT STATE
###############################################################################

echo
echo "=== Phase 2: Snapshot current state ==="

BACKUP_DIR=$(mktemp -d /tmp/history-ingestor-backup.XXXXXX)

# Snapshot existing EnvironmentFile
if [ -f "$ENV_FILE" ]; then
    ORIGINAL_ENV_EXISTS=1
    ORIGINAL_ENV_CONTENT=$(cat "$ENV_FILE")
    cp -p "$ENV_FILE" "$BACKUP_DIR/alpha-vantage.env"
    echo "  Backed up: $ENV_FILE"
else
    ORIGINAL_ENV_EXISTS=0
    echo "  No existing EnvironmentFile"
fi

# Snapshot existing unit files
for unit in "${UNITS[@]}"; do
    if [ -f "/etc/systemd/system/$unit" ]; then
        cp -p "/etc/systemd/system/$unit" "$BACKUP_DIR/$unit"
        echo "  Backed up: /etc/systemd/system/$unit"
    fi
done

# Snapshot timer states
for timer in "${TIMERS[@]}"; do
    if systemctl is-active --quiet "$timer" 2>/dev/null; then
        ORIGINAL_TIMER_ACTIVE[$timer]=1
        echo "  Timer $timer: active"
    else
        ORIGINAL_TIMER_ACTIVE[$timer]=0
        echo "  Timer $timer: inactive"
    fi
    if systemctl is-enabled --quiet "$timer" 2>/dev/null; then
        ORIGINAL_TIMER_ENABLED[$timer]=1
    else
        ORIGINAL_TIMER_ENABLED[$timer]=0
    fi
done

echo "=== Snapshot COMPLETE ==="

###############################################################################
# PHASE 3: QUIESCE
###############################################################################

echo
echo "=== Phase 3: Quiesce existing timers ==="

# Stop all timers BEFORE mutation
stop_active_timer() {
    local timer="$1"
    if systemctl is-active --quiet "$timer"; then
        systemctl stop "$timer"
    fi
}
for timer in "${TIMERS[@]}"; do
    stop_active_timer "$timer"
done

# Mark mutation as started (rollback will trigger on error)
MUTATION_STARTED=1
echo "=== Timers quiesced. MUTATION_STARTED=1 ==="

###############################################################################
# PHASE 4: APPLY
###############################################################################

echo
echo "=== Phase 4: Apply installation ==="

# Install EnvironmentFile
chown hermes:hermes "$CANDIDATE"
chmod 0600 "$CANDIDATE"
mv -f -- "$CANDIDATE" "$ENV_FILE"
CANDIDATE=""
echo "  Installed: $ENV_FILE (mode 0600, owner hermes:hermes)"

# Create shared lock/state directory
mkdir -p /var/lib/history-ingestor
chown hermes:hermes /var/lib/history-ingestor
chmod 0755 /var/lib/history-ingestor
echo "  Created: /var/lib/history-ingestor"

# Install systemd units
for unit in "${UNITS[@]}"; do
    install -o root -g root -m 0644 "$APP/deploy/$unit" /etc/systemd/system/
done
echo "  Installed ${#UNITS[@]} unit files"

# daemon-reload
systemctl daemon-reload
echo "  daemon-reload: OK"

# Clear persistent timer state
for timer in "${TIMERS[@]}"; do
    systemctl clean --what=state "$timer"
done
echo "  Persistent timer state cleared"

# Enable + start timers
for timer in "${TIMERS[@]}"; do
    systemctl enable "$timer"
done
echo "  Timers enabled"

for timer in "${TIMERS[@]}"; do
    systemctl start "$timer"
done
echo "  Timers started"

###############################################################################
# PHASE 5: SUCCESS
###############################################################################

echo
echo "=== Phase 5: Success cleanup ==="

# Remove backup directory
cleanup_backup_dir
echo "  Backups removed"

# Verify timers are in expected state
echo
echo "=== Verification ==="
systemctl list-timers --all | grep history-ingestor || true

echo
echo "=== DONE ==="
echo "Timers are active. Next scheduled windows:"
echo "  - maintenance: $MAINT_NEXT"
echo "  - bootstrap:   $BOOT_NEXT"
echo "  - due-split:    $DUE_NEXT"
echo "No Alpha Vantage calls were made today."
echo ""
echo "To verify after run: sudo systemctl list-timers --all | grep history-ingestor"
exit 0
