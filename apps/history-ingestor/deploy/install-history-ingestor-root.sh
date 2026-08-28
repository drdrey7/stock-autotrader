#!/bin/bash
# Root installer for history-ingestor production systemd units.
#
# Production code lives at /opt/stock-autotrader (origin/main only).
# Secrets stay in /etc/stock-autotrader/*.env (never in git).
# Durable state stays in /var/lib/history-ingestor/ (never wiped).
#
# Transactional order:
#   0) validate credentials, paths and staged unit files
#   1) snapshot timer enablement/activity and destination files
#   2) quiesce active timers and verify services remain idle
#   3) install helper + units, then daemon-reload
#   4) restore each timer's prior enablement/activity exactly
# Any failure after quiescing rolls back destination files and timer state.
set -euo pipefail
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH

APP=${APP:-/opt/stock-autotrader/apps/history-ingestor}
SYSTEMD_DIR=${SYSTEMD_DIR:-/etc/systemd/system}
SBIN_DIR=${SBIN_DIR:-/usr/local/sbin}
STATE_DIR=${STATE_DIR:-/var/lib/history-ingestor}
ALPHA_ENV=/etc/stock-autotrader/alpha-vantage.env
CLOUDFLARE_ENV=/etc/stock-autotrader/cloudflare.env
HELPER_SRC="$APP/deploy/history-ingestor-bootstrap-maybe-disable"
HELPER_DST="$SBIN_DIR/history-ingestor-bootstrap-maybe-disable"

UNITS=(
  history-ingestor-bootstrap.service
  history-ingestor-bootstrap.timer
  history-ingestor-bootstrap-maybe-disable.service
  history-ingestor-maintenance.service
  history-ingestor-maintenance.timer
  history-ingestor-reconcile-split.service
  history-ingestor-reconcile-split.timer
  history-ingestor-due-split.service
  history-ingestor-due-split.timer
  history-ingestor-split-recovery.service
  history-ingestor-split-recovery.timer
)
SERVICES=(
  history-ingestor-bootstrap.service
  history-ingestor-bootstrap-maybe-disable.service
  history-ingestor-maintenance.service
  history-ingestor-reconcile-split.service
  history-ingestor-due-split.service
  history-ingestor-split-recovery.service
)
TIMERS=(
  history-ingestor-bootstrap.timer
  history-ingestor-maintenance.timer
  history-ingestor-reconcile-split.timer
  history-ingestor-due-split.timer
  history-ingestor-split-recovery.timer
)

die() { echo "ERROR: $*" >&2; exit 1; }

[[ $(id -u) -eq 0 ]] || die "run as root"
for cmd in systemctl install flock python3 systemd-analyze mktemp cp grep rm sed mkdir cat id runuser; do
  command -v "$cmd" >/dev/null || die "$cmd not found"
done
[[ -d "$APP" ]] || die "missing app dir: $APP"
[[ -r "$ALPHA_ENV" ]] || die "missing/unreadable $ALPHA_ENV"
[[ -r "$CLOUDFLARE_ENV" ]] || die "missing/unreadable $CLOUDFLARE_ENV"
[[ -f "$HELPER_SRC" ]] || die "missing helper: $HELPER_SRC"

for key in ALPHA_VANTAGE_API_KEYS; do
  grep -Eq "^${key}=[^[:space:]].*" "$ALPHA_ENV" || die "$key missing in $ALPHA_ENV"
done
for key in CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_D1_DATABASE_ID; do
  grep -Eq "^${key}=[^[:space:]].*" "$CLOUDFLARE_ENV" || die "$key missing in $CLOUDFLARE_ENV"
done

for unit in "${UNITS[@]}"; do
  [[ -f "$APP/deploy/$unit" ]] || die "missing deploy unit: $APP/deploy/$unit"
  if grep -q '/home/hermes/projects/stock-autotrader' "$APP/deploy/$unit"; then
    die "$unit still references development checkout path"
  fi
done

