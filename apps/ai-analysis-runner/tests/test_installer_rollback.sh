#!/usr/bin/env bash
# Harness tests for the ai-analysis-runner installer rollback().
#
# Runs the real installer as a subprocess inside a sandbox with mocked
# systemctl/install/python3/systemd-analyze/stat/id/chown so that a natural
# mid-install failure (mock systemd-analyze verify keyed off MOCK_DIR/fail.verify)
# drives rollback() deterministically. Asserts that every previous enabled/active
# state is restored, and that a critical restoration failure is reported as
# ROLLBACK FAILED with a non-zero exit.
set -Eeuo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
INSTALLER="$REPO_ROOT/apps/ai-analysis-runner/deploy/install-ai-analysis-runner-root.sh"
SERVICE="ai-analysis-runner.service"

fails=0
passes=0

make_mocks() {
  local mockdir="$1"
  mkdir -p "$mockdir"

  cat > "$mockdir/id" <<'EOF'
#!/usr/bin/env bash
if [ "$*" = "-u" ]; then printf '0\n'; exit 0; fi
if [ "$*" = "hermes" ]; then exit 0; fi
exit 1
EOF

  cat > "$mockdir/stat" <<'EOF'
#!/usr/bin/env bash
case "$*" in
  *'-c %U'*) printf 'hermes\n' ;;
  *'-c %G'*) printf 'hermes\n' ;;
  *'-c %a'*) printf '600\n' ;;
  *) exit 1 ;;
esac
EOF

  cat > "$mockdir/chown" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF

  cat > "$mockdir/install" <<'EOF'
#!/usr/bin/env bash
# install -d <owners/mode> DIR   |   install <owners/mode> SRC DST
if [ "$1" = "-d" ]; then
  dir=""
  for a in "$@"; do
    case "$a" in -d|-o|-g|-m|root|hermes|[0-9][0-9][0-9][0-9]) ;; *) dir="$a" ;; esac
  done
  mkdir -p "$dir"
  exit 0
fi
src="" dst=""
for a in "$@"; do
  case "$a" in -o|-g|-m|root|hermes|[0-9][0-9][0-9][0-9]) ;; *)
    if [ -z "$src" ]; then src="$a"; elif [ -z "$dst" ]; then dst="$a"; fi ;;
  esac
done
cp "$src" "$dst"
exit 0
EOF

  cat > "$mockdir/python3" <<'EOF'
#!/usr/bin/env bash
if [ "$1" = "-m" ] && [ "$2" = "venv" ]; then
  mkdir -p "$3/bin"
  printf '#!/usr/bin/env bash\nexit 0\n' > "$3/bin/python"
  chmod +x "$3/bin/python"
  exit 0
fi
exit 0
EOF

  cat > "$mockdir/systemd-analyze" <<'EOF'
#!/usr/bin/env bash
if [ -f "$MOCK_DIR/fail.verify" ]; then exit 1; fi
exit 0
EOF

  cat > "$mockdir/systemctl" <<'EOF'
#!/usr/bin/env bash
statefile="$MOCK_DIR/systemctl.state"
logfile="$MOCK_DIR/systemctl.log"
[ -f "$statefile" ] || printf 'enabled=0\nactive=0\n' > "$statefile"
case "${1:-}" in
  is-active)
    if [ "${2:-}" = "--quiet" ]; then
      grep -q '^active=1$' "$statefile"
    else
      grep -q '^active=1$' "$statefile" && printf 'active\n' || printf 'inactive\n'
      grep -q '^active=1$' "$statefile"
    fi
    ;;
  is-enabled)
    if [ "${2:-}" = "--quiet" ]; then
      grep -q '^enabled=1$' "$statefile"
    else
      grep -q '^enabled=1$' "$statefile" && printf 'enabled\n' || printf 'disabled\n'
      grep -q '^enabled=1$' "$statefile"
    fi
    ;;
  start)   if [ -f "$MOCK_DIR/fail.start" ]; then exit 1; fi
           sed -i 's/^active=.*/active=1/' "$statefile"; printf 'start\n' >> "$logfile" ;;
  stop)    sed -i 's/^active=.*/active=0/' "$statefile"; printf 'stop\n' >> "$logfile" ;;
  enable)  sed -i 's/^enabled=.*/enabled=1/' "$statefile"; printf 'enable\n' >> "$logfile" ;;
  disable) sed -i 's/^enabled=.*/enabled=0/' "$statefile"; printf 'disable\n' >> "$logfile" ;;
  daemon-reload) printf 'daemon-reload\n' >> "$logfile" ;;
  *) printf 'unexpected: %s\n' "$*" >> "$logfile" ; exit 0 ;;
