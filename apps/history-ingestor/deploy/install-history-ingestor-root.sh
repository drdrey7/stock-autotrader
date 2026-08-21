#!/usr/bin/env bash
# Safe installer for history-ingestor systemd units.
#
# This script intentionally does NOT manage secrets and does NOT start timers.
# Provision the required EnvironmentFiles first, run this installer, then
# explicitly enable/start timers when you are ready for scheduled work.
set -euo pipefail

APP=${APP:-/home/hermes/projects/stock-autotrader/apps/history-ingestor}
SYSTEMD_DIR=${SYSTEMD_DIR:-/etc/systemd/system}
ALPHA_ENV=/etc/stock-autotrader/alpha-vantage.env
CLOUDFLARE_ENV=/etc/stock-autotrader/cloudflare.env

UNITS=(
  history-ingestor-bootstrap.service
  history-ingestor-bootstrap.timer
  history-ingestor-maintenance.service
  history-ingestor-maintenance.timer
  history-ingestor-due-split.service
  history-ingestor-due-split.timer
)
SERVICES=(
  history-ingestor-bootstrap.service
  history-ingestor-maintenance.service
  history-ingestor-due-split.service
)
TIMERS=(
  history-ingestor-bootstrap.timer
  history-ingestor-maintenance.timer
  history-ingestor-due-split.timer
)

command -v systemctl >/dev/null 2>&1 || { echo "ERROR: systemctl not found" >&2; exit 1; }
command -v install >/dev/null 2>&1 || { echo "ERROR: install not found" >&2; exit 1; }
command -v flock >/dev/null 2>&1 || { echo "ERROR: flock not found (install util-linux)" >&2; exit 1; }

[ -r "$ALPHA_ENV" ] || {
  echo "ERROR: missing/unreadable $ALPHA_ENV; provision secrets before install" >&2
  exit 1
}
[ -r "$CLOUDFLARE_ENV" ] || {
  echo "ERROR: missing/unreadable $CLOUDFLARE_ENV; provision secrets before install" >&2
  exit 1
}

for unit in "${UNITS[@]}"; do
  [ -f "$APP/deploy/$unit" ] || {
    echo "ERROR: missing deploy unit: $APP/deploy/$unit" >&2
    exit 1
  }
done

# Keep deployment deliberately simple and safe: never replace unit files while
# a managed timer or service is active. Quiesce the history-ingestor first in a
# planned maintenance window, then re-run this installer.
for unit in "${TIMERS[@]}" "${SERVICES[@]}"; do
  if systemctl is-active --quiet "$unit" 2>/dev/null; then
    echo "ERROR: $unit is active; stop history-ingestor units before reinstalling" >&2
    exit 1
  fi
done

if command -v systemd-analyze >/dev/null 2>&1; then
  systemd-analyze verify "${UNITS[@]/#/$APP/deploy/}" >/dev/null
fi

for unit in "${UNITS[@]}"; do
  install -o root -g root -m 0644 "$APP/deploy/$unit" "$SYSTEMD_DIR/$unit"
done

systemctl daemon-reload

cat <<'EOF'
History-ingestor units installed and reloaded.
No secrets were changed and no timer was enabled or started.

When ready, activate explicitly:
  sudo systemctl enable history-ingestor-bootstrap.timer history-ingestor-maintenance.timer history-ingestor-due-split.timer
  sudo systemctl start history-ingestor-bootstrap.timer history-ingestor-maintenance.timer history-ingestor-due-split.timer

Verify:
  sudo systemctl list-timers --all | grep history-ingestor
EOF
