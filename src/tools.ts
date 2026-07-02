// ─────────────────────────────────────────────────────────────
//  Luveni Ops — agent tool registry
//  Real, callable tools backed by the shared Supabase DB. Agents are
//  granted a subset by id (see agents.ts). Each tool = JSON-schema spec
//  + an async runner returning a JSON-serializable result.
// ─────────────────────────────────────────────────────────────

import { db, enqueueTask, postMessage } from "./bus.js";
import { computeMargin, splitNetProfit, type OrderLine } from "./finance.js";
import type { ToolSpec } from "./llm.js";

export interface Tool {
  spec: ToolSpec;
  run: (input: Record<string, any>, ctx: { agentId: string; taskId?: string }) => Promise<unknown>;
}

export const TOOLS: Record<string, Tool> = {
  // ── Read inventory / catalog ──
  query_inventory: {
    spec: {
      name: "query_inventory",
      description: "List products with stock, price, source and publish state. Optional filters.",
      parameters: {
        type: "object",
        properties: {
          source: { type: "string", enum: ["printful", "apliiq", "zendrop", "cj", "manual"] },
          onlyPublished: { type: "boolean" },
          limit: { type: "number" },
        },
      },
    },
    run: async (i) => {
      let q = db.from("products").select("id,title,source,category,price_cents,cost_cents,is_published,buffer_qty,variants").limit(i.limit ?? 50);
      if (i.source) q = q.eq("source", i.source);
      if (i.onlyPublished) q = q.eq("is_published", true);
      const { data, error } = await q;
      if (error) return { error: error.message };
      return { count: data?.length ?? 0, products: data };
    },
  },

  // ── Store performance ──
  store_performance: {
    spec: {
      name: "store_performance",
      description: "Revenue, order count, and AOV over the last N days.",
      parameters: { type: "object", properties: { days: { type: "number" } } },
    },
    run: async (i) => {
      const since = new Date(Date.now() - (i.days ?? 7) * 864e5).toISOString();
      const { data, error } = await db.from("orders").select("total_cents,status,created_at").gte("created_at", since);
      if (error) return { error: error.message };
      const paid = (data ?? []).filter((o: any) => ["paid", "fulfilled", "shipped", "complete"].includes(o.status));
      const revenue = paid.reduce((s: number, o: any) => s + (o.total_cents ?? 0), 0);
      return { days: i.days ?? 7, orders: paid.length, revenue_cents: revenue, aov_cents: paid.length ? Math.round(revenue / paid.length) : 0 };
    },
  },

  // ── Reconcile margins + split profit into envelopes (Finley) ──
  reconcile_order_margin: {
    spec: {
      name: "reconcile_order_margin",
      description: "Compute exact net margin for an order and route net profit into budget envelopes.",
      parameters: { type: "object", properties: { orderId: { type: "string" } }, required: ["orderId"] },
    },
    run: async (i) => {
      const { data: order } = await db.from("orders").select("id,total_cents,metadata").eq("id", i.orderId).maybeSingle();
      if (!order) return { error: "order not found" };
      const meta: any = order.metadata ?? {};
      const lines: OrderLine[] = (meta.items ?? []).map((it: any) => ({
        retailCents: it.price_cents ?? 0,
        cogsCents: it.cost_cents ?? Math.round((it.price_cents ?? 0) * 0.45),
        quantity: it.quantity ?? 1,
      }));
      const margin = computeMargin({
        lines,
        shippingChargedCents: meta.shipping_charged_cents ?? 0,
        shippingCostCents: meta.shipping_cost_cents ?? 0,
        taxCollectedCents: meta.tax_cents ?? 0,
      });
      const { data: envelopes } = await db.from("budget_envelopes").select("name,allocation");
      const split = splitNetProfit(margin.netProfitCents, (envelopes ?? []) as any);
      // Post to the ledger + bump envelope balances.
      for (const [name, delta] of Object.entries(split)) {
        if (!delta) continue;
        await db.from("budget_ledger").insert({ envelope: name, order_id: i.orderId, delta_cents: delta, memo: "net profit split" });
        const { data: env } = await db.from("budget_envelopes").select("balance_cents").eq("name", name).maybeSingle();
        await db.from("budget_envelopes").update({ balance_cents: (env?.balance_cents ?? 0) + delta, updated_at: new Date().toISOString() }).eq("name", name);
      }
      return { margin, split };
    },
  },

  // ── Trigger a channel publish (Astra / Sloane) ──
  publish_product: {
    spec: {
      name: "publish_product",
      description: "Invoke the storefront publish-channel edge function for a curated product.",
      parameters: {
        type: "object",
        properties: { productId: { type: "string" }, channel: { type: "string", enum: ["tiktok", "etsy"] } },
        required: ["productId", "channel"],
      },
    },
    run: async (i) => {
      const res = await fetch(`${process.env.SUPABASE_URL}/functions/v1/publish-channel`, {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` },
        body: JSON.stringify({ productId: i.productId, channel: i.channel }),
      });
      return await res.json().catch(() => ({ ok: res.ok, status: res.status }));
    },
  },

  // ── Pricing engine (Orion / Astra / Finley) ──
  // Single source of truth is the storefront's pricing-engine edge function
  // (parameters in the pricing_rules table): retail = charm(max(
  //   (cost + ship_first + min_profit)/(1-fee_rate), cost/(1-target_margin))).
  compute_price: {
    spec: {
      name: "compute_price",
      description: "Quote the retail price for a vendor cost via the pricing engine. Returns retail, fees, after-fee profit, margin, and the matched category rule.",
      parameters: {
        type: "object",
        properties: {
          cost_cents: { type: "number", description: "Vendor cost in cents" },
          title: { type: "string", description: "Product title for category keyword matching" },
          category: { type: "string", description: "pricing_rules.key to force a category" },
        },
        required: ["cost_cents"],
      },
    },
    run: async (i) => {
      const res = await fetch(`${process.env.SUPABASE_URL}/functions/v1/pricing-engine`, {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` },
        body: JSON.stringify({ action: "quote", cost_cents: i.cost_cents, title: i.title, category: i.category }),
      });
      return await res.json().catch(() => ({ ok: res.ok, status: res.status }));
    },
  },

  reprice_products: {
    spec: {
      name: "reprice_products",
      description: "Reprice products from their stored vendor cost using current pricing_rules. Scope to one product or a source. Never lowers cost basis; only retail changes.",
      parameters: {
        type: "object",
        properties: {
          source: { type: "string", enum: ["printful", "apliiq", "zendrop", "cj", "manual"] },
          productId: { type: "string" },
          publish: { type: "boolean", description: "Also publish repriced products to the storefront" },
        },
      },
    },
    run: async (i) => {
      const res = await fetch(`${process.env.SUPABASE_URL}/functions/v1/pricing-engine`, {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` },
        body: JSON.stringify({ action: "reprice", source: i.source, productId: i.productId, publish: i.publish === true }),
      });
      return await res.json().catch(() => ({ ok: res.ok, status: res.status }));
    },
  },

  // ── Tune a pricing rule (Orion — the tuning surface for the engine) ──
  update_pricing_rule: {
    spec: {
      name: "update_pricing_rule",
      description: "Update parameters of one pricing_rules row (min_profit_cents, target_margin, fee_rate, ship_first_cents, ship_addl_cents). Changes apply to future pricing; run reprice_products to apply to the catalog.",
      parameters: {
        type: "object",
        properties: {
          key: { type: "string" },
          min_profit_cents: { type: "number" },
          target_margin: { type: "number" },
          fee_rate: { type: "number" },
          ship_first_cents: { type: "number" },
          ship_addl_cents: { type: "number" },
        },
        required: ["key"],
      },
    },
    run: async (i) => {
      const patch: Record<string, any> = { updated_at: new Date().toISOString() };
      for (const k of ["min_profit_cents", "target_margin", "fee_rate", "ship_first_cents", "ship_addl_cents"]) {
        if (i[k] !== undefined) patch[k] = i[k];
      }
      const { error } = await db.from("pricing_rules").update(patch).eq("key", i.key);
      return error ? { error: error.message } : { ok: true, key: i.key, patch };
    },
  },

  // ── Run a vendor catalog/inventory sync (Astra / Atlas) ──
  run_vendor_sync: {
    spec: {
      name: "run_vendor_sync",
      description: "Trigger a vendor sync edge function. CJ catalog sync imports products (auto-priced + published); withInventory also refreshes live CJ stock afterwards.",
      parameters: {
        type: "object",
        properties: {
          vendor: { type: "string", enum: ["cj", "printful", "zendrop", "apliiq"] },
          withInventory: { type: "boolean" },
        },
        required: ["vendor"],
      },
    },
    run: async (i) => {
      const fn: Record<string, string> = { cj: "cj-catalog-sync", printful: "printful-sync", zendrop: "zendrop-sync", apliiq: "apliiq-sync" };
      const call = async (name: string) => {
        const res = await fetch(`${process.env.SUPABASE_URL}/functions/v1/${name}`, {
          method: "POST",
          headers: { "content-type": "application/json", Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` },
          body: "{}",
        });
        return await res.json().catch(() => ({ ok: res.ok, status: res.status }));
      };
      const catalog = await call(fn[i.vendor]);
      const inventory = i.vendor === "cj" && i.withInventory ? await call("cj-inventory-sync") : undefined;
      return { catalog, inventory };
    },
  },

  // ── Delegate work to another agent ──
  delegate_task: {
    spec: {
      name: "delegate_task",
      description: "Queue a task for another agent on the bus.",
      parameters: {
        type: "object",
        properties: { assignee: { type: "string" }, kind: { type: "string" }, priority: { type: "number" }, input: { type: "object" } },
        required: ["assignee", "kind"],
      },
    },
    run: async (i, ctx) => {
      const id = await enqueueTask({ assignee: i.assignee, kind: i.kind, priority: i.priority, input: i.input, createdBy: ctx.agentId });
      return { taskId: id };
    },
  },

  // ── Talk on the bus ──
  send_message: {
    spec: {
      name: "send_message",
      description: "Post a message to another agent (or broadcast) on the shared bus.",
      parameters: {
        type: "object",
        properties: { to: { type: "string" }, content: { type: "string" }, data: { type: "object" } },
        required: ["content"],
      },
    },
    run: async (i, ctx) => {
      await postMessage({ fromAgent: ctx.agentId, toAgent: i.to, taskId: ctx.taskId, content: i.content, data: i.data });
      return { ok: true };
    },
  },

  // ── Recent system logs (Astra monitoring / Dexter QA) ──
  read_agent_runs: {
    spec: {
      name: "read_agent_runs",
      description: "Recent agent run logs (status, summary, token use) for monitoring.",
      parameters: { type: "object", properties: { agent: { type: "string" }, limit: { type: "number" } } },
    },
    run: async (i) => {
      let q = db.from("agent_runs").select("agent,status,summary,created_at").order("created_at", { ascending: false }).limit(i.limit ?? 20);
      if (i.agent) q = q.eq("agent", i.agent);
      const { data } = await q;
      return { runs: data };
    },
  },
};

export function toolsFor(names: string[]): ToolSpec[] {
  return names.map((n) => TOOLS[n]?.spec).filter(Boolean) as ToolSpec[];
}
