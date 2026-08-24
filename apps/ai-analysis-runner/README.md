# AI analysis runner

This app is the single-threaded, continuous HTTP pull consumer for paid AI stock analyses. It lazily runs the official [TradingAgents v0.3.1 release commit](https://github.com/TauricResearch/TradingAgents/tree/01477f9afb7a47b849ed4c9259d3a9a4738d9fda), normalizes only stable workflow outputs into the application-owned result V1 schema, and persists them through Cloudflare D1's REST API.

It does not run TradingAgents' CLI, accept arbitrary tickers/prompts, expose LangGraph state, or make a paid model call during tests.

## Runtime flow

1. Pull one Queue message with a five-minute visibility lease. Longer engine
   runs remain single-execution because the D1 heartbeat/CAS lease is the
   authority; an expired Queue delivery can only be retried or terminally
   acknowledged by another consumer.
2. Decode the strict text JSON job `{ "schemaVersion": 1, "analysisId": "<uuid>" }`. JSON/bytes pull bodies are accepted only after strict RFC 4648 base64 decoding; V8 bodies are rejected.
3. Atomically claim `queued` (or stale `running`) D1 state with a random execution token and Queue message ID.
4. Heartbeat that compare-and-swap lease while TradingAgents runs.
5. Save the normalized result locally and atomically before the D1 completion CAS.
6. Mark D1 `completed`, re-read terminal state, and only then acknowledge the Queue lease.

Retryable failures first CAS the row back to `queued`, then request a delayed Queue retry. The last or definitive failure CASes to `failed`; the backend-owned D1 trigger performs the exactly-once credit refund. The runner never edits credits. Ambiguous writes are re-read, short-retried, and recovered from the local normalized checkpoint without another model call. Every valid lease is explicitly settled: immutable poison is acknowledged, unexpected processing failures are retried, and terminal rows are acknowledged.

All TradingAgents state is isolated below `jobs/<analysis-id>/<provider>/` (cache, LangGraph checkpoints, reports, and memory). Google-to-OpenAI fallback uses a different subtree. The service processes one analysis at a time.

## Engine and normalized stages

The graph uses the pinned programmatic API:

```python
TradingAgentsGraph(
    selected_analysts=("market", "social", "news", "fundamentals"),
    config=config,
).propagate(symbol, analysis_date, asset_type="stock")
```

The result stores market/technical, sentiment, news, fundamentals, bull and bear debate histories, research manager decision, trader plan, aggressive/neutral/conservative risk histories, and the portfolio manager's complete decision. `executiveSummary`, `investmentThesis`, `priceTarget`, and `timeHorizon` are extracted only from exact v0.3.1 Portfolio Manager bold headers; absent or malformed optional sections remain `null`.

The D1 engine version is exactly `v0.3.1+01477f9afb7a47b849ed4c9259d3a9a4738d9fda`; the result records version and full commit separately.

## Providers

The primary provider is configurable as `google` (default), `openai`, or
`openai_compatible`. OpenCode Go uses the OpenAI-compatible endpoint
`https://opencode.ai/zen/go/v1`. Current defaults are:

| Provider | Quick model | Deep model |
| --- | --- | --- |
| Google | `gemini-3.1-flash-lite` | `gemini-3.5-flash` |
| OpenAI | `gpt-5.4-mini` | `gpt-5.5` |
| OpenCode Go | `deepseek-v4-flash` | `deepseek-v4-flash` |

The OpenAI fallback is disabled by default, valid only with a Google primary, and attempted at most once after a retryable Google failure. This bounds both cost and provider switching. TradingAgents' own per-request SDK retry budget is separately bounded by `TRADINGAGENTS_LLM_MAX_RETRIES`.

## Local verification

Unit tests use only fake Queue/D1/model clients:

```bash
cd apps/ai-analysis-runner
PYTHONPATH=. python3 -m unittest discover -s tests -v
cd ../..
ruff check apps/ai-analysis-runner
```

For dependency validation in a disposable virtual environment:

```bash
python3 -m venv /tmp/ai-analysis-runner-check
/tmp/ai-analysis-runner-check/bin/pip install -r apps/ai-analysis-runner/requirements-lock.txt
/tmp/ai-analysis-runner-check/bin/pip check
PYTHONPATH=apps/ai-analysis-runner /tmp/ai-analysis-runner-check/bin/python -c \
  'import ai_analysis_runner; from tradingagents.graph.trading_graph import TradingAgentsGraph; print(ai_analysis_runner.ENGINE_COMMIT, TradingAgentsGraph.__name__)'
```

See [deploy/DEPLOY.md](deploy/DEPLOY.md) for Queue and VPS setup.

## Primary references

- [TradingAgents v0.3.1 immutable source](https://github.com/TauricResearch/TradingAgents/tree/01477f9afb7a47b849ed4c9259d3a9a4738d9fda)
- [Cloudflare Queues HTTP pull consumers](https://developers.cloudflare.com/queues/configuration/pull-consumers/)
- [Cloudflare Queues pull API](https://developers.cloudflare.com/api/resources/queues/subresources/messages/methods/pull/)
- [Cloudflare D1 REST query API](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/)
