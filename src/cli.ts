// ─────────────────────────────────────────────────────────────
//  Luveni Ops — CLI to enqueue tasks onto the bus.
//  Usage: npm run agent -- <assignee> <kind> '<json-input>'
//  e.g.   npm run agent -- finley reconcile_order_margin '{"orderId":"…"}'
// ─────────────────────────────────────────────────────────────

import { enqueueTask } from "./bus.js";
import { AGENT_BY_ID } from "./agents.js";

const [, , assignee, kind, jsonInput] = process.argv;

if (!assignee || !kind) {
  console.error("Usage: npm run agent -- <assignee> <kind> '<json-input>'");
  console.error("Agents:", Object.keys(AGENT_BY_ID).join(", "));
  process.exit(1);
}
if (!AGENT_BY_ID[assignee]) {
  console.error(`Unknown agent "${assignee}". Known:`, Object.keys(AGENT_BY_ID).join(", "));
  process.exit(1);
}

let input: Record<string, unknown> = {};
if (jsonInput) { try { input = JSON.parse(jsonInput); } catch { console.error("input must be valid JSON"); process.exit(1); } }

const id = await enqueueTask({ assignee, kind, input, createdBy: "cli" });
console.log(id ? `Queued task ${id} → ${assignee} (${kind})` : "Failed to queue (check SUPABASE_* env)");
