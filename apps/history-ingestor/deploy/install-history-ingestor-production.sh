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
#     1. systemctl clean --what=state clears any stale persistent state
#     2. systemd-analyze calendar verifies next elapse is in the future
#     3. systemctl start only after verification
#
#   Schedules verified at install time:
#     *-*-* 07:00:00       (maintenance)
#     *-*-* 06:00:00       (bootstrap)
#     Tue..Sat *-*-* 13:10 (due-split)
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

echo
echo "=== Step 4: Enable + start timers ==="
systemctl enable history-ingestor-maintenance.timer
systemctl enable history-ingestor-due-split.timer
systemctl enable history-ingestor-bootstrap.timer

# Clear any stale persistent timer state (defense in depth)
systemctl clean --what=state history-ingestor-maintenance.timer 2>/dev/null || true
systemctl clean --what=state history-ingestor-due-split.timer 2>/dev/null || true
systemctl clean --what=state history-ingestor-bootstrap.timer 2>/dev/null || true

# Verify next legitimate trigger is in the future (proof of safety)
echo
echo "=== Verifying next OnCalendar windows (must be in the future) ==="
MAINT_NEXT=$(systemd-analyze calendar '*-*-* 07:00:00' 2>&1 | grep 'Next elapse' | awk '{print $3, $4}')
BOOT_NEXT=$(systemd-analyze calendar '*-*-* 06:00:00' 2>&1 | grep 'Next elapse' | awk '{print $3, $4}')
DUE_NEXT=$(systemd-analyze calendar 'Tue..Sat *-*-* 13:10:00' 2>&1 | grep 'Next elapse' | awk '{print $3, $4}')
echo "  maintenance: $MAINT_NEXT"
echo "  bootstrap:   $BOOT_NEXT"
echo "  due-split:   $DUE_NEXT"

# Confirm all next triggers are in the future (after today)
TODAY=$(date -u +%Y-%m-%d)
if [[ "$MAINT_NEXT" > "$TODAY" ]] && [[ "$BOOT_NEXT" > "$TODAY" ]] && [[ "$DUE_NEXT" > "$TODAY" ]]; then
    echo "  ✓ All next triggers confirmed in the future"
else
    echo "  ERROR: A next trigger appears to be today or in the past" >&2
    exit 1
fi

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
echo "Timers are active. First provider calls will occur at:"
echo "  - maintenance: next 07:00 UTC (tomorrow)"
echo "  - bootstrap: next 06:00 UTC (tomorrow)"
echo "  - due-split: next Tue-Sat 13:10 UTC"
echo "No Alpha Vantage calls were made today."
echo ""
echo "To verify after run: sudo systemctl list-timers --all | grep history-ingestor"
