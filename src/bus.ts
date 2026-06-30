// ─────────────────────────────────────────────────────────────
//  Luveni Ops — shared Supabase communication bus
//  Thin, typed wrapper over the agent_tasks / agent_messages / agent_runs
//  tables. Every agent claims work, posts messages, and logs runs here so
//  the fleet coordinates through one durable source of truth.
// ─────────────────────────────────────────────────────────────

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL ?? "";
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

export const db: SupabaseClient = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});

export interface AgentTask {
  id: string;
  assignee: string | null;
  created_by: string;
  kind: string;
  status: "queued" | "claimed" | "running" | "done" | "error" | "blocked";
  priority: number;
  input: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: string | null;
  depends_on: string | null;
}

/** Atomically claim the next queued task for an agent (priority then FIFO). */
export async function claimNextTask(agentId: string): Promise<AgentTask | null> {
  // Fetch candidates addressed to this agent (or unrouted) whose deps are done.
  const { data, error } = await db
    .from("agent_tasks")
    .select("*")
    .eq("status", "queued")
    .or(`assignee.eq.${agentId},assignee.is.null`)
    .order("priority", { ascending: true })
    .order("created_at", { ascending: true })
    .limit(5);
  if (error || !data?.length) return null;

  for (const task of data as AgentTask[]) {
    if (task.depends_on && !(await isTaskDone(task.depends_on))) continue;
    // Compare-and-set claim: only succeeds if still queued (prevents double-claim).
    const { data: claimed } = await db
      .from("agent_tasks")
      .update({ status: "claimed", assignee: agentId, claimed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("id", task.id)
      .eq("status", "queued")
      .select()
      .maybeSingle();
    if (claimed) return claimed as AgentTask;
  }
  return null;
}

async function isTaskDone(id: string): Promise<boolean> {
  const { data } = await db.from("agent_tasks").select("status").eq("id", id).maybeSingle();
  return data?.status === "done";
}

export async function setTaskStatus(
  id: string,
  status: AgentTask["status"],
  patch: Partial<Pick<AgentTask, "result" | "error">> = {},
): Promise<void> {
  await db.from("agent_tasks").update({
    status, ...patch,
    finished_at: ["done", "error"].includes(status) ? new Date().toISOString() : null,
    updated_at: new Date().toISOString(),
  }).eq("id", id);
}

export async function enqueueTask(input: {
  kind: string; assignee?: string; createdBy?: string; priority?: number;
  input?: Record<string, unknown>; dependsOn?: string;
}): Promise<string | null> {
  const { data } = await db.from("agent_tasks").insert({
    kind: input.kind, assignee: input.assignee ?? null, created_by: input.createdBy ?? "astra",
    priority: input.priority ?? 5, input: input.input ?? {}, depends_on: input.dependsOn ?? null,
  }).select("id").maybeSingle();
  return data?.id ?? null;
}

export async function postMessage(m: {
  fromAgent: string; toAgent?: string; taskId?: string;
  role?: "agent" | "astra" | "human" | "system"; content: string; data?: unknown;
}): Promise<void> {
  await db.from("agent_messages").insert({
    from_agent: m.fromAgent, to_agent: m.toAgent ?? null, task_id: m.taskId ?? null,
    role: m.role ?? "agent", content: m.content, data: m.data ?? null,
  });
}

export async function logRun(r: {
  agent: string; taskId?: string; status: string; summary?: string;
  toolCalls?: unknown[]; inputTokens?: number; outputTokens?: number; durationMs?: number;
}): Promise<void> {
  await db.from("agent_runs").insert({
    agent: r.agent, task_id: r.taskId ?? null, status: r.status, summary: r.summary ?? null,
    tool_calls: r.toolCalls ?? [], input_tokens: r.inputTokens ?? 0,
    output_tokens: r.outputTokens ?? 0, duration_ms: r.durationMs ?? null,
  });
}
