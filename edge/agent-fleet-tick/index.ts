// ─────────────────────────────────────────────────────────────
//  Luveni Ops — agent-fleet-tick (Supabase Edge Function)
//  Serverless orchestrator tick: each invocation sweeps the bus — every
//  agent tries to claim + run its next task — repeating until the queue
//  is drained or the time budget runs out. Scheduled by pg_cron every
//  5 minutes (job: agent-fleet-tick-5min), so the fleet runs with zero
//  extra infrastructure. Safe to also invoke manually / run local
//  orchestrators in parallel: claims are compare-and-set.
//
//  The sibling *.ts files are copies of ../../src/*.ts with ".js" import
//  specifiers rewritten to ".ts" — regenerate with scripts/sync-edge.sh
//  whenever src changes, then redeploy.
//
//  Body (all optional): { "agents": ["finley"], "budget_ms": 110000 }
//  Env (edge secrets): SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are
//  auto-injected; ANTHROPIC_API_KEY (or GEMINI_API_KEY + LLM_PROVIDER)
//  must be set as function secrets.
// ─────────────────────────────────────────────────────────────

import "./env-shim.ts";
import { AGENTS, AGENT_BY_ID, type AgentProfile } from "./agents.ts";
import { claimNextTask } from "./bus.ts";
import { runAgentTask } from "./agent.ts";
import { seedFleetWork, workerAgents } from "./seed.ts";

Deno.serve(async (req: Request) => {
  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const ids: string[] = Array.isArray(body.agents) ? body.agents : [];
  const agents: AgentProfile[] = ids.length
    ? ids.map((id) => AGENT_BY_ID[id]).filter(Boolean)
    : AGENTS;
  // Stay under the edge wall-clock limit; leftover tasks are picked up next tick.
  const deadline = Date.now() + Math.min(Number(body.budget_ms ?? 110_000), 140_000);

  // Top up the queue first so idle workers get a daily/self-directed task
  // to run this same tick — this is what keeps the fleet working non-stop.
  // Skip when the caller targets specific agents for a one-off manual run.
  let seeded: { daily: number; selfDirect: number } = { daily: 0, selfDirect: 0 };
  if (!ids.length) {
    try { seeded = await seedFleetWork(workerAgents(agents)); }
    catch (e: any) { seeded = { daily: 0, selfDirect: 0, ...{ error: String(e?.message ?? e) } } as any; }
  }

  const processed: unknown[] = [];
  while (Date.now() < deadline) {
    const sweep = await Promise.all(agents.map(async (agent) => {
      try {
        const task = await claimNextTask(agent.id);
        if (!task) return null;
        await runAgentTask(agent, task); // logs to agent_runs, writes result to agent_tasks
        return { agent: agent.id, taskId: task.id, kind: task.kind };
      } catch (e: any) {
        return { agent: agent.id, error: String(e?.message ?? e) };
      }
    }));
    const claimed = sweep.filter(Boolean);
    processed.push(...claimed);
    if (claimed.length === 0) break; // queue drained
  }

  return new Response(JSON.stringify({ ok: true, seeded, agents: agents.map((a) => a.id), processed }), {
    headers: { "content-type": "application/json" },
  });
});
