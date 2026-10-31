-- Sprint 1 : accès GitHub en lecture seule, dépôt par dépôt, via la GitHub App de l'usine.
-- Aucun jeton n'est stocké : un jeton limité au dépôt et en lecture seule est demandé à chaque usage (valide 1 h).

create table integrations (
  id bigint generated always as identity primary key,
  app_id uuid not null references apps (id) on delete cascade,
  provider text not null check (provider in ('github')),
  installation_id bigint not null check (installation_id > 0),
  -- Droits accordés par l'installation, tels que GitHub les renvoie (vérifiés : lecture seule).
  permissions jsonb not null,
  default_branch text,
  last_commit_sha text check (last_commit_sha ~ '^[0-9a-f]{40}$'),
  verified_at timestamptz not null default now(),
  revoked_at timestamptz,
  unique (app_id, provider)
);
