# Prompt for the Codex running on the VPS

Copy everything below into the future VPS Codex session.

---

Work on the existing VPS to install and connect `https://github.com/drdrey7/stock-autotrader`, but inspect before changing anything.

Goal: safely connect Stock Autotrader V5.1 to the VPS's existing Cloudflare and MCP infrastructure, configure private providers/secrets, install permanent engine services, apply the confirmed D1 migrations, schedule scans and validate end-to-end. Do not implement IBKR or real trading.

Mandatory rules:

1. Read `README.md`, `docs/architecture.md`, `docs/security.md`, `docs/research_contract.md` and `docs/VPS_HANDOFF.md` fully before acting.
2. Start with only the read-only inspection commands in `docs/VPS_HANDOFF.md`. Report the existing OS, Docker/Compose, Git/Python/Node, listening ports, running containers/services, reverse proxy, Cloudflare/Tunnel integration, MCPs, scheduler and secret-storage convention. Do not print secret values.
3. Do not assume the VPS is empty. Preserve and reuse existing configuration when safe. Do not stop, overwrite, delete or reconfigure unrelated services. Do not use force push, `git reset --hard`, broad recursive deletion or destructive database commands.
4. Clone to a dedicated path only if no checkout exists. If it exists, inspect status/remotes/diff before fetch/pull. Never put a GitHub token in a URL or command history.
5. Create a local `.env` from `.env.example`, permission `600`, and verify Git ignores it. Store secrets in the existing VPS secret manager when available. Never commit, echo or log secrets.
6. Inspect the existing Cloudflare account/integration first. Reuse a suitable dedicated D1/Tunnel/service binding only when confirmed. Never invent account/database IDs. Use Wrangler secrets for Cloudflare secrets. Keep the public frontend/API read-only.
7. Implement provider adapters behind the existing contracts for market data, earnings, TradingView MCP, Firecrawl and OpenAI. AI receives only candidates already filtered by the quant engine and may not size positions or override hard risk. Store structured public rationale/sources only, never chain-of-thought.
8. Run local tests, lint, typecheck, build, D1 local migration and Docker config/build before deployment. Fix failures without weakening checks.
9. Configure permanent components using the VPS's established service pattern: internal engine health API, isolated scan worker, non-overlapping scheduler and authenticated public-data publisher. Do not expose MCPs, engine API, filesystem or private ports publicly.
10. Configure approximate jobs only after market-calendar and timezone validation: pre-market 08:30 America/New_York weekdays, post-close 16:15 America/New_York weekdays, health smoke every 15 minutes. Add idempotency/locking and US holiday handling.
11. Apply remote migrations only to the confirmed D1 database after listing pending migrations and recording rollback state. Dry-run Worker/web deployments and confirm routes/domains before actual deployment.
12. Validate in stages: fixtures; provider scan with publish disabled; authenticated Cloudflare ingest; public API; frontend; complete tagged scan. Verify stale indicators, CORS, security headers and that no mutation/broker/admin/shell route exists.
13. Record current Git SHA, image versions, Cloudflare deployment version and migration state before changes. Prepare a non-destructive rollback. Do not delete volumes or blindly reverse migrations.
14. Commit only repository code that is generally safe and contains no local IDs, hostnames, internal IPs or secrets. Put machine-specific config outside Git or in clearly ignored files.

At the end report:

- what existed before;
- files/code changed;
- services installed and their private/public exposure;
- providers/MCPs connected;
- schedules enabled;
- migrations and Cloudflare deployments applied;
- exact smoke/end-to-end test results;
- secrets still missing (names only);
- limitations and next safe action;
- rollback procedure and known-good versions.

Do not claim completion if any test is red or if the full scan has not been proven. Explain the exact blocker instead.

---

