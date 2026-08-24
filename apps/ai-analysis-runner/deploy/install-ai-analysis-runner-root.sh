#!/usr/bin/env bash
set -Eeuo pipefail

APP=${APP:-/opt/stock-autotrader/apps/ai-analysis-runner}
CONF_DIR=${CONF_DIR:-/etc/stock-autotrader}
SYSTEMD_DIR=${SYSTEMD_DIR:-/etc/systemd/system}
VENV_DIR=${VENV_DIR:-/opt/stock-autotrader-ai-analysis}
SERVICE=${SERVICE:-ai-analysis-runner.service}
ENABLE_NOW=${ENABLE_NOW:-0}
LOCK_FILE=${LOCK_FILE:-/run/lock/stock-autotrader-ai-analysis-install.lock}
STATE_DIR=${STATE_DIR:-/var/lib/ai-analysis-runner}
UNIT_SOURCE="$APP/deploy/ai-analysis-runner.service"
UNIT_TARGET="$SYSTEMD_DIR/$SERVICE"

[ "$(id -u)" -eq 0 ] || { echo "ERROR: run as root" >&2; exit 1; }
for command in flock git install python3 stat systemctl systemd-analyze; do
  command -v "$command" >/dev/null || { echo "ERROR: missing command: $command" >&2; exit 1; }
done
id hermes >/dev/null 2>&1 || { echo "ERROR: service user hermes does not exist" >&2; exit 1; }
[ -d "$APP/ai_analysis_runner" ] || { echo "ERROR: missing deployed runner: $APP" >&2; exit 1; }
[ -r "$APP/requirements-lock.txt" ] || { echo "ERROR: missing dependency lock" >&2; exit 1; }
[ -r "$UNIT_SOURCE" ] || { echo "ERROR: missing systemd unit" >&2; exit 1; }

install -d -o root -g hermes -m 0710 "$CONF_DIR"
install -d -o root -g root -m 0755 "$SYSTEMD_DIR"
install -d -o hermes -g hermes -m 0700 "$STATE_DIR"
exec 9>"$LOCK_FILE"
flock -n 9 || { echo "ERROR: another runner installation is active" >&2; exit 1; }

check_env_file() {
  local file=$1
  [ -r "$file" ] || { echo "ERROR: missing $file" >&2; exit 1; }
  local owner group mode
  owner=$(stat -c %U "$file")
  group=$(stat -c %G "$file")
  mode=$(stat -c %a "$file")
  if [ "$owner" != "hermes" ] || [ "$group" != "hermes" ]; then
    echo "ERROR: $file must be owned by hermes:hermes (got $owner:$group)" >&2; exit 1
  fi
  (( (8#$mode & 0077) == 0 )) || { echo "ERROR: $file must not be group/world accessible (got $mode)" >&2; exit 1; }
}

require_env_key() {
  local file=$1 key=$2
  grep -Eq "^${key}=[^[:space:]].*" "$file" || { echo "ERROR: $key is missing from $file" >&2; exit 1; }
}

check_env_file "$CONF_DIR/cloudflare.env"
check_env_file "$CONF_DIR/ai-analysis.env"
for key in CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_D1_DATABASE_ID; do
  require_env_key "$CONF_DIR/cloudflare.env" "$key"
done
for key in CLOUDFLARE_QUEUES_API_TOKEN CLOUDFLARE_AI_QUEUE_ID TRADINGAGENTS_LLM_PROVIDER; do
  require_env_key "$CONF_DIR/ai-analysis.env" "$key"
done
provider=$(sed -n 's/^TRADINGAGENTS_LLM_PROVIDER=//p' "$CONF_DIR/ai-analysis.env" | tail -n 1)
case "$provider" in
  google) require_env_key "$CONF_DIR/ai-analysis.env" GOOGLE_API_KEY ;;
  openai) require_env_key "$CONF_DIR/ai-analysis.env" OPENAI_API_KEY ;;
  openai_compatible)
    require_env_key "$CONF_DIR/ai-analysis.env" OPENAI_COMPATIBLE_API_KEY
    require_env_key "$CONF_DIR/ai-analysis.env" TRADINGAGENTS_LLM_BACKEND_URL
    ;;
  *) echo "ERROR: unsupported TRADINGAGENTS_LLM_PROVIDER" >&2; exit 1 ;;
esac

new_venv=$(mktemp -d "${VENV_DIR}.new.XXXXXX")
rollback_venv=""
failed_venv=""
unit_backup=$(mktemp "${SYSTEMD_DIR}/.${SERVICE}.backup.XXXXXX")
swapped=0
had_unit=0
was_active=0
was_enabled=0
[ -e "$UNIT_TARGET" ] && { cp -a "$UNIT_TARGET" "$unit_backup"; had_unit=1; }
systemctl is-active --quiet "$SERVICE" && was_active=1 || true
systemctl is-enabled --quiet "$SERVICE" && was_enabled=1 || true

