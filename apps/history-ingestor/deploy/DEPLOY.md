# History-ingestor production deploy

## Production layout

| Item | Path |
|---|---|
| Code (origin/main only) | `/opt/stock-autotrader` |
| App package | `/opt/stock-autotrader/apps/history-ingestor` |
| Secrets | `/etc/stock-autotrader/alpha-vantage.env`, `cloudflare.env` |
| Durable state | `/var/lib/history-ingestor/` |
| Bootstrap auto-disable helper | `/usr/local/sbin/history-ingestor-bootstrap-maybe-disable` |

Development checkouts under `/home/hermes/projects/...` must **never** be
`WorkingDirectory` for systemd.

## Update procedure (deterministic)

```bash
# 1) Fetch + fast-forward production checkout to a known main SHA
cd /opt/stock-autotrader
git fetch origin
git checkout main
git pull --ff-only origin main
git rev-parse HEAD            # record SHA
git rev-parse origin/main     # must match

# 2) Validate without provider / D1 writes
cd apps/history-ingestor
python3 -m py_compile history_ingestor/*.py
python3 -m unittest discover -s tests -q
RUFF_CACHE_DIR=/tmp/ruff-hi ruff check history_ingestor tests

# 3) Install/refresh systemd transactionally from a clean privileged environment
sudo /usr/bin/env -i \
  PATH=/usr/sbin:/usr/bin:/sbin:/bin \
  APP=/opt/stock-autotrader/apps/history-ingestor \
  /bin/bash --noprofile --norc \
  /opt/stock-autotrader/apps/history-ingestor/deploy/install-history-ingestor-root.sh

# 4) Verify
systemctl list-timers --all | grep history-ingestor
systemctl cat history-ingestor-bootstrap.service | grep WorkingDirectory
# must show /opt/stock-autotrader/...
```

### Installer safety contract

The installer snapshots **both** enablement and activity for each history-ingestor
timer, backs up the currently installed helper/unit files, then quiesces only
timers that were active. Active timers must stop successfully; a stop failure
aborts the deployment.

After installing the helper and nine systemd unit files, it runs
`daemon-reload` and restores each timer's exact prior state:

- previously enabled + active → enabled + active again;
- previously enabled + inactive → enabled + inactive;
- previously disabled → remains disabled;
- fresh/not-found timer → installed but remains disabled + inactive;
- masked timer → installer fails closed instead of silently unmasking it.

If anything fails after quiescing (install, `daemon-reload`, enable/start, or
state verification), an EXIT rollback restores the previous helper/unit files,
runs `daemon-reload`, and best-effort restores the saved timer states. The
systemd verification log is created inside the installer's private `mktemp -d`
directory; no predictable `/tmp` file is used.

For a **fresh installation**, activate the desired timers explicitly after
reviewing their schedules. Routine upgrades preserve the existing operational
state.

## Bootstrap auto-disable

The bootstrap service contains no privileged `ExecStartPost`. On a successful
bootstrap exit, systemd `OnSuccess=` triggers
`history-ingestor-bootstrap-maybe-disable.service`, a separate root-only unit
with **no `EnvironmentFile` directives**.

The root helper then:

1. drops to `hermes` before sourcing the existing env files and running the
   read-only `history_ingestor status` command;
2. parses status output as JSON with `/usr/bin/python3 -I` (isolated mode);
3. when status reports `bootstrap_done=50`, `bootstrap_pending=0`, and
   `universe_total=50`, runs the idempotent
   `systemctl disable --now history-ingestor-bootstrap.timer`.

This keeps provider/D1 secrets and repository-controlled Python out of the root
execution boundary. The helper never touches maintenance or due-split and never
makes Alpha Vantage provider calls.

## Manual provider calls

Do **not** run `python3 -m history_ingestor bootstrap` manually just to test —
it consumes Alpha Vantage quota. Use `status` (read-only) and the daily timer.