# Refuse to deploy while any managed oneshot service is running.
for unit in "${SERVICES[@]}"; do
  state=$(systemctl show --property=ActiveState --value "$unit" 2>/dev/null || true)
  case "$state" in
    ""|inactive|failed|dead) ;;
    *) die "$unit is $state; wait for it to finish before reinstalling" ;;
  esac
done

tmpdir=$(mktemp -d)
verify_log="$tmpdir/systemd-verify.log"
backup_dir="$tmpdir/backup"
mkdir -p "$backup_dir"

declare -A timer_enablement=()
declare -A timer_was_active=()
declare -A file_existed=()
timers_snapshotted=0
deployment_started=0

restore_timer_states() {
  local timer desired_enablement desired_active
  for timer in "${TIMERS[@]}"; do
    desired_enablement=${timer_enablement[$timer]:-not-found}
    desired_active=${timer_was_active[$timer]:-0}

    case "$desired_enablement" in
      enabled)
        systemctl enable "$timer"
        ;;
      enabled-runtime)
        systemctl disable "$timer"
        systemctl enable --runtime "$timer"
        ;;
      disabled|not-found|"")
        systemctl disable "$timer"
        ;;
      *)
        echo "ERROR: refusing to restore unsupported enablement '$desired_enablement' for $timer" >&2
        return 1
        ;;
    esac

    if [[ "$desired_active" -eq 1 ]]; then
      systemctl start "$timer"
    else
      systemctl stop "$timer"
    fi
  done
}

backup_destination() {
  local key=$1 destination=$2
  if [[ -e "$destination" || -L "$destination" ]]; then
    cp -a -- "$destination" "$backup_dir/$key"
    file_existed["$key"]=1
  else
    file_existed["$key"]=0
  fi
}

rollback_files() {
  local unit key destination
  key=helper
  destination=$HELPER_DST
  if [[ "${file_existed[$key]:-0}" -eq 1 ]]; then
    cp -a -- "$backup_dir/$key" "$destination"
  else
    rm -f -- "$destination"
  fi

  for unit in "${UNITS[@]}"; do
    key="unit-$unit"
    destination="$SYSTEMD_DIR/$unit"
    if [[ "${file_existed[$key]:-0}" -eq 1 ]]; then
      cp -a -- "$backup_dir/$key" "$destination"
    else
      rm -f -- "$destination"
    fi
  done
  systemctl daemon-reload
}

on_exit() {
  local rc=$?
  trap - EXIT
  if [[ "$rc" -ne 0 ]]; then
    set +e
    echo "ERROR: installation failed; rolling back" >&2
    if [[ "$deployment_started" -eq 1 ]]; then
      rollback_files || echo "ERROR: file rollback incomplete" >&2
    fi
    if [[ "$timers_snapshotted" -eq 1 ]]; then
      restore_timer_states || echo "ERROR: timer-state rollback incomplete" >&2
    fi
  fi
  rm -rf -- "$tmpdir"
  exit "$rc"
}
trap on_exit EXIT

echo "==> 0) validate staged unit files"
for unit in "${UNITS[@]}"; do
  cp "$APP/deploy/$unit" "$tmpdir/$unit"
done
# systemd-analyze verifies ExecStart executability. Point only the staged copy
# of the root helper unit at a private executable inside tmpdir; production
# files are not touched until all validation and timer snapshots succeed.
install -o root -g root -m 0755 "$HELPER_SRC" "$tmpdir/history-ingestor-bootstrap-maybe-disable"
sed -i \
  "s|ExecStart=$HELPER_DST|ExecStart=$tmpdir/history-ingestor-bootstrap-maybe-disable|" \
  "$tmpdir/history-ingestor-bootstrap-maybe-disable.service"