rollback() {
  local exit_code=$?
  trap - ERR INT TERM
  # Do NOT disable errexit. Every restoration step is checked explicitly; if a
  # critical step fails the rollback reports ROLLBACK FAILED and exits non-zero.
  local failed=0
  if [ "$swapped" -eq 1 ]; then
    failed_venv="${VENV_DIR}.failed.$$"
    if [ -e "$VENV_DIR" ]; then
      if mv "$VENV_DIR" "$failed_venv"; then :; else
        echo "ROLLBACK FAILED: could not move current environment aside" >&2; failed=1
      fi
    fi
    if [ -n "$rollback_venv" ] && [ -e "$rollback_venv" ]; then
      if mv "$rollback_venv" "$VENV_DIR"; then :; else
        echo "ROLLBACK FAILED: could not restore previous environment" >&2; failed=1
      fi
    fi
  fi
  # Restore or remove the previous unit.
  if [ "$had_unit" -eq 1 ]; then
    if install -o root -g root -m 0644 "$unit_backup" "$UNIT_TARGET"; then :; else
      echo "ROLLBACK FAILED: could not restore previous unit" >&2; failed=1
    fi
  else
    if rm -f "$UNIT_TARGET"; then :; else
      echo "ROLLBACK FAILED: could not remove installed unit" >&2; failed=1
    fi
  fi
  if systemctl daemon-reload; then :; else
    echo "ROLLBACK FAILED: daemon-reload failed" >&2; failed=1
  fi
  # Restore ENABLED state explicitly (both directions).
  if [ "$was_enabled" -eq 1 ]; then
    if systemctl enable "$SERVICE" >/dev/null 2>&1; then :; else
      echo "ROLLBACK FAILED: could not re-enable $SERVICE" >&2; failed=1
    fi
  elif [ "$had_unit" -eq 1 ]; then
    if systemctl disable "$SERVICE" >/dev/null 2>&1; then :; else
      echo "ROLLBACK FAILED: could not disable $SERVICE" >&2; failed=1
    fi
  fi
  # Restore ACTIVE state independently, only after unit and enable state are set.
  if [ "$was_active" -eq 1 ]; then
    if systemctl start "$SERVICE" >/dev/null 2>&1; then :; else
      echo "ROLLBACK FAILED: could not start $SERVICE" >&2; failed=1
    fi
  elif systemctl is-active --quiet "$SERVICE" 2>/dev/null; then
    if systemctl stop "$SERVICE" >/dev/null 2>&1; then :; else
      echo "ROLLBACK FAILED: could not stop $SERVICE" >&2; failed=1
    fi
  fi
  if [ "$failed" -eq 1 ]; then
    echo "ROLLBACK FAILED: one or more restoration steps failed" >&2
    exit 1
  fi
  echo "ERROR: installation rolled back; failed environment retained at ${failed_venv:-$new_venv}" >&2
  exit "$exit_code"
}
trap rollback ERR INT TERM

python3 -m venv "$new_venv"
chmod 0755 "$new_venv"
"$new_venv/bin/python" -m pip install --disable-pip-version-check --no-input --requirement "$APP/requirements-lock.txt" >/dev/null
"$new_venv/bin/python" -m pip check
"$new_venv/bin/python" -c 'from importlib.metadata import version; assert version("tradingagents") == "0.3.1"'
chown -R hermes:hermes "$new_venv"

[ "$was_active" -eq 1 ] && systemctl stop "$SERVICE"
if [ -e "$VENV_DIR" ]; then
  rollback_venv="${VENV_DIR}.rollback.$$"
  mv "$VENV_DIR" "$rollback_venv"
fi
# Once the prior environment has been moved aside, mark the swap so rollback
# restores it even if the subsequent move of the new environment fails.
swapped=1
mv "$new_venv" "$VENV_DIR"
systemd-analyze verify "$UNIT_SOURCE" >/dev/null
install -o root -g root -m 0644 "$UNIT_SOURCE" "$UNIT_TARGET"
systemctl daemon-reload

if [ "$ENABLE_NOW" = 1 ]; then
  systemctl enable --now "$SERVICE"
else
  [ "$was_enabled" -eq 1 ] && systemctl enable "$SERVICE" >/dev/null
  [ "$was_active" -eq 1 ] && systemctl start "$SERVICE"
fi

trap - ERR INT TERM
rm -f "$unit_backup"
if [ -n "$rollback_venv" ]; then
  case "$rollback_venv" in
    "${VENV_DIR}.rollback."*) rm -rf --one-file-system "$rollback_venv" ;;
    *) echo "ERROR: refusing to remove unexpected rollback path" >&2; exit 1 ;;
  esac
fi
echo "AI analysis runner installed transactionally; existing enable/active state was preserved."
