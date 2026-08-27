#!/usr/bin/env bash
set -euo pipefail

APP=${APP:-/opt/stock-autotrader/apps/fundamentals-ingestor}
SYSTEMD_DIR=${SYSTEMD_DIR:-/etc/systemd/system}
CONF_DIR=${CONF_DIR:-/etc/stock-autotrader}
VENV_DIR=${VENV_DIR:-/opt/stock-autotrader-fundamentals}
UNITS=(fundamentals-ingestor.service fundamentals-ingestor.timer)

command -v systemctl >/dev/null
command -v systemd-analyze >/dev/null
command -v install >/dev/null
command -v flock >/dev/null
command -v python3 >/dev/null
command -v pip3 >/dev/null
[ -d "$APP" ] || { echo "ERROR: missing deployed app: $APP" >&2; exit 1; }
[ -r "$CONF_DIR/finnhub.env" ] || { echo "ERROR: missing $CONF_DIR/finnhub.env" >&2; exit 1; }
[ -r "$CONF_DIR/cloudflare.env" ] || { echo "ERROR: missing $CONF_DIR/cloudflare.env" >&2; exit 1; }
grep -Eq '^FINNHUB_API_KEY=[^[:space:]].*' "$CONF_DIR/finnhub.env" || { echo "ERROR: FINNHUB_API_KEY is missing" >&2; exit 1; }
grep -Eq '^EXCHANGE_RATE_API_KEY=[^[:space:]].*' "$CONF_DIR/finnhub.env" || { echo "ERROR: EXCHANGE_RATE_API_KEY is missing (required for the keyed ExchangeRate-API Free FX endpoint)" >&2; exit 1; }
for key in CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_D1_DATABASE_ID; do
  grep -Eq "^${key}=[^[:space:]].*" "$CONF_DIR/cloudflare.env" || { echo "ERROR: $key is missing" >&2; exit 1; }
done

if [ ! -x "$VENV_DIR/bin/python" ]; then
  python3 -m venv "$VENV_DIR"
fi
"$VENV_DIR/bin/python" -m pip install --disable-pip-version-check --no-input --requirement "$APP/requirements.txt" >/dev/null
chown -R hermes:hermes "$VENV_DIR"

for unit in "${UNITS[@]}"; do
  systemd-analyze verify "$APP/deploy/$unit" >/dev/null
  install -o root -g root -m 0644 "$APP/deploy/$unit" "$SYSTEMD_DIR/$unit"
done
systemctl daemon-reload
echo "Finnhub fundamentals units installed and verified; timer was not enabled or started."
