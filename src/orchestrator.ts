// ─────────────────────────────────────────────────────────────
//  Luveni Ops — orchestrator
//  Runs a set of agents in one process. Each tick, every agent tries to
//  claim its next task off the shared bus and execute it. Horizontally
//  scalable: run multiple orchestrators (or split FLEET_AGENTS across
//  processes) and the compare-and-set claim prevents double execution.
// ─────────────────────────────────────────────────────────────

import { AGENTS, AGENT_BY_ID, type AgentProfile } from "./agents.js";
import { claimNextTask } from "./bus.js";
import { runAgentTask } from "./agent.js";
import { seedFleetWork, workerAgents } from "./seed.js";

const POLL = Number(process.env.POLL_INTERVAL_MS ?? 5000);

function selectedAgents(): AgentProfile[] {
  const ids = (process.env.FLEET_AGENTS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0) return AGENTS;
  return ids.map((id) => AGENT_BY_ID[id]).filter(Boolean);
}

let running = true;

async function tick(agents: AgentProfile[]): Promise<void> {
  await Promise.all(agents.map(async (agent) => {
    try {
      const task = await claimNextTask(agent.id);
      if (task) {
        console.log(`[${agent.id}] claimed task ${task.id} (${task.kind})`);
        await runAgentTask(agent, task);
        console.log(`[${agent.id}] finished task ${task.id}`);
      }
    } catch (e: any) {
      console.error(`[${agent.id}] tick error:`, e.message);
    }
  }));
}

async function main(): Promise<void> {
  const agents = selectedAgents();
  console.log(`Luveni Ops fleet up — ${agents.length} agents: ${agents.map((a) => a.id).join(", ")}`);
  if (!process.env.SUPABASE_URL) console.warn("⚠ SUPABASE_URL not set — see .env.example");

  // Keep the queue topped up so agents work non-stop and find their own
  // work when caught up. Only seeds the workers this process runs.
  const seedable = workerAgents(agents);

  while (running) {
    try {
      if (seedable.length) await seedFleetWork(seedable);
    } catch (e: any) {
      console.error("seed error:", e.message);
    }
    await tick(agents);
    await new Promise((r) => setTimeout(r, POLL));
  }
}

process.on("SIGINT", () => { running = false; console.log("\nShutting down fleet…"); });
process.on("SIGTERM", () => { running = false; });

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
