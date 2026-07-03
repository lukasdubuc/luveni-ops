# Luveni Operations Runbook

The operating manual for the fleet (Astra + workers) and any future operator.
Everything here is live in production (Supabase project `unitqfuetxedmmrvlocu`,
storefront `luveni2.0` on Lovable).

## The product pipeline (CJ + Printful — first-class suppliers)

```
CJ "My Products"            Printful store
   │ cj-catalog-sync           │ printful-sync (same standard: cost from the
   ▼                           ▼  Printful catalog API, retail via pricing
products table          ← titles cleaned (formatTitle), COST in cost_cents,
  + product_media          RETAIL in price_cents (pricing engine), full vendor
  + channel_publications   payload in raw_payload, ALL media captured.
   │                       New products AUTO-PUBLISH to the site.
   ▼
cj-inventory-sync       ← live per-warehouse stock onto variants[].stock /
  (pg_cron every 30 min)   cj_stock; Discord low-stock alert when buffered
   +                       stock ≤ low_stock_threshold (6h cooldown).
cj-webhook              ← near-real-time: CJ pushes a stock/product event,
  (CJ push, key in URL)    the function re-queries the vids mentioned and
                           updates variants immediately (events logged in
                           cj_webhook_events for Dexter).
```

- CJ itself pushes listings AND stock to TikTok Shop — but only if the CJ
  dashboard store setting has inventory sync enabled (Authorization → LUVENI
  (TikTok) → inventory sync + ratio). If listings land with 0 quantity, that
  toggle is the cause. Writing quantity/price TO TikTok via API stays
  **blocked until the business has an EIN**. The site is the inventory source
  of truth; TikTok listing prices are set in the CJ dashboard and must match
  the site's retail (use `compute_price` for the number).
- `buffer_qty` (per product) dampens oversell; `low_stock_threshold` fires the
  Discord alert. On an alert, pause the product on TikTok.

## Order fulfillment (fulfill-order edge fn)

Paid orders route per line item by `fulfillment_provider`:
Printful (auto), Apliiq/Zendrop (gated by `*_AUTO` secrets), and CJ:
1. **Live stock check first** — every CJ line's vid is verified against CJ's
   real-time stock. Any shortage blocks the CJ sub-order and fires a Discord
   alert (`🛑 CJ order blocked — stock`); the paid order is preserved for
   manual handling.
2. Submission via `createOrderV2` only when `CJ_AUTO=true` (secret). Until
   then the stock check still runs and the result is recorded on the order.

## TikTok content posting (developers.tiktok.com — LIVE integration)

Separate from TikTok Shop: posts product photos/videos to the Luveni TikTok
ACCOUNT. `tiktok-oauth` (connect from Admin → Settings → Integrations) +
`tiktok-post` (photo carousels from product_media, videos, status polling;
posts recorded in `tiktok_posts`). Sandbox/app-review playbook:
`luveni2.0/docs/TIKTOK_CONTENT_POSTING.md`. Fleet access: Sloane's
`tiktok_post_photo` / `tiktok_post_status` tools. **Everything posts
SELF_ONLY (private) until the TikTok app passes review** — never pass a
public privacy level without the owner's standing instruction.

## Pricing engine (single source of truth)

Formula (code: `luveni2.0/supabase/functions/_shared/pricing.ts`; parameters:
`pricing_rules` table — the tuning surface, no deploy needed):

```
floor_fees   = (cost + ship_first + min_profit) / (1 - fee_rate)
floor_margin = cost / (1 - target_margin)
retail       = charm( max(floor_fees, floor_margin) )   # charm = next ".99"
```

- `fee_rate` (default 9%) covers payment processing + marketplace referral, so
  `min_profit_cents` is profit **after** fees and first-item shipping.
- Categories are keyword-matched from the title (bags, footwear, shirts,
  all-over print, kids, tech, mugs, stationery, premium apparel, headwear,
  default) — seeded from the owner's Printful cost/shipping sheet.
