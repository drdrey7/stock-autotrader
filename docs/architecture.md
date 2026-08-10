# Architecture

```mermaid
flowchart TB
  subgraph Public[Public Cloudflare boundary]
    WEB[React static assets]
    API[Read-only Worker API]
    D1[(Public D1)]
    WEB --> API --> D1
  end
  subgraph Private[Private VPS boundary]
    DATA[Market and event adapters]
    QUANT[Deterministic quant engine]
    AI[Structured AI assessment]
    RISK[Risk and shadow portfolio]
    SCHED[Scheduler]
    DATA --> QUANT --> AI
    QUANT --> RISK
    SCHED --> QUANT
  end
  Private -->|authenticated, allow-listed publish contract| D1
```

The public side has no mutation, broker, MCP, shell, execution or administrative route. The private side owns market providers, TradingView MCP, Firecrawl, OpenAI, research, backtests, scheduling and simulated execution.

The future VPS publisher sends a sanitised snapshot to a dedicated authenticated Cloudflare ingest boundary. That boundary is intentionally not created as a public route in V5.1; it must be configured after inspecting the existing VPS/Cloudflare integration.

