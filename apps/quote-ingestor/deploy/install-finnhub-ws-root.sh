#!/usr/bin/env bash
#
# Root-only installer for the Finnhub WebSocket quote ingestor (stock-autotrader).
#
# Security contract (project rule — never print/version a secret value):
#   - Finnhub API key and Cloudflare D1 credentials arrive ONLY via temporary
#     source files held OUTSIDE the repo, owner hermes, mode 0600
#     (~/.secrets/stock-autotrader/). This script never sees the values on its
#     command line and never echoes them.
#   - The script copies those sources into /etc/stock-autotrader/{finnhub.env,
#     cloudflare.env} with mode 0600, owner hermes (the service user).
#   - Temporary sources are destroyed at the end (shred, fallback rm). The
#     Hermes Vault copy is deliberately NOT touched here.
#   - No service start in this script (operator starts it after verification);
#     only install + daemon-reload + enable.
#
# Idempotent: re-running with /etc env files already present and temp sources
# gone keeps the existing env files.
#
set -euo pipefail

SERVICE="stock-autotrader-finnhub-ws"
REPO_DIR="/home/hermes/projects/stock-autotrader"
UNIT_SRC="${REPO_DIR}/apps/quote-ingestor/deploy/${SERVICE}.service"
UNIT_DST="/etc/systemd/system/${SERVICE}.service"
CONF_DIR="/etc/stock-autotrader"
KEY_TMP="/home/hermes/.secrets/stock-autotrader/finnhub-key.tmp"
CF_TMP="/home/hermes/.secrets/stock-autotrader/cloudflare-credentials.tmp"

die() { echo "ERROR: $*" >&2; exit 1; }

echo "==> Preparing ${CONF_DIR}"
install -d -m 0700 -o root -g root "${CONF_DIR}"

# ---------------------------------------------------------------------------
# /etc/stock-autotrader/finnhub.env  (Finnhub API key only)
# ---------------------------------------------------------------------------
echo "==> Finnhub env file"
if [[ -f "${KEY_TMP}" ]]; then
    [[ -s "${KEY_TMP}" ]] || die "key source ${KEY_TMP} is empty"
    umask 077
    {
        printf '%s\n' "FINNHUB_API_KEY=$(cat "${KEY_TMP}")"
    } > "${CONF_DIR}/finnhub.env"
    chown hermes:hermes "${CONF_DIR}/finnhub.env"
    chmod 600 "${CONF_DIR}/finnhub.env"
    echo "    finnhub.env written from temporary source (mode 600, owner hermes)."
elif [[ -f "${CONF_DIR}/finnhub.env" ]]; then
    echo "    finnhub.env already present — keeping it (re-run / idempotent)."
else
    die "no key source (${KEY_TMP}) and no existing ${CONF_DIR}/finnhub.env"
fi
grep -Eq '^FINNHUB_API_KEY=[^[:space:]]+$' "${CONF_DIR}/finnhub.env" || die "malformed FINNHUB_API_KEY= entry (structural check only, value never printed)"
echo "    finnhub.env size: $(wc -c < "${CONF_DIR}/finnhub.env") bytes (value never printed)."

# ---------------------------------------------------------------------------
# /etc/stock-autotrader/cloudflare.env  (D1 HTTP API credentials)
# ---------------------------------------------------------------------------
echo "==> Cloudflare env file"
if [[ -f "${CF_TMP}" ]]; then
    [[ -s "${CF_TMP}" ]] || die "credentials source ${CF_TMP} is empty"
    umask 077
    cat "${CF_TMP}" > "${CONF_DIR}/cloudflare.env"
    chown hermes:hermes "${CONF_DIR}/cloudflare.env"
    chmod 600 "${CONF_DIR}/cloudflare.env"
    echo "    cloudflare.env written from temporary source (mode 600, owner hermes)."
elif [[ -f "${CONF_DIR}/cloudflare.env" ]]; then
    echo "    cloudflare.env already present — keeping it (re-run / idempotent)."
else
    die "no credentials source (${CF_TMP}) and no existing ${CONF_DIR}/cloudflare.env"
fi
for var in CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_D1_DATABASE_ID; do
    grep -Eq "^${var}=[^[:space:]]+$" "${CONF_DIR}/cloudflare.env" || die "missing ${var}= entry (structural check only)"
done
echo "    cloudflare.env size: $(wc -c < "${CONF_DIR}/cloudflare.env") bytes (value never printed)."

# ---------------------------------------------------------------------------
# Systemd unit + enable (no start)
# ---------------------------------------------------------------------------
echo "==> Systemd unit"
[[ -f "${UNIT_SRC}" ]] || die "unit source missing: ${UNIT_SRC}"
install -m 0644 -o root -g root "${UNIT_SRC}" "${UNIT_DST}"
systemctl daemon-reload
systemctl enable "${SERVICE}"

# ---------------------------------------------------------------------------
# Cleanup temporary secret sources (best effort shred, fallback rm)
# ---------------------------------------------------------------------------
echo "==> Destroying temporary credential sources"
shred -u -f "${KEY_TMP}" "${CF_TMP}" 2>/dev/null || rm -f "${KEY_TMP}" "${CF_TMP}"
[[ ! -e "${KEY_TMP}" && ! -e "${CF_TMP}" ]] || die "temporary credential sources still present"

echo
echo "==> Done."
echo "    Systemd unit installed + enabled: ${SERVICE}"
echo "    Service NOT started (by design — operator starts it after verification)."
echo "    Env variable names present (values never printed):"
grep -hoE '^[A-Z_]+' "${CONF_DIR}/finnhub.env" "${CONF_DIR}/cloudflare.env" | sort -u | sed 's/^/      /'
echo
systemctl is-enabled "${SERVICE}"
