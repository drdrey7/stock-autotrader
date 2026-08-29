# AI analysis runner deployment

The runner lives at `/opt/stock-autotrader/apps/ai-analysis-runner`, uses the `hermes:hermes` virtual environment `/opt/stock-autotrader-ai-analysis`, and runs as the unprivileged `hermes` user. Persistent state is systemd-managed at `/var/lib/ai-analysis-runner` with mode `0700`.

## 1. Configure the HTTP pull consumer

Create the primary and dead-letter queues if they do not already exist, then attach the HTTP pull consumer. Wrangler 4.125.0 uses this exact command shape:

```bash
npx --yes wrangler@4.125.0 queues create stock-autotrader-ai-analysis
npx --yes wrangler@4.125.0 queues create stock-autotrader-ai-analysis-dlq
npx --yes wrangler@4.125.0 queues consumer http add stock-autotrader-ai-analysis \
  --batch-size 1 \
  --message-retries 3 \
  --dead-letter-queue stock-autotrader-ai-analysis-dlq \
  --visibility-timeout-secs 3600 \
  --retry-delay-secs 60
npx --yes wrangler@4.125.0 queues list
```

HTTP pull consumers are configured with `queues consumer http add`; do not add a fictitious `type = "http_pull"` to Wrangler configuration. Put the Queue's immutable ID, not its display name, in `CLOUDFLARE_AI_QUEUE_ID`.

The Worker producer must send the envelope as text so the pull API returns plain UTF-8 JSON:

```ts
await env.AI_ANALYSIS_QUEUE.send(
  JSON.stringify({ schemaVersion: 1, analysisId }),
  { contentType: "text" },
);
```

Cloudflare's pull API base64-encodes `json` and `bytes` bodies and does not support V8 bodies. Delivery is at least once. An acknowledgement can arrive after visibility expires, so D1's execution token/message ID CAS—not the Queue lease—is the idempotency authority.

## 2. Install secrets

`/etc/stock-autotrader/` must be `root:hermes 0710` (hermes may traverse to its env files but cannot list the directory contents):

```bash
sudo install -d -o root -g hermes -m 0710 /etc/stock-autotrader
```

`/etc/stock-autotrader/cloudflare.env` must already contain a least-privilege D1 token plus account/database IDs:

```dotenv
CLOUDFLARE_API_TOKEN=replace-with-d1-edit-token
CLOUDFLARE_ACCOUNT_ID=replace-with-account-id
CLOUDFLARE_D1_DATABASE_ID=replace-with-database-id
```

Copy `ai-analysis.env.example` to `/etc/stock-autotrader/ai-analysis.env` and fill its Queue/provider values. Use a separate least-privilege Queues token. Both env files must be `hermes:hermes 0600` so the service user can read them (the systemd unit runs as `hermes`), and the installer intentionally rejects group/world-readable files and wrong ownership:

```bash
sudo install -o hermes -g hermes -m 0600 \
  apps/ai-analysis-runner/deploy/ai-analysis.env.example \
  /etc/stock-autotrader/ai-analysis.env
sudo chown hermes:hermes /etc/stock-autotrader/cloudflare.env
sudo chmod 0600 /etc/stock-autotrader/cloudflare.env /etc/stock-autotrader/ai-analysis.env
sudoedit /etc/stock-autotrader/ai-analysis.env
```

Never put keys in the unit, repository, shell command line, or journal. `FRED_API_KEY` is optional but enables the pinned engine's FRED macro-data tool.

For the Issue #109 production configuration, set
`TRADINGAGENTS_LLM_PROVIDER=openrouter`, provide `OPENROUTER_API_KEY`, and
use `openai/gpt-5.4-mini` / `openai/gpt-5.5` for the quick/deep models. Do not
leave the previous `openai_compatible` OpenCode Go settings active; the
runner rejects that endpoint. Existing unrelated OpenCode credentials do not
need to be removed.

## 3. Install transactionally

After deploying the repository to `/opt/stock-autotrader`, run:

```bash
sudo /opt/stock-autotrader/apps/ai-analysis-runner/deploy/install-ai-analysis-runner-root.sh
sudo systemctl enable --now ai-analysis-runner.service
```

The installer builds a fresh environment from the complete lock, runs `pip check`, checks installed TradingAgents metadata is `0.3.1`, verifies the unit, atomically swaps the venv/unit, and restores the previous active/enabled state. An error rolls both back and retains the failed environment for inspection. For a first install that should start immediately, use `sudo ENABLE_NOW=1 .../install-ai-analysis-runner-root.sh`.

## 4. Verify safely

```bash
sudo systemd-analyze verify /etc/systemd/system/ai-analysis-runner.service
sudo systemctl status ai-analysis-runner.service
sudo journalctl -u ai-analysis-runner.service --since=-10m --no-pager
sudo -u hermes test -w /var/lib/ai-analysis-runner
```

Expected logs are one-line JSON events containing analysis/message identifiers, state, attempts, timing, and safe error codes. API keys, authorization headers, Queue lease IDs, raw provider errors, prompts, and report bodies are never logged.

## 5. Rollout and recovery

Start with one service instance. The D1 CAS permits multiple instances later, but a single process keeps cost and upstream rate pressure bounded. Monitor `analysis_requeued`, `analysis_failed`, `analysis_heartbeat_failed`, and dead-letter depth.

On SIGTERM the runner stops pulling new work, continues the in-flight graph, completes its terminal D1 CAS/ack when possible, then exits. The service allows 65 minutes for that drain. If killed, the Queue visibility lease eventually redelivers; after the D1 heartbeat is stale, the next execution reclaims it and uses any validated local normalized-result checkpoint before considering another model call.

Do not manually change credits during recovery. A definitive `running -> failed` transition invokes the backend-owned D1 refund trigger. Manual reconciliation should inspect the analysis row, credit ledger, and Queue/DLQ together.
