-- Les notes de recherche sont conservées : une relance réutilise la recherche déjà payée.
alter table artifacts drop constraint artifacts_kind_check;
alter table artifacts add constraint artifacts_kind_check check (kind in ('research', 'dossier', 'red_team', 'spec', 'test_plan'));
