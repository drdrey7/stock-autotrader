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

# Verify all 4 required variables are present and non-empty. Never print values.
for var in ALPHA_VANTAGE_API_KEYS CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_D1_DATABASE_ID; do
    if ! grep -Eq "^${var}=[^[:space:]].*$" "$CANDIDATE"; then
        echo "ERROR: Required variable $var missing or empty in vault" >&2
        exit 1
    fi
done

# Match history_ingestor.config.parse_keys(): comma-separated, non-empty,
# alphanumeric keys only. Never print the key values.
validate_alpha_vantage_keys() {
    local raw key
    local -a keys
    raw=$(awk -F= '$1 == "ALPHA_VANTAGE_API_KEYS" { sub(/^[^=]*=/, ""); print; exit }' "$CANDIDATE")
    IFS=',' read -r -a keys <<< "$raw"
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

# Parse the actual ISO timestamp from systemd output. Ignore weekday names;
# they are presentation text and must not participate in safety decisions.
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

# Verify next legitimate triggers are in a future UTC day (proof of safety).
echo
echo "=== Verifying next OnCalendar windows (must be in a future UTC day) ==="
if ! MAINT_NEXT=$(calendar_next_timestamp '*-*-* 07:00:00 UTC'); then exit 1; fi
if ! BOOT_NEXT=$(calendar_next_timestamp '*-*-* 06:00:00 UTC'); then exit 1; fi
if ! DUE_NEXT=$(calendar_next_timestamp 'Tue..Sat *-*-* 13:10:00 UTC'); then exit 1; fi
if ! MAINT_NEXT_EPOCH=$(timestamp_to_epoch "$MAINT_NEXT"); then exit 1; fi
if ! BOOT_NEXT_EPOCH=$(timestamp_to_epoch "$BOOT_NEXT"); then exit 1; fi
if ! DUE_NEXT_EPOCH=$(timestamp_to_epoch "$DUE_NEXT"); then exit 1; fi

NOW_EPOCH=$(date -u +%s)
TODAY_START_EPOCH=$(date -u -d "$(date -u +%Y-%m-%d) 00:00:00 UTC" +%s)
TOMORROW_START_EPOCH=$((TODAY_START_EPOCH + 86400))
if (( MAINT_NEXT_EPOCH <= NOW_EPOCH || MAINT_NEXT_EPOCH < TOMORROW_START_EPOCH \
    || BOOT_NEXT_EPOCH <= NOW_EPOCH || BOOT_NEXT_EPOCH < TOMORROW_START_EPOCH \
    || DUE_NEXT_EPOCH <= NOW_EPOCH || DUE_NEXT_EPOCH < TOMORROW_START_EPOCH )); then
    echo "ERROR: A next trigger is not in a future UTC day" >&2
    exit 1
fi
echo "  maintenance: $MAINT_NEXT"
echo "  bootstrap:   $BOOT_NEXT"
echo "  due-split:    $DUE_NEXT"

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