- `cost_cents` (product + each variant) is the vendor cost, forever separate
  from retail. Never derive cost from retail.
- Tools: `compute_price` (quote), `reprice_products` (apply to catalog),
  `update_pricing_rule` (tune parameters). Edge function: `pricing-engine`
  (`action: "quote" | "reprice"`).

## Guardrails (do not violate)

1. Orion never auto-applies a retail change >10% or margin <50% — propose to
   Astra/Finley first.
2. Nothing is unpublished/archived without an out-of-stock or owner reason.
3. Secrets are write-only via the `manage-secrets` function (names/status
   only, never values). Never widen its allowlist.
4. External publishing (TikTok posts, ads, spend) requires the owner's
   standing instruction or explicit task.

## Scheduled jobs

| Job | Schedule | What |
|---|---|---|
| `cj-inventory-sync-30min` (pg_cron #1) | `*/30 * * * *` | Live CJ stock → variants, low-stock Discord alerts (~3.3k of CJ's 10k daily call quota) |
| `agent-fleet-tick-5min` (pg_cron #2) | `*/5 * * * *` | Serverless fleet sweep: every agent claims + runs queued agent_tasks (edge fn `agent-fleet-tick`; needs `ANTHROPIC_API_KEY` function secret) |
| `printful-sync-daily` (pg_cron #3) | `0 6 * * *` | Printful catalog re-import (cost → retail, media, availability) |
| `cj-webhook` (event-driven) | on CJ push | Near-real-time stock updates for the vids CJ mentions — SUBSCRIBED live for product + stock events (verified: bad key 401 / good key 200) |

The `agent-fleet-tick` source lives in `edge/agent-fleet-tick/` (index +
env-shim + deno.json, plus copies of `src/*.ts`). After ANY `src/*.ts`
change run `scripts/sync-edge.sh` and redeploy the function, or Sloane &
co. keep running the old roster.

## Health checks (Dexter)

- `agent_runs` for failures; `net._http_response` for cron call results.
- Products with `price_cents <= cost_cents` → pricing bug, alert immediately.
- Variants with `stock is null` for >1h → inventory sync gaps (CJ 429s heal
  on the next sweep; persistent nulls mean a broken vid).

## Vendor status

| Vendor | State |
|---|---|
| CJ Dropshipping | LIVE — catalog + inventory (cron + webhook) + pricing + order-time stock gate; auto-submit behind `CJ_AUTO` |
| Printful | LIVE — catalog at CJ standard (catalog-API cost → retail, full media, auto-publish, cron-capable) |
| Apliiq / Zendrop | Keys set; sync functions exist; secondary |
| TikTok Shop API | Blocked on EIN; CJ pushes listings + stock to TikTok (enable inventory sync in CJ dashboard store settings) |
| TikTok content posting (developers.tiktok.com) | Integration BUILT (tiktok-oauth + tiktok-post + Sloane tools); needs client secret, OAuth connect, sandbox demo video, then app submission — see luveni2.0/docs/TIKTOK_CONTENT_POSTING.md |

## Booting the fleet

1. Schema: `sql/agent_bus.sql` is applied to the shared Supabase project
   (agent_tasks / agent_messages / agent_runs + budget envelopes).
2. Env (see `.env.example`): `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
   `ANTHROPIC_API_KEY`, optional `FLEET_AGENTS` (comma-separated ids) and
   `POLL_INTERVAL_MS`.
3. `npm start` (or `bun run src/orchestrator.ts`) — every agent polls the bus
   and claims its task kinds. Seed work by inserting into `agent_tasks`
   (e.g. kind `daily_briefing` → astra) or via the `delegate_task` tool.
4. Runtime options, in order of preference: a scheduled Claude Code session
   that works the bus each morning; a VPS/local `npm start` for 24/7; GitHub
   Actions cron for periodic ticks. Supabase pg_cron keeps the storefront
   jobs running regardless — the fleet is additive, never load-bearing.
