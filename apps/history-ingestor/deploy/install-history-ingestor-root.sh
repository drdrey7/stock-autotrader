#!/usr/bin/env bash
# One-shot root installer for the weekly history maintenance (documented in
# README.md — this repo intentionally does NOT auto-run it; root is required).
#
# Idempotent: safe to run repeatedly. Writes:
#   /etc/stock-autotrader/alpha-vantage.env   (0600 hermes:hermes) — secrets
#   /etc/systemd/system/history-ingestor-maintenance.{service,timer}
#   /etc/systemd/system/history-ingestor-due-split.{service,timer}
#
# Usage:
#   sudo ALPHA_VANTAGE_API_KEYS=$KEY1,$KEY2 ./deploy/install-history-ingestor-root.sh
#   (CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_D1_DATABASE_ID
#    are read from the existing /etc/stock-autotrader/cloudflare.env)
set -euo pipefail

APP=/home/hermes/projects/stock-autotrader/apps/history-ingestor
DIR=/etc/stock-autotrader
ENV_FILE="$DIR/alpha-vantage.env"

command -v systemctl >/dev/null 2>&1 || { echo "systemctl not found" >&2; exit 1; }
service_file="$APP/deploy/history-ingestor-maintenance.service"
timer_file="$APP/deploy/history-ingestor-maintenance.timer"
due_split_service="$APP/deploy/history-ingestor-due-split.service"
due_split_timer="$APP/deploy/history-ingestor-due-split.timer"
[ -f "$service_file" ] && [ -f "$timer_file" ] || { echo "deploy files missing: $APP" >&2; exit 1; }
[ -f "$due_split_service" ] && [ -f "$due_split_timer" ] || { echo "due-split deploy files missing: $APP" >&2; exit 1; }

if [ -n "${ALPHA_VANTAGE_API_KEYS:-}" ]; then
  mkdir -p "$DIR"
  : > "$ENV_FILE"
  umask 077
  printf 'ALPHA_VANTAGE_API_KEYS=%s\n' "$ALPHA_VANTAGE_API_KEYS" > "$ENV_FILE"
  # Reuse the D1 credentials the quote-ingestor already trusts.
  if [ -f "$DIR/cloudflare.env" ]; then
    grep -E '^(CLOUDFLARE_API_TOKEN|CLOUDFLARE_ACCOUNT_ID|CLOUDFLARE_D1_DATABASE_ID)=' "$DIR/cloudflare.env" >> "$ENV_FILE"
  else
    echo "cloudflare.env missing: append CLOUDFLARE_* vars to $ENV_FILE manually" >&2
  fi
  chown hermes:hermes "$ENV_FILE"
  chmod 600 "$ENV_FILE"
else
  echo "ALPHA_VANTAGE_API_KEYS not provided — leaving $ENV_FILE untouched" >&2
fi

install -o root -g root -m 0644 "$service_file" /etc/systemd/system/
install -o root -g root -m 0644 "$timer_file" /etc/systemd/system/
install -o root -g root -m 0644 "$due_split_service" /etc/systemd/system/
install -o root -g root -m 0644 "$due_split_timer" /etc/systemd/system/
systemctl daemon-reload
systemctl enable history-ingestor-maintenance.timer
systemctl enable history-ingestor-due-split.timer

echo "Installed. Status:"
systemctl list-timers history-ingestor-maintenance.timer --no-pager | head -3
systemctl list-timers history-ingestor-due-split.timer --no-pager | head -3
echo
echo "Run a manual pass now:  sudo systemctl start history-ingestor-maintenance"
echo "Run due-split now:       sudo systemctl start history-ingestor-due-split"
