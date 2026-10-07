# saas-factory

Cœur de SaaS Factory AI : base de l'usine, file de travaux, bot Telegram, étape 1a (dossier d'opportunité sourcé) et étape 2 (spec exécutable : stories, migration SQL générée par le code, tests d'acceptation, porte P2).

- `src/domain/` : projets, machine à états, portes humaines (P1/P2/P3)
- `src/pipeline/` : recherche → synthèse → vérification des sources (code) → Red Team → décision
- `src/spec/` : schéma de spec, générateur SQL (RLS), contrôles des tests d'acceptation
- `src/llm/` : client Claude avec plafonds de budget, arrêt d'urgence et journal des coûts
- `src/telegram/` : bot réservé au propriétaire
- `deploy/INSTALL.md` : installation sur le VPS

Tests : `npm run check` (PostgreSQL local requis, voir `tests/setup-db.ts`).
