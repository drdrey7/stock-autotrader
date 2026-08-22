#!/usr/bin/env bash
set -euo pipefail

APP=${APP:-/home/hermes/projects/stock-autotrader/apps/fundamentals-ingestor}
SYSTEMD_DIR=${SYSTEMD_DIR:-/etc/systemd/system}
CONF_DIR=${CONF_DIR:-/etc/stock-autotrader}
UNITS=(fundamentals-ingestor.service fundamentals-ingestor.timer)

command -v systemctl >/dev/null
command -v systemd-analyze >/dev/null
command -v install >/dev/null
command -v flock >/dev/null
[ -d "$APP" ] || { echo "ERROR: missing deployed app: $APP" >&2; exit 1; }
[ -r "$CONF_DIR/finnhub.env" ] || { echo "ERROR: missing $CONF_DIR/finnhub.env" >&2; exit 1; }
[ -r "$CONF_DIR/cloudflare.env" ] || { echo "ERROR: missing $CONF_DIR/cloudflare.env" >&2; exit 1; }
[ -r "$CONF_DIR/edgar.env" ] || { echo "ERROR: provision $CONF_DIR/edgar.env from the secure operator configuration" >&2; exit 1; }
grep -Eq '^EDGAR_IDENTITY=[^[:space:]].*' "$CONF_DIR/edgar.env" || { echo "ERROR: EDGAR_IDENTITY is missing" >&2; exit 1; }

for unit in "${UNITS[@]}"; do
  systemd-analyze verify "$APP/deploy/$unit" >/dev/null
  install -o root -g root -m 0644 "$APP/deploy/$unit" "$SYSTEMD_DIR/$unit"
done
systemctl daemon-reload
echo "Fundamentals units installed and verified; timer was not enabled or started."
