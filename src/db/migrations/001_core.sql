-- Base de l'usine : projets, journal des décisions, sources, documents produits,
-- appels IA (coûts), validations humaines, réglages (arrêt d'urgence, budgets).

create extension if not exists pgcrypto;

create table settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

insert into settings (key, value) values
  ('paused', 'false'),
  ('daily_budget_usd', '15'),
  ('default_project_budget_usd', '150');

create table projects (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$'),
  title text not null check (char_length(title) between 1 and 120),
  request text not null check (char_length(request) between 5 and 4000),
  state text not null default 'IDEA' check (state in (
    'IDEA', 'RESEARCHING', 'AWAITING_P1', 'DEMAND_TEST', 'SPECIFYING', 'AWAITING_P2',
    'BUILDING', 'BLOCKED', 'STAGING', 'AWAITING_P3', 'PRODUCTION', 'FAILED', 'ARCHIVED')),
  budget_usd numeric(10, 2) not null check (budget_usd > 0),
  state_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Journal immuable de chaque changement d'état (qui, quand, pourquoi).
create table project_events (
  id bigint generated always as identity primary key,
  project_id uuid not null references projects (id) on delete cascade,
  from_state text,
  to_state text not null,
  actor text not null check (actor in ('system', 'user')),
  reason text,
  created_at timestamptz not null default now()
);
create index project_events_project_idx on project_events (project_id, id);

-- Pages réellement ouvertes par un agent : seules sources citables.
create table sources (
  id bigint generated always as identity primary key,
  project_id uuid not null references projects (id) on delete cascade,
  url text not null check (url ~ '^https?://'),
  title text,
  retrieved_at timestamptz not null default now(),
  unique (project_id, url)
);

-- Documents produits (dossier d'opportunité, spec…), versionnés, jamais écrasés.
create table artifacts (
  id bigint generated always as identity primary key,
  project_id uuid not null references projects (id) on delete cascade,
  kind text not null check (kind in ('dossier', 'red_team', 'spec', 'test_plan')),
  version int not null check (version > 0),
  content jsonb not null,
  markdown text not null,
  created_at timestamptz not null default now(),
  unique (project_id, kind, version)
);

-- Chaque appel IA : modèle, jetons, coût, durée, résultat.
create table agent_runs (
  id bigint generated always as identity primary key,
  project_id uuid references projects (id) on delete set null,
  agent text not null,
  model text not null,
  prompt_version text not null,
  input_tokens int not null default 0 check (input_tokens >= 0),
  output_tokens int not null default 0 check (output_tokens >= 0),
  web_searches int not null default 0 check (web_searches >= 0),
  cost_usd numeric(12, 6) not null default 0 check (cost_usd >= 0),
  duration_ms int not null default 0,
  status text not null check (status in ('ok', 'error')),
  error text,
  created_at timestamptz not null default now()
);
create index agent_runs_created_idx on agent_runs (created_at);
create index agent_runs_project_idx on agent_runs (project_id);

-- Portes humaines. Une seule demande en attente par projet et par porte.
create table approvals (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects (id) on delete cascade,
  gate text not null check (gate in ('P1', 'P2', 'P3', 'BUDGET', 'BLOCKED')),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  summary text not null,
  telegram_message_id bigint,
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  check ((status = 'pending') = (decided_at is null))
);
create unique index approvals_one_pending on approvals (project_id, gate) where status = 'pending';
