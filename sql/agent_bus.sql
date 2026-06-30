-- ─────────────────────────────────────────────────────────────
--  Luveni Ops — shared agent communication bus
--  Deploys to the SAME Supabase project as the storefront so agents
--  read live inventory/orders and coordinate. Three tables:
--    agent_tasks    — the work queue (who should do what, status).
--    agent_messages — the chat bus between agents + Astra (and humans).
--    agent_runs     — an audit log of every agent execution + token use.
--  Admin-only via RLS; the fleet uses the service-role key.
-- ─────────────────────────────────────────────────────────────

create table if not exists public.agent_tasks (
  id uuid primary key default gen_random_uuid(),
  -- Target agent id (e.g. 'finley'); null = unrouted, orchestrator assigns.
  assignee text,
  created_by text not null default 'astra',
  kind text not null,                       -- e.g. 'reconcile_margins', 'make_video'
  status text not null default 'queued'
    check (status in ('queued','claimed','running','done','error','blocked')),
  priority int not null default 5,          -- 1 (highest) .. 9
  input jsonb not null default '{}'::jsonb,
  result jsonb,
  error text,
  -- Optional chain: a task can depend on another finishing first.
  depends_on uuid references public.agent_tasks(id) on delete set null,
  claimed_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists agent_tasks_queue_idx
  on public.agent_tasks (status, assignee, priority, created_at);

create table if not exists public.agent_messages (
  id uuid primary key default gen_random_uuid(),
  task_id uuid references public.agent_tasks(id) on delete cascade,
  from_agent text not null,
  to_agent text,                            -- null = broadcast to the fleet
  role text not null default 'agent' check (role in ('agent','astra','human','system')),
  content text not null,
  data jsonb,
  created_at timestamptz not null default now()
);
create index if not exists agent_messages_task_idx on public.agent_messages (task_id, created_at);
create index if not exists agent_messages_inbox_idx on public.agent_messages (to_agent, created_at);

create table if not exists public.agent_runs (
  id uuid primary key default gen_random_uuid(),
  agent text not null,
  task_id uuid references public.agent_tasks(id) on delete set null,
  status text not null,
  summary text,
  tool_calls jsonb default '[]'::jsonb,
  input_tokens int default 0,
  output_tokens int default 0,
  duration_ms int,
  created_at timestamptz not null default now()
);
create index if not exists agent_runs_agent_idx on public.agent_runs (agent, created_at);

-- Finley's budgeting envelopes (COGS / opex / savings / profit).
create table if not exists public.budget_envelopes (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  -- Target share of NET profit routed here (0..1). Must sum to ~1 across rows.
  allocation numeric not null default 0,
  balance_cents bigint not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists public.budget_ledger (
  id uuid primary key default gen_random_uuid(),
  envelope text not null,
  order_id uuid,
  delta_cents bigint not null,
  memo text,
  created_at timestamptz not null default now()
);
create index if not exists budget_ledger_envelope_idx on public.budget_ledger (envelope, created_at);

-- Seed the default envelopes once.
insert into public.budget_envelopes (name, allocation) values
  ('cogs', 0.0), ('operating', 0.40), ('savings', 0.30), ('profit', 0.30)
on conflict (name) do nothing;

-- RLS: admin-only from the client; the fleet uses service-role (bypasses RLS).
do $$
declare t text;
begin
  foreach t in array array['agent_tasks','agent_messages','agent_runs','budget_envelopes','budget_ledger']
  loop
    execute format('alter table public.%I enable row level security;', t);
    execute format($f$
      drop policy if exists "admins manage %1$s" on public.%1$I;
      create policy "admins manage %1$s" on public.%1$I for all to authenticated
        using (public.has_role(auth.uid(), 'admin'::public.app_role))
        with check (public.has_role(auth.uid(), 'admin'::public.app_role));
    $f$, t);
  end loop;
end $$;