esac
EOF

  chmod +x "$mockdir"/*
}

# run_scenario <name> <was_enabled> <was_active> <expect_enabled> <expect_active> [fail_start]
run_scenario() {
  local name="$1" was_enabled="$2" was_active="$3" expect_enabled="$4" expect_active="$5" fail_start="${6:-0}"
  local sandbox mockdir app conf vdir state umarker output rc
  sandbox="$(mktemp -d /tmp/installer-harness.XXXXXX)"
  mockdir="$sandbox/mock"
  app="$sandbox/app"
  conf="$sandbox/conf"
  vdir="$sandbox/venv"
  state="$sandbox/state"
  umarker="$sandbox/unit"
  make_mocks "$mockdir"

  mkdir -p "$app/ai_analysis_runner" "$app/deploy" "$conf" "$vdir/bin" "$state"
  printf '[Unit]\nDescription=mock\n' > "$app/deploy/ai-analysis-runner.service"
  printf 'aiohttp==3.14.3\n' > "$app/requirements-lock.txt"
  printf 'CLOUDFLARE_API_TOKEN=x\nCLOUDFLARE_ACCOUNT_ID=a\nCLOUDFLARE_D1_DATABASE_ID=d\n' > "$conf/cloudflare.env"
  printf 'CLOUDFLARE_QUEUES_API_TOKEN=q\nCLOUDFLARE_AI_QUEUE_ID=qi\nTRADINGAGENTS_LLM_PROVIDER=google\nGOOGLE_API_KEY=g\n' > "$conf/ai-analysis.env"
  printf '#!/usr/bin/env bash\nexit 0\n' > "$vdir/bin/python"
  chmod +x "$vdir/bin/python"
  printf 'previous-venv\n' > "$vdir/.venv-marker"
  mkdir -p "$umarker"
  printf 'PREVIOUS-UNIT\n' > "$umarker/$SERVICE"

  printf 'enabled=%s\nactive=%s\n' "$was_enabled" "$was_active" > "$mockdir/systemctl.state"
  : > "$mockdir/systemctl.log"
  touch "$mockdir/fail.verify"
  [ "$fail_start" = "1" ] && touch "$mockdir/fail.start"

  local ok=1 output rc=""
  set +e
  output="$( env -i \
      PATH="$mockdir:/usr/bin:/bin" \
      HOME="$sandbox" \
      APP="$app" \
      CONF_DIR="$conf" \
      SYSTEMD_DIR="$umarker" \
      VENV_DIR="$vdir" \
      SERVICE="$SERVICE" \
      ENABLE_NOW=0 \
      LOCK_FILE="$sandbox/install.lock" \
      STATE_DIR="$state" \
      MOCK_DIR="$mockdir" \
      bash "$INSTALLER" 2>&1 )"
  rc=$?
  set -e
  rc=${rc:-0}
  if [ "$fail_start" = "1" ]; then
    # Must report ROLLBACK FAILED and exit non-zero.
    if ! grep -q "ROLLBACK FAILED" <<<"$output"; then ok=0; fi
    if [ "$rc" -eq 0 ]; then ok=0; fi
  else
    # Successful rollback: no ROLLBACK FAILED, non-zero original exit (verify failed).
    if grep -q "ROLLBACK FAILED" <<<"$output"; then ok=0; fi
    if [ "$rc" -eq 0 ]; then ok=0; fi
  fi

  # Previous venv restored.
  local marker="" restored_enabled="" restored_active=""
  marker="$(cat "$vdir/.venv-marker" 2>/dev/null || true)"
  [ "$marker" = "previous-venv" ] || ok=0
  # Previous unit restored.
  grep -q "PREVIOUS-UNIT" "$umarker/$SERVICE" 2>/dev/null || ok=0
  # On a successful rollback, the previous enabled/active state must be restored
  # exactly. On the deliberate restoration-failure case the state is intentionally
  # left at the point of failure, so only the ROLLBACK FAILED/exit assertions apply.
  if [ "$fail_start" != "1" ]; then
    restored_enabled="$(sed -n 's/^enabled=//p' "$mockdir/systemctl.state" | tail -n1)"
    restored_active="$(sed -n 's/^active=//p' "$mockdir/systemctl.state" | tail -n1)"
    [ "$restored_enabled" = "$expect_enabled" ] || ok=0
    [ "$restored_active" = "$expect_active" ] || ok=0
  fi

  if [ "$ok" -eq 1 ]; then
    passes=$((passes + 1))
    printf 'PASS %-24s (exit=%s enabled=%s active=%s)\n' "$name" "$rc" "$restored_enabled" "$restored_active"
  else
    fails=$((fails + 1))
    printf 'FAIL %-24s (exit=%s enabled=%s active=%s)\n' "$name" "$rc" "$restored_enabled" "$restored_active"
    printf '%s\n' "--- output ---"
    printf '%s\n' "$output" | tail -n 8
  fi
  rm -rf "$sandbox"
}

[ -f "$INSTALLER" ] || { echo "missing installer: $INSTALLER" >&2; exit 1; }
[ -x "$INSTALLER" ] || { echo "installer not executable" >&2; exit 1; }

run_scenario "enabled+active"        1 1 1 1
run_scenario "enabled+inactive"      1 0 1 0
run_scenario "disabled+active"       0 1 0 1
run_scenario "disabled+inactive"     0 0 0 0
run_scenario "restoration-start-fails" 1 1 1 1 1

echo
echo "installer rollback harness: $passes passed, $fails failed"
if [ "$fails" -gt 0 ]; then exit 1; fi
exit 0