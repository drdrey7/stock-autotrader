#!/usr/bin/env bash
# One-time installer for the history-ingestor production automation.
# Requires root (writes to /etc/systemd/system, /etc/stock-autotrader).
#
# Usage:
#   sudo ./deploy/install-history-ingestor-production.sh
#
# This script:
#   1. Creates /etc/stock-autotrader/alpha-vantage.env from the private vault
#   2. Installs permanent maintenance + due-split units
#   3. Installs temporary bootstrap units
#   4. Enables + starts all 3 timers
#   5. Does NOT invoke any provider calls (no Alpha Vantage requests)
#
# TIMER STRATEGY — SAFE TO RUN NOW:
#   The timers have Persistent=true for future outage catch-up, but a fresh
#   install waits for the next legitimate OnCalendar match. Per systemd docs,
#   Persistent=true only causes catch-up activation if the timer has ALREADY
#   been triggered at least once (stored in /var/lib/systemd/timers/).
#
#   Defense in depth:
#     1. systemd-analyze calendar verifies next elapse is in a future UTC day
#     2. active timers are stopped and persistent state is cleared after that check
#     3. systemctl start runs only after validation and state reset
#
#   Schedules verified at install time:
#     *-*-* 07:00:00 UTC       (maintenance)
#     *-*-* 06:00:00 UTC       (bootstrap)
#     Tue..Sat *-*-* 13:10 UTC (due-split)
set -euo pipefail

REPO=/home/hermes/projects/stock-autotrader
APP="$REPO/apps/history-ingestor"
DIR=/etc/stock-autotrader
VAULT=/home/hermes/.secrets/stock-autotrader/history.env

command -v systemctl >/dev/null 2>&1 || { echo "systemctl not found" >&2; exit 1; }
[ -d "$APP/deploy" ] || { echo "deploy dir missing: $APP" >&2; exit 1; }
[ -f "$VAULT" ] || { echo "vault secrets missing: $VAULT" >&2; exit 1; }

ENV_FILE="$DIR/alpha-vantage.env"
CANDIDATE=""
cleanup_candidate() {
    if [ -n "$CANDIDATE" ] && [ -e "$CANDIDATE" ]; then
        rm -f -- "$CANDIDATE"
    fi
}
trap cleanup_candidate EXIT

# Preflight schedule safety before changing EnvironmentFile or unit files.
# Ignore weekday display text; compare actual UTC timestamps numerically.
calendar_next_timestamp() {
    local expression="$1"
    local output
    local timestamp

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

echo "=== Preflight: verify future UTC schedule windows ==="
verify_future_schedules

echo "=== Step 1: Validate and install $ENV_FILE ==="
mkdir -p "$DIR"
umask 077

# Build and validate a same-directory candidate. The existing EnvironmentFile
# is untouched until every required value passes validation.
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

chown hermes:hermes "$CANDIDATE"
chmod 0600 "$CANDIDATE"
# CANDIDATE and ENV_FILE share DIR, so rename is atomic on the same filesystem.
mv -f -- "$CANDIDATE" "$ENV_FILE"
CANDIDATE=""
echo "Created: $ENV_FILE (mode 0600, owner hermes:hermes)"
echo "Required vars verified: 4/4"

echo
echo "=== Step 2: Install systemd units ==="
install -o root -g root -m 0644 "$APP/deploy/history-ingestor-maintenance.service" /etc/systemd/system/
install -o root -g root -m 0644 "$APP/deploy/history-ingestor-maintenance.timer" /etc/systemd/system/
install -o root -g root -m 0644 "$APP/deploy/history-ingestor-due-split.service" /etc/systemd/system/
install -o root -g root -m 0644 "$APP/deploy/history-ingestor-due-split.timer" /etc/systemd/system/
install -o root -g root -m 0644 "$APP/deploy/history-ingestor-bootstrap.service" /etc/systemd/system/
install -o root -g root -m 0644 "$APP/deploy/history-ingestor-bootstrap.timer" /etc/systemd/system/
echo "Installed 6 unit files to /etc/systemd/system/"

echo
echo "=== Step 3: daemon-reload ==="
systemctl daemon-reload

# Prevent Persistent=true from catching up a missed occurrence. Stop active
# timers only after the future-window check, then clear their in-memory/on-disk
# stamps before the first start.
stop_active_timer() {
    local timer="$1"
    if systemctl is-active --quiet "$timer"; then
        systemctl stop "$timer"
    fi
}

echo "=== Resetting persistent timer state before start ==="
for timer in history-ingestor-maintenance.timer history-ingestor-due-split.timer history-ingestor-bootstrap.timer; do
    stop_active_timer "$timer"
    systemctl clean --what=state "$timer"
done

echo
echo "=== Step 4: Enable + start timers ==="
systemctl enable history-ingestor-maintenance.timer
systemctl enable history-ingestor-due-split.timer
systemctl enable history-ingestor-bootstrap.timer

# Safe to start timers now
systemctl start history-ingestor-maintenance.timer
systemctl start history-ingestor-due-split.timer
systemctl start history-ingestor-bootstrap.timer
echo "Timers enabled and started — waiting for next legitimate OnCalendar window"

echo
echo "=== Verification ==="
systemctl list-timers --all | grep history-ingestor || true
echo
echo "=== DONE ==="
echo "Timers are active. Next scheduled windows:"
echo "  - maintenance: $MAINT_NEXT"
echo "  - bootstrap:   $BOOT_NEXT"
echo "  - due-split:   $DUE_NEXT"
echo "No Alpha Vantage calls were made today."
echo ""
echo "To verify after run: sudo systemctl list-timers --all | grep history-ingestor"
