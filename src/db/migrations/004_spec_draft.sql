-- Brouillon de spec validé, conservé avant l'écriture des tests : une relance ne repaie pas la spec.
alter table artifacts drop constraint artifacts_kind_check;
alter table artifacts add constraint artifacts_kind_check check (kind in ('research', 'dossier', 'red_team', 'spec_draft', 'spec', 'test_plan'));
