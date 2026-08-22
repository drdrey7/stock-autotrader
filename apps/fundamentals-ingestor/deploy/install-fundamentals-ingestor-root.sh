#!/usr/bin/env bash
# Safe installer for fundamentals-ingestor systemd units.
#
# This script intentionally does NOT manage secrets and does NOT start timers.
# Provision the required EnvironmentFiles first, run this installer, then
# explicitly enable/start timers when you are ready for scheduled work.
set -euo pipefail

APP=${APP:-/home/hermes/projects/stock-autotrader/apps/fundamentals-ingestor}
SYSTEMD_DIR=${SYSTEMD_DIR:-/etc/systemd/system}
CLOUDFLARE_ENV=/etc/stock-autotrader/cloudflare.env

UNITS=(
  fundamentals-ingestor-maintenance.service
  fundamentals-ingestor-maintenance.timer
)
SERVICES=(
  fundamentals-ingestor-maintenance.service
)
TIMERS=(
  fundamentals-ingestor-maintenance.timer
)

command -v systemctl >/dev/null 2>&1 || { echo "ERROR: systemctl not found" >&2; exit 1; }
command -v install >/dev/null 2>&1 || { echo "ERROR: install not found" >&2; exit 1; }
command -v flock >/dev/null 2>&1 || { echo "ERROR: flock not found (install util-linux)" >&2; exit 1; }

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

for unit in "${TIMERS[@]}" "${SERVICES[@]}"; do
  state=$(systemctl show --property=ActiveState --value "$unit" 2>/dev/null || true)
  case "$state" in
    ""|inactive|failed)
      ;;
    *)
      echo "ERROR: $unit is $state; wait until fundamentals-ingestor units are fully stopped before reinstalling" >&2
      exit 1
      ;;
  esac
done

if command -v systemd-analyze >/dev/null 2>&1; then
  systemd-analyze verify "${UNITS[@]/#/$APP/deploy/}" >/dev/null
fi

for unit in "${UNITS[@]}"; do
  install -o root -g root -m 0644 "$APP/deploy/$unit" "$SYSTEMD_DIR/$unit"
done

systemctl daemon-reload

cat <<'EOF'
Fundamentals-ingestor units installed and reloaded.
No secrets were changed and no timer was enabled or started.

When ready, activate explicitly:
  sudo systemctl enable fundamentals-ingestor-maintenance.timer
  sudo systemctl start fundamentals-ingestor-maintenance.timer

Verify:
  sudo systemctl list-timers --all | grep fundamentals-ingestor
EOF
