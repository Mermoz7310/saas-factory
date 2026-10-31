-- Sprint 2 : analyse réelle d'un dépôt (lecture seule). Rapport daté, lié au commit, constats vérifiés par le code.

alter table missions add column report_md text;
alter table missions add column report jsonb;

create table findings (
  id bigint generated always as identity primary key,
  mission_id uuid not null references missions (id) on delete cascade,
  app_id uuid not null references apps (id) on delete cascade,
  severity text not null check (severity in ('critical', 'high', 'medium', 'low')),
  category text not null check (category in ('security', 'bug', 'performance', 'dependency', 'architecture', 'quality', 'test', 'injection')),
  title text not null check (char_length(title) between 1 and 200),
  file_path text,
  evidence text,
  recommendation text,
  -- Vrai seulement si le code a retrouvé le fichier ET l'extrait cité dans le dépôt analysé.
  verified boolean not null,
  -- Constat produit par le code (scanner de secrets) plutôt que par l'IA.
  source text not null check (source in ('code', 'ai')),
  created_at timestamptz not null default now()
);
create index findings_mission_idx on findings (mission_id);

-- Une seule analyse en cours par app.
create unique index missions_one_active on missions (app_id) where status in ('queued', 'running');
