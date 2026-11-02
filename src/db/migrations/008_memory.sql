-- Sprint 3 : mémoire de chaque SaaS. Un « problème » (issue) suit un même constat d'une analyse à l'autre ;
-- il n'est déclaré corrigé que si le code constate que la preuve a disparu du dépôt.

create table issues (
  id bigint generated always as identity primary key,
  app_id uuid not null references apps (id) on delete cascade,
  fingerprint text not null,
  severity text not null check (severity in ('critical', 'high', 'medium', 'low')),
  category text not null,
  title text not null,
  file_path text,
  evidence text,
  recommendation text,
  source text not null check (source in ('code', 'ai')),
  status text not null default 'open' check (status in ('open', 'fixed', 'dismissed')),
  status_reason text,
  first_mission_id uuid references missions (id) on delete set null,
  last_seen_mission_id uuid references missions (id) on delete set null,
  closed_mission_id uuid references missions (id) on delete set null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  closed_at timestamptz,
  unique (app_id, fingerprint)
);
create index issues_app_status_idx on issues (app_id, status);

alter table findings add column issue_id bigint references issues (id) on delete set null;

-- Notes du propriétaire : décisions et contraintes, relues par l'analyste à chaque analyse.
create table app_notes (
  id bigint generated always as identity primary key,
  app_id uuid not null references apps (id) on delete cascade,
  content text not null check (char_length(content) between 3 and 1000),
  created_at timestamptz not null default now()
);
create index app_notes_app_idx on app_notes (app_id, id desc);
