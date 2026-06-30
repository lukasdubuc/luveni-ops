# Luveni Ops — autonomous operations fleet

Astra (the owner's voice business manager) + a cooperative fleet of worker
agents that run Luveni's streetwear e-commerce hands-off. The fleet shares one
**Supabase communication bus** with the [`luveni2.0`](../luveni2.0) storefront,
so agents read live inventory/orders and coordinate through durable tables.

## Architecture

```
                       ┌─────────────────────────────────────────┐
   owner (voice) ◄────►│  Astra  (LiveKit/WebRTC voice + LLM)     │
                       │  business manager — delegates, reports   │
                       └───────────────┬─────────────────────────┘
                                       │ enqueue / message
                 ┌─────────────────────▼──────────────────────┐
                 │      Shared Supabase bus (sql/agent_bus)    │
                 │  agent_tasks · agent_messages · agent_runs  │
                 │  budget_envelopes · budget_ledger           │
                 └───┬───┬───┬───┬───┬───┬───┬───┬───┬───┬─────┘
                     │   │   │   │   │   │   │   │   │   │
   Finley  Gideon  Vance Sloane Cora Quinn Orion Piper Dexter Zara Atlas
   (CFO)  (design) (video)(social)(cust)(SEO)(price)(ads) (QA) (trend)(logi)
```

- **Bus** (`src/bus.ts`): atomic `claimNextTask` (compare-and-set, so multiple
  orchestrator processes never double-run a task), `enqueueTask`, `postMessage`,
  `logRun`. Tasks support priority + `depends_on` chaining.
- **Brain** (`src/llm.ts`): one `chat()` with tool-calling, provider-agnostic —
  Anthropic (default, `claude-sonnet-5`) or Gemini free tier.
- **Tools** (`src/tools.ts`): real Supabase-backed tools (inventory, store
  performance, margin reconciliation, channel publish, delegation, messaging),
  granted least-privilege per agent.
- **Agents** (`src/agents.ts`): 12 profiles, each with id, role, tool grants,
  the task kinds it `handles`, and a system prompt.
- **Loop** (`src/agent.ts`): bounded tool-use loop per task; logs tokens + tool
  calls to `agent_runs`.
- **Orchestrator** (`src/orchestrator.ts`): runs N agents per process; scale by
  splitting `FLEET_AGENTS` across processes.

## Quick start

```bash
cp .env.example .env        # fill SUPABASE_* + ANTHROPIC_API_KEY (or GEMINI)
# 1. Deploy the bus schema to the SAME Supabase project as luveni2.0:
psql "$SUPABASE_DB_URL" -f sql/agent_bus.sql
npm install
npm run start               # boot the whole fleet
# enqueue a job:
npm run agent -- finley reconcile_order_margin '{"orderId":"<uuid>"}'
```

## Astra voice

`npm run astra:server` starts a token server (`GET /astra/token?room=astra`)
that mints short-lived LiveKit JWTs so the browser joins a WebRTC room.
A server-side voice worker joins the same room running the STT → LLM (Astra's
profile from `agents.ts`, identical tools/prompt as the text fleet) → TTS
pipeline. LiveKit credentials stay server-side. Swap LiveKit for any WebRTC
provider by replacing `src/astra/server.ts`'s token mint.

## The fleet

| Agent | Role | Key task kinds |
|---|---|---|
| **Astra** | Business manager / voice | `assistant_request`, `daily_briefing`, `route` |
| **Finley** | CFO — margins, tax, envelopes | `reconcile_order_margin`, `weekly_finance` |
| **Gideon** | Lead designer — AI imagery, BG strip | `generate_design`, `strip_background` |
| **Vance** | Video — vertical marketing clips | `make_video`, `render_promo` |
| **Sloane** | Social posting / scheduling | `schedule_post`, `social_publish` |
| **Cora** | Customer tracking & support | `track_customer`, `order_status` |
| **Quinn** | SEO copywriting | `seo_copy`, `write_description` |
| **Orion** | Dynamic price monitoring | `monitor_prices`, `reprice` |
| **Piper** | Ad spend analytics | `ad_report`, `analyze_spend` |
| **Dexter** | System testing / QA | `qa_check`, `healthcheck` |
| **Zara** | Trend research | `research_trends`, `trend_scan` |
| **Atlas** | Returns & logistics | `coordinate_return`, `logistics` |

## Finley's finance core

`src/finance.ts` is pure and unit-tested (`npm test`): exact base margin
(retail − COGS − shipping cost − processor fee), sales tax tracked as a
pass-through (never profit), and net-profit splitting into envelopes with
largest-remainder rounding so the parts always sum **exactly** to the cent
(including losses).

## Tests

```bash
npm test          # Finley margin + profit-split (10 assertions)
npm run typecheck
```
