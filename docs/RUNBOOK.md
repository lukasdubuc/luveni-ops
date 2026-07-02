# Luveni Operations Runbook

The operating manual for the fleet (Astra + workers) and any future operator.
Everything here is live in production (Supabase project `unitqfuetxedmmrvlocu`,
storefront `luveni2.0` on Lovable).

## The product pipeline (CJ Dropshipping — primary supplier)

```
CJ "My Products"
   │  cj-catalog-sync (edge fn; Sync button in admin, or run_vendor_sync tool)
   ▼
products table          ← titles cleaned (formatTitle), COST in cost_cents,
  + product_media          RETAIL in price_cents (pricing engine), full CJ
  + channel_publications   payload in raw_payload, all images captured.
   │                       New products AUTO-PUBLISH to the site.
   ▼
cj-inventory-sync       ← live per-warehouse stock onto variants[].stock /
  (pg_cron every 30 min)   cj_stock; Discord low-stock alert when buffered
                           stock ≤ low_stock_threshold (6h cooldown).
```

- CJ itself pushes listings to TikTok Shop. Writing quantity/price TO TikTok
  via API is **blocked until the business has an EIN** (TikTok Shop app review
  requires a US company). Until then: the site is the inventory source of
  truth, and TikTok listing prices are set in the CJ dashboard — they must
  match the site's retail (use `compute_price` for the number).
- `buffer_qty` (per product) dampens oversell; `low_stock_threshold` fires the
  Discord alert. On an alert, pause the product on TikTok.

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

## Health checks (Dexter)

- `agent_runs` for failures; `net._http_response` for cron call results.
- Products with `price_cents <= cost_cents` → pricing bug, alert immediately.
- Variants with `stock is null` for >1h → inventory sync gaps (CJ 429s heal
  on the next sweep; persistent nulls mean a broken vid).

## Vendor status

| Vendor | State |
|---|---|
| CJ Dropshipping | LIVE — catalog + inventory + pricing automated |
| Printful | `printful-sync` edge fn exists; keys set; category shipping table already seeded in pricing_rules |
| Apliiq / Zendrop | Keys set; sync functions exist; secondary |
| TikTok Shop API | Blocked on EIN; CJ handles TikTok listing push meanwhile |
| TikTok content posting (developers.tiktok.com) | App created; needs integration + sandbox demo video before submission |
