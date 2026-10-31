-- Mode « Entretenir » (Sprint 0) : SaaS connectés, règles d'autorisation, missions,
-- journal d'audit immuable, plafonds par mission et par mois.

-- Un SaaS existant confié à l'usine. Niveau 0 = lecture seule (par défaut).
create table apps (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$'),
  title text not null check (char_length(title) between 1 and 120),
  repo_full_name text not null unique check (repo_full_name ~ '^[A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100}$'),
  -- Projet de l'usine dont l'app est issue (mode Construire), si c'est le cas.
  project_id uuid references projects (id) on delete set null,
  autonomy_level int not null default 0 check (autonomy_level between 0 and 4),
  status text not null default 'active' check (status in ('active', 'paused', 'disconnected')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Règles propres à une app. Elles ne peuvent que RESTREINDRE ce que le code autorise :
-- une ligne « allow » ne lève jamais un interdit ni une validation obligatoire (vérifié dans src/maintain/policy.ts).
create table policies (
  id bigint generated always as identity primary key,
  app_id uuid not null references apps (id) on delete cascade,
  action text not null,
  effect text not null check (effect in ('deny', 'approve')),
  max_cost_usd numeric(10, 2) check (max_cost_usd > 0),
  created_at timestamptz not null default now(),
  unique (app_id, action)
);

-- Une mission = un ordre reçu et son suivi.
create table missions (
  id uuid primary key default gen_random_uuid(),
  app_id uuid not null references apps (id) on delete cascade,
  kind text not null check (kind in ('analysis', 'fix', 'feature', 'check')),
  request text not null check (char_length(request) between 1 and 4000),
  source text not null check (source in ('telegram', 'web', 'system')),
  status text not null default 'queued' check (status in (
    'queued', 'running', 'awaiting_approval', 'succeeded', 'failed', 'refused', 'cancelled')),
  commit_sha text check (commit_sha ~ '^[0-9a-f]{40}$'),
  cost_usd numeric(12, 6) not null default 0 check (cost_usd >= 0),
  status_reason text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  ended_at timestamptz
);
create index missions_app_idx on missions (app_id, created_at desc);

-- Chaque appel IA peut être rattaché à une mission.
alter table agent_runs add column mission_id uuid references missions (id) on delete set null;
create index agent_runs_mission_idx on agent_runs (mission_id);

-- Journal d'audit : ajout seul. Aucune modification ni suppression possible, même par l'usine.
create table audit_events (
  id bigint generated always as identity primary key,
  actor text not null check (actor in ('owner', 'factory', 'agent')),
  action text not null check (char_length(action) between 1 and 80),
  app_id uuid references apps (id) on delete set null,
  mission_id uuid references missions (id) on delete set null,
  decision text check (decision in ('allowed', 'approval_required', 'denied', 'done', 'failed')),
  reason text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index audit_events_created_idx on audit_events (created_at desc);
create index audit_events_app_idx on audit_events (app_id, id desc);

create function audit_events_append_only() returns trigger language plpgsql as $$
begin
  -- Exception : la suppression en cascade d'une app/mission met seulement ses références à null.
  if tg_op = 'UPDATE'
     and new.id = old.id and new.actor = old.actor and new.action = old.action
     and new.decision is not distinct from old.decision and new.reason is not distinct from old.reason
     and new.details = old.details and new.created_at = old.created_at
     and (new.app_id is null or new.app_id = old.app_id)
     and (new.mission_id is null or new.mission_id = old.mission_id) then
    return new;
  end if;
  raise exception 'audit_events est en ajout seul (% interdit)', tg_op;
end;
$$;

create trigger audit_events_no_update before update or delete on audit_events
  for each row execute function audit_events_append_only();
create trigger audit_events_no_truncate before truncate on audit_events
  for each statement execute function audit_events_append_only();

insert into settings (key, value) values
  -- Coût maximum d'une mission (en $), sauf règle plus stricte sur l'app.
  ('mission_max_usd', '2'),
  -- Plafond absolu du mois (en $), toutes activités de l'usine confondues.
  ('monthly_budget_usd', '150');
