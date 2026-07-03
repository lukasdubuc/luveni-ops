// ─────────────────────────────────────────────────────────────
//  Luveni Ops — fleet work seeder
//  Keeps the fleet busy without a human in the loop. Two sources of work,
//  layered on top of tasks Astra or the owner delegate directly:
//
//    1. Daily review  — one idempotent high-priority task per worker per
//       calendar day (kind "daily_review"), so every domain gets a
//       deliberate once-a-day pass.
//    2. Self-direct    — whenever a worker's queue is empty it is handed a
//       "find and do the highest-value work in your domain" task
//       (kind "self_direct"), so caught-up agents keep working instead of
//       idling. Because we only seed when the agent has zero open tasks,
//       each agent runs at most once per tick (every ~5 min) rather than
//       spinning — non-stop, but paced and cost-bounded.
//
//  Astra is excluded: she is the owner-facing manager and acts on
//  delegated/assistant requests, not an auto-looping worker.
// ─────────────────────────────────────────────────────────────

import { db, enqueueTask } from "./bus.js";
import { AGENTS, type AgentProfile } from "./agents.js";

const OPEN_STATUSES = ["queued", "claimed", "running"];

/** Workers that should be kept busy (everyone except the owner-facing manager). */
export function workerAgents(agents: AgentProfile[] = AGENTS): AgentProfile[] {
  return agents.filter((a) => a.id !== "astra");
}

async function openTaskCount(agentId: string): Promise<number> {
  const { count } = await db
    .from("agent_tasks")
    .select("id", { count: "exact", head: true })
    .eq("assignee", agentId)
    .in("status", OPEN_STATUSES);
  return count ?? 0;
}

async function dailyReviewExists(agentId: string, date: string): Promise<boolean> {
  const { data } = await db
    .from("agent_tasks")
    .select("id")
    .eq("assignee", agentId)
    .eq("kind", "daily_review")
    .eq("input->>date", date)
    .limit(1);
  return !!data?.length;
}

/**
 * Top up the queue so no worker sits idle. Returns how many tasks were
 * seeded, by kind. Idempotent within a day for daily reviews; self-direct
 * only fires for agents whose queue is currently empty.
 */
export async function seedFleetWork(
  agents: AgentProfile[] = workerAgents(),
): Promise<{ daily: number; selfDirect: number }> {
  const today = new Date().toISOString().slice(0, 10);
  let daily = 0;
  let selfDirect = 0;

  for (const agent of agents) {
    // 1) One deliberate daily pass per worker (idempotent per calendar day).
    if (!(await dailyReviewExists(agent.id, today))) {
      const id = await enqueueTask({
        kind: "daily_review",
        assignee: agent.id,
        createdBy: "fleet-seeder",
        priority: 3,
        input: {
          date: today,
          directive:
            `Daily review for your domain as ${agent.role}. Pull the current picture from your ` +
            `tools, complete the single highest-value action for today, and enqueue follow-up ` +
            `tasks for anything larger. Keep it concrete — real changes, not a status report.`,
        },
      });
      if (id) daily++;
    }

    // 2) Non-stop: an idle worker gets a self-directed task so it keeps
    //    finding and doing work. Seeded only when the queue is empty, which
    //    caps each agent to one self-directed run per tick.
    if ((await openTaskCount(agent.id)) === 0) {
      const id = await enqueueTask({
        kind: "self_direct",
        assignee: agent.id,
        createdBy: "fleet-seeder",
        priority: 7,
        input: {
          directive:
            `You are caught up. Proactively find the highest-value work in your domain ` +
            `(${agent.role}) right now: inspect live data with your tools, take one concrete ` +
            `action, and enqueue follow-up tasks for anything that needs more. Do not repeat ` +
            `work you or the fleet completed recently.`,
        },
      });
      if (id) selfDirect++;
    }
  }

  return { daily, selfDirect };
}