if ! systemd-analyze verify "$tmpdir"/*.service "$tmpdir"/*.timer >"$verify_log" 2>&1; then
  if grep -E "history-ingestor|Failed to prepare|is not executable" "$verify_log" >/dev/null; then
    cat "$verify_log" >&2
    die "systemd-analyze verify failed for history-ingestor units"
  fi
  echo "systemd-analyze reported unrelated warnings (ignored)"
fi

echo "==> 1) snapshot timer + destination state"
for timer in "${TIMERS[@]}"; do
  enablement=$(systemctl is-enabled "$timer" 2>/dev/null || true)
  case "$enablement" in
    enabled|enabled-runtime|disabled|not-found|"") ;;
    masked|masked-runtime) die "$timer is $enablement; refusing to overwrite an intentional mask" ;;
    *) die "$timer has unsupported enablement state '$enablement'; refusing unsafe reinstall" ;;
  esac
  timer_enablement["$timer"]="$enablement"

  if systemctl is-active --quiet "$timer" 2>/dev/null; then
    timer_was_active["$timer"]=1
  else
    timer_was_active["$timer"]=0
  fi
done
timers_snapshotted=1

backup_destination helper "$HELPER_DST"
for unit in "${UNITS[@]}"; do
  backup_destination "unit-$unit" "$SYSTEMD_DIR/$unit"
done

echo "==> 2) quiesce active timers"
for timer in "${TIMERS[@]}"; do
  if [[ "${timer_was_active[$timer]}" -eq 1 ]]; then
    systemctl stop "$timer" || die "failed to stop active $timer"
    if systemctl is-active --quiet "$timer" 2>/dev/null; then
      die "$timer remained active after stop"
    fi
  fi
done

# Close the race where a timer fired between the initial service check and stop.
for unit in "${SERVICES[@]}"; do
  state=$(systemctl show --property=ActiveState --value "$unit" 2>/dev/null || true)
  case "$state" in
    ""|inactive|failed|dead) ;;
    *) die "$unit became $state while quiescing; aborting install" ;;
  esac
done

echo "==> 3) install helper + units"
deployment_started=1
install -d -o hermes -g hermes -m 0755 "$STATE_DIR"
install -o root -g root -m 0755 "$HELPER_SRC" "$HELPER_DST"
[[ -x "$HELPER_DST" ]] || die "helper not executable at $HELPER_DST"
for unit in "${UNITS[@]}"; do
  install -o root -g root -m 0644 "$APP/deploy/$unit" "$SYSTEMD_DIR/$unit"
done

echo "==> 4) daemon-reload"
systemctl daemon-reload

echo "==> 5) restore prior timer enablement + activity"
restore_timer_states

# Verify exact state restoration before committing the deployment.
for timer in "${TIMERS[@]}"; do
  desired_enablement=${timer_enablement[$timer]}
  actual_enablement=$(systemctl is-enabled "$timer" 2>/dev/null || true)
  case "$desired_enablement" in
    not-found|"") desired_enablement=disabled ;;
  esac
  [[ "$actual_enablement" == "$desired_enablement" ]] || \
    die "$timer enablement restore mismatch: wanted=$desired_enablement actual=$actual_enablement"

  if [[ "${timer_was_active[$timer]}" -eq 1 ]]; then
    systemctl is-active --quiet "$timer" || die "$timer should be active after restore"
  else
    if systemctl is-active --quiet "$timer" 2>/dev/null; then
      die "$timer should be inactive after restore"
    fi
  fi
done

echo "==> 6) summary"
for timer in "${TIMERS[@]}"; do
  before_enablement=${timer_enablement[$timer]:-not-found}
  before_active=${timer_was_active[$timer]:-0}
  after_enablement=$(systemctl is-enabled "$timer" 2>/dev/null || true)
  after_active=$(systemctl is-active "$timer" 2>/dev/null || true)
  echo "$timer: before(enablement=$before_enablement active=$before_active) after(enablement=$after_enablement active=$after_active)"
done
systemctl list-timers --all | grep history-ingestor || true
echo
echo "Installed history-ingestor from: $APP"
echo "State dir preserved: $STATE_DIR"
echo "Secrets untouched under /etc/stock-autotrader/"
echo "Helper: $HELPER_DST"
echo "DONE"
